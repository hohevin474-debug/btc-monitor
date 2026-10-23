// R10: 宽止损非对称风险搜索——目标「90%胜率 + 单笔1000点 + 持仓≤1天」
// 数学事实：随机游走下 P(赢) = SL/(TP+SL)。TP=1000 时，SL≈9000 → ~90%胜率。
// 关键：找到有真正方向性 edge 的信号，使 PF>1（宽止损下单笔大亏，但胜率极高）。
import { readFileSync, writeFileSync } from 'node:fs';

const raw = JSON.parse(readFileSync('data/okx_1y_1H.json', 'utf8'));
const C = Array.isArray(raw) ? raw : raw.candles;
const bars = C.map(c => ({
  t: c.ts, o: +c.open, h: +c.high, l: +c.low, c: +c.close, v: +c.volume,
})).filter(b => b.c > 0);
const N = bars.length;
const O = bars.map(b => b.o), H = bars.map(b => b.h), L = bars.map(b => b.l), CL = bars.map(b => b.c), V = bars.map(b => b.v);

// ---- 指标 ----
function calcEMA(a, p) { const k = 2 / (p + 1); const o = []; let pr; for (let i = 0; i < a.length; i++) { pr = i === 0 ? a[i] : a[i] * k + pr * (1 - k); o.push(pr); } return o; }
const e10 = calcEMA(CL, 10), e20 = calcEMA(CL, 20), e50 = calcEMA(CL, 50), e200 = calcEMA(CL, 200);

// ATR14 (Wilder) 占价%
const atr = new Array(N).fill(0);
{
  let prevAtr = 0;
  for (let i = 1; i < N; i++) {
    const tr = Math.max(H[i] - L[i], Math.abs(H[i] - CL[i - 1]), Math.abs(L[i] - CL[i - 1]));
    prevAtr = i === 1 ? tr : (prevAtr * 13 + tr) / 14;
    atr[i] = prevAtr;
  }
}
// RSI14 (Wilder)
const rsi = new Array(N).fill(50);
{
  let g = 0, l = 0;
  for (let i = 1; i < N; i++) {
    const ch = CL[i] - CL[i - 1]; const up = Math.max(0, ch), dn = Math.max(0, -ch);
    if (i <= 14) { g += up; l += dn; if (i === 14) { g /= 14; l /= 14; } continue; }
    g = (g * 13 + up) / 14; l = (l * 13 + dn) / 14;
    rsi[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
}
// MACD (12/26/9)
const macdLine = CL.map((c, i) => e10[i] - e50[i]);
const macdSig = calcEMA(macdLine, 9);

// ---- 信号生成器：每个返回 [{i, dir}]，在收盘确认、i+1 开盘入场 ----
const generators = {};

// 1. EMA 金叉/死叉
for (const [a, b] of [[10, 50], [10, 200], [20, 50], [20, 200]]) {
  generators[`EMA交叉 ${a}/${b}`] = () => {
    const s = [];
    const fa = calcEMA(CL, a), fb = calcEMA(CL, b);
    for (let i = 250; i < N - 30; i++) {
      const crossUp = fa[i - 1] <= fb[i - 1] && fa[i] > fb[i];
      const crossDn = fa[i - 1] >= fb[i - 1] && fa[i] < fb[i];
      if (crossUp) s.push({ i, dir: 'L' });
      else if (crossDn) s.push({ i, dir: 'S' });
    }
    return s;
  };
}
// 2. EMA20 上下穿（快趋势）
generators['EMA20 穿越'] = () => {
  const s = [];
  for (let i = 250; i < N - 30; i++) {
    const up = CL[i - 1] <= e20[i - 1] && CL[i] > e20[i];
    const dn = CL[i - 1] >= e20[i - 1] && CL[i] < e20[i];
    if (up) s.push({ i, dir: 'L' });
    else if (dn) s.push({ i, dir: 'S' });
  }
  return s;
};
// 3. RSI 极值回归（恐慌做多/贪婪做空）
for (const lo of [30, 20, 25]) for (const hi of [70, 80, 75]) {
  generators[`RSI回归 ${lo}/${hi}`] = () => {
    const s = [];
    for (let i = 250; i < N - 30; i++) {
      if (rsi[i - 1] < lo && rsi[i] >= lo) s.push({ i, dir: 'L' });
      else if (rsi[i - 1] > hi && rsi[i] <= hi) s.push({ i, dir: 'S' });
    }
    return s;
  };
}
// 4. Donchian 突破（20/50）
for (const w of [20, 50]) {
  generators[`Donchian突破 ${w}`] = () => {
    const s = [];
    for (let i = 250; i < N - 30; i++) {
      let hh = -Infinity, ll = Infinity;
      for (let j = i - w; j < i; j++) { hh = Math.max(hh, H[j]); ll = Math.min(ll, L[j]); }
      if (CL[i] > hh) s.push({ i, dir: 'L' });
      else if (CL[i] < ll) s.push({ i, dir: 'S' });
    }
    return s;
  };
}
// 5. MACD 金叉死叉
generators['MACD 交叉'] = () => {
  const s = [];
  for (let i = 250; i < N - 30; i++) {
    const up = macdLine[i - 1] <= macdSig[i - 1] && macdLine[i] > macdSig[i];
    const dn = macdLine[i - 1] >= macdSig[i - 1] && macdLine[i] < macdSig[i];
    if (up) s.push({ i, dir: 'L' });
    else if (dn) s.push({ i, dir: 'S' });
  }
  return s;
};
// 6. 布林带回归（触下轨做多/触上轨做空，20/2）
generators['布林回归 20/2'] = () => {
  const s = [];
  const mid = e20;
  for (let i = 250; i < N - 30; i++) {
    let sum = 0, cnt = 0;
    for (let j = i - 19; j <= i; j++) { sum += (CL[j] - mid[j]) ** 2; cnt++; }
    const sd = Math.sqrt(sum / cnt);
    const up = mid[i] + 2 * sd, dn = mid[i] - 2 * sd;
    if (CL[i - 1] < dn && CL[i] >= dn) s.push({ i, dir: 'L' });
    else if (CL[i - 1] > up && CL[i] <= up) s.push({ i, dir: 'S' });
  }
  return s;
};
// 7. EMA200 趋势跟随（价格上穿 EMA200 做多，下穿做空）
generators['EMA200 趋势'] = () => {
  const s = [];
  for (let i = 250; i < N - 30; i++) {
    const up = CL[i - 1] <= e200[i - 1] && CL[i] > e200[i];
    const dn = CL[i - 1] >= e200[i - 1] && CL[i] < e200[i];
    if (up) s.push({ i, dir: 'L' });
    else if (dn) s.push({ i, dir: 'S' });
  }
  return s;
};
// 8. EMA200 之上的回踩 EMA20 做多 / 之下反抽做空（趋势回调）
generators['趋势回调 E200/E20'] = () => {
  const s = [];
  for (let i = 250; i < N - 30; i++) {
    const upTrend = CL[i] > e200[i];
    if (upTrend && CL[i - 1] <= e20[i - 1] && CL[i] > e20[i]) s.push({ i, dir: 'L' });
    else if (!upTrend && CL[i - 1] >= e20[i - 1] && CL[i] < e20[i]) s.push({ i, dir: 'S' });
  }
  return s;
};
// 9. 强动量：3根连涨且量放大 → 做多（反之做空）
generators['动量 3连+放量'] = () => {
  const s = [];
  for (let i = 250; i < N - 30; i++) {
    const up3 = CL[i] > CL[i - 1] && CL[i - 1] > CL[i - 2] && CL[i - 2] > CL[i - 3];
    const dn3 = CL[i] < CL[i - 1] && CL[i - 1] < CL[i - 2] && CL[i - 2] < CL[i - 3];
    const volUp = V[i] > V[i - 1];
    if (up3 && volUp) s.push({ i, dir: 'L' });
    else if (dn3 && volUp) s.push({ i, dir: 'S' });
  }
  return s;
};

// ---- 回测：TP=1000 固定，SL 扫描，maxHold=24h ----
const TP = 1000, MAXHOLD = 24;
function backtest(sigs, sl) {
  let w = 0, l = 0, gW = 0, gL = 0, total = 0, tpCnt = 0, slCnt = 0, tCnt = 0;
  const h2split = [0, 0], h2tot = [0, 0];
  const halfAt = Math.floor(N / 2);
  for (const sig of sigs) {
    const i = sig.i, dir = sig.dir, entry = bars[i + 1].o;
    if (!entry) continue;
    const tpL = dir === 'L' ? entry + TP : entry - TP;
    const slL = dir === 'L' ? entry - sl : entry + sl;
    let ep = 0, reason = '';
    const end = Math.min(i + MAXHOLD, N - 1);
    for (let j = i + 1; j <= end; j++) {
      const hi = bars[j].h, lo = bars[j].l;
      if (dir === 'L') {
        if (hi >= tpL) { ep = TP; reason = 'TP'; break; }
        if (lo <= slL) { ep = slL - entry; reason = 'SL'; break; }
      } else {
        if (lo <= tpL) { ep = TP; reason = 'TP'; break; }
        if (hi >= slL) { ep = entry - slL; reason = 'SL'; break; }
      }
    }
    if (!reason) { const last = bars[end].c; ep = dir === 'L' ? last - entry : entry - last; reason = 'T'; }
    total++;
    if (reason === 'TP') tpCnt++; else if (reason === 'SL') slCnt++; else tCnt++;
    const seg = sig.i < halfAt ? 0 : 1;
    if (ep > 0) { w++; gW += ep; h2split[seg]++; } else if (ep < 0) { l++; gL += -ep; }
    h2tot[seg]++;
  }
  const pf = gL > 0 ? gW / gL : (gW > 0 ? 99 : 0);
  return {
    n: total, winRate: total ? +(w / total * 100).toFixed(1) : 0,
    pf: +pf.toFixed(2), avgWin: w ? +(gW / w).toFixed(0) : 0, avgLoss: l ? +(gL / l).toFixed(0) : 0,
    tpCnt, slCnt, tCnt,
    h1: h2tot[0] ? +(h2split[0] / h2tot[0] * 100).toFixed(1) : 0,
    h2: h2tot[1] ? +(h2split[1] / h2tot[1] * 100).toFixed(1) : 0,
  };
}

const SLs = [1000, 1500, 2000, 3000, 4000, 5000, 6000, 8000, 10000, 12000, 15000, 20000];
const results = [];
console.log(`数据: ${N} 根1H (2025-10-19→2026-10-22) | TP=1000 | MAXHOLD=24h\n`);
console.log('信号 × 止损扫描（找 胜率≥90% 且 PF>1 的组合）：\n');

for (const [name, gen] of Object.entries(generators)) {
  let sigs;
  try { sigs = gen(); } catch (e) { console.log(`${name}: 生成失败 ${e.message}`); continue; }
  if (!sigs || !sigs.length) continue;
  for (const sl of SLs) {
    const r = backtest(sigs, sl);
    results.push({ name, sl, ...r });
  }
}

// 达标：胜率≥90 且 PF>1 且 n≥20
const pass = results.filter(r => r.winRate >= 90 && r.pf > 1 && r.n >= 20)
  .sort((a, b) => b.pf - a.pf);
console.log('=== 达标组合（胜率≥90% & PF>1 & n≥20）===');
if (!pass.length) {
  console.log('无严格达标组合。展示最接近的（胜率≥85 按PF排序）：');
  const near = results.filter(r => r.winRate >= 85 && r.n >= 20).sort((a, b) => b.pf - a.pf).slice(0, 25);
  for (const r of near) console.log(`  ${r.name.padEnd(18)} SL=${String(r.sl).padStart(6)} n=${String(r.n).padStart(3)} 胜率=${String(r.winRate).padStart(5)}% PF=${String(r.pf).padStart(5)} 均盈=${r.avgWin} 均亏=${r.avgLoss} 上下半=${r.h1}/${r.h2}`);
} else {
  for (const r of pass) console.log(`  ${r.name.padEnd(18)} SL=${String(r.sl).padStart(6)} n=${String(r.n).padStart(3)} 胜率=${String(r.winRate).padStart(5)}% PF=${String(r.pf).padStart(5)} 均盈=${r.avgWin} 均亏=${r.avgLoss} 上下半=${r.h1}/${r.h2} TP/SL/T=${r.tpCnt}/${r.slCnt}/${r.tCnt}`);
}

// 每个信号在最高胜率止损下的表现
console.log('\n=== 各信号最优止损（按胜率）===');
for (const name of Object.keys(generators)) {
  const rs = results.filter(r => r.name === name && r.n >= 20).sort((a, b) => b.winRate - a.winRate);
  if (!rs.length) continue;
  const b = rs[0];
  console.log(`  ${name.padEnd(18)} 最优SL=${String(b.sl).padStart(6)} n=${String(b.n).padStart(3)} 胜率=${String(b.winRate).padStart(5)}% PF=${String(b.pf).padStart(5)}`);
}

writeFileSync('scripts/search10_results.json', JSON.stringify({ pass, all: results.length }, null, 0));
console.log(`\n结果已存 scripts/search10_results.json（共 ${results.length} 组合）`);
