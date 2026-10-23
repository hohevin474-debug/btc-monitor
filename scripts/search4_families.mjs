#!/usr/bin/env node
/**
 * 第四轮搜索：全新方法论家族（非单K线极值变体）
 *   A. 极值行情后回归 fadeExtreme        —— 大跌/大涨后必回撤，专吃回归
 *   B. 多周期顺势回踩 htfPullback         —— HTF(≈2D)定方向，LTF回踩均线顺势进
 *   C. 量能突破 volBreakout              —— 放量突破近期高低
 *   D. 多条件共振 resonance               —— RSI极值+布林+HTF方向+量能
 * 退出：固定止盈 tpPts / 固定止损 slPts / 最久持有 maxHold 根(1H)
 * 目标靶心：胜率≥90% 且 单笔盈利≥1000点 且 持仓≤24h
 */
import { readFileSync, writeFileSync } from 'node:fs';

const path = process.argv[2] || 'data/okx_60d.json';
const MIN_N = 20;
const raw = JSON.parse(readFileSync(path, 'utf8'));
// 兼容 {meta,candles} 与 [...] 两种格式
const C = Array.isArray(raw) ? raw : raw.candles;
const bars = C.map((c, i) => ({
  t: c.ts ?? c.t,
  o: +(c.open ?? c.o), h: +(c.high ?? c.h), l: +(c.low ?? c.l),
  c: +(c.close ?? c.c), v: +(c.volume ?? c.vol),
})).filter(b => b.c > 0);
console.log(`载入 ${bars.length} 根 1H K线 | ${new Date(bars[0].t).toISOString().slice(0,10)} → ${new Date(bars[bars.length-1].t).toISOString().slice(0,10)}`);

// ---------- 通用指标 ----------
const sma = (arr, p) => { const out = []; let s = 0; for (let i = 0; i < arr.length; i++) { s += arr[i]; if (i >= p) s -= arr[i - p]; out.push(i >= p - 1 ? s / p : NaN); } return out; };
const ema = (arr, p) => { const out = []; const k = 2 / (p + 1); let prev; for (let i = 0; i < arr.length; i++) { prev = i === 0 ? arr[i] : arr[i] * k + prev * (1 - k); out.push(prev); } return out; };
const closes = bars.map(b => b.c);
const C48 = ema(closes, 48);   // ≈2天 HTF 趋势代理
const C12 = ema(closes, 12);
const C200 = ema(closes, 200);
const rsi = (() => { const out = [50]; for (let i = 1; i < closes.length; i++) { const d = closes[i] - closes[i-1]; let g = Math.max(0, d), l = Math.max(0, -d); for (let j = Math.max(1, i - 13); j <= i; j++) { const dd = closes[j]-closes[j-1]; g += Math.max(0,dd); l += Math.max(0,-dd);} const rs = (g/14)/(l/14 || 1e-9); out.push(100 - 100/(1+rs)); } return out; })();
const std = (arr, p) => { const m = sma(arr, p); const out = []; for (let i = 0; i < arr.length; i++) { if (i < p-1) { out.push(NaN); continue; } let s = 0; for (let j = i-p+1; j <= i; j++) s += (arr[j]-m[i])**2; out.push(Math.sqrt(s/p)); } return out; };
const SD20 = std(closes, 20);

// ---------- 通用回测 ----------
function backtest(signalFn, { tpPts, slPts, maxHold = 24, be = 0, trail = 0 }) {
  let wins = 0, losses = 0, scratches = 0, total = 0, sumPts = 0, sumWin = 0, sumLoss = 0, big = 0, grossW = 0, grossL = 0;
  const tradeList = [];
  for (let i = 250; i < bars.length - maxHold - 1; i++) {
    const sig = signalFn(i);
    if (!sig) continue;
    const dir = sig.dir; // 'L' | 'S'
    const entry = bars[i + 1].o;
    const sl = sig.stopPts != null ? sig.stopPts : slPts;
    let stop = dir === 'L' ? entry - sl : entry + sl;
    let target = dir === 'L' ? entry + tpPts : entry - tpPts;
    let beTrig = be > 0 ? (dir === 'L' ? entry + be : entry - be) : Infinity;
    let trailTrig = trail > 0 ? (dir === 'L' ? entry + trail : entry - trail) : -Infinity;
    let exitPts = 0, exitReason = '', mfe = 0, mae = 0, best = entry;
    for (let j = i + 1; j <= i + maxHold && j < bars.length; j++) {
      const hi = bars[j].h, lo = bars[j].l;
      const fav = dir === 'L' ? hi - entry : entry - lo;
      const unf = dir === 'L' ? entry - lo : hi - entry;
      if (fav > mfe) mfe = fav; if (unf > mae) mae = unf;
      // 奔跑轨：盈利达 trail 后，止损跟随最高/低价移动
      if (trail > 0) {
        if (dir === 'L') { if (hi > best) best = hi; stop = Math.max(stop, best - trail); }
        else { if (lo < best) best = lo; stop = Math.min(stop, best + trail); }
      }
      // 保本
      if (be > 0) { if (dir === 'L' && hi >= beTrig) stop = Math.max(stop, entry); if (dir === 'S' && lo <= beTrig) stop = Math.min(stop, entry); }
      if (dir === 'L') { if (hi >= target) { exitPts = tpPts; exitReason = 'TP'; break; } if (lo <= stop) { exitPts = stop - entry; exitReason = 'SL'; break; } }
      else { if (lo <= target) { exitPts = tpPts; exitReason = 'TP'; break; } if (hi >= stop) { exitPts = entry - stop; exitReason = 'SL'; break; } }
    }
    if (!exitReason) { // 持有到期
      const last = bars[Math.min(i + maxHold, bars.length - 1)].c;
      exitPts = dir === 'L' ? last - entry : entry - last; exitReason = 'EXP';
    }
    total++;
    if (exitPts > 0) { wins++; sumWin += exitPts; grossW += exitPts; if (exitPts >= 1000) big++; }
    else if (exitPts === 0) { scratches++; }
    else { losses++; sumLoss += -exitPts; grossL += -exitPts; }
    sumPts += exitPts;
    tradeList.push({ i, dir, entry: Math.round(entry), pts: Math.round(exitPts), reason: exitReason, mfe: Math.round(mfe) });
  }
  const pf = grossL > 0 ? grossW / grossL : (grossW > 0 ? 99 : 0);
  return { n: total, winRate: total ? (wins / total) * 100 : 0, avg: total ? sumPts / total : 0, avgWin: wins ? sumWin / wins : 0, avgLoss: losses ? sumLoss / losses : 0, bigPct: total ? (big / total) * 100 : 0, pf, grossW, grossL };
}

// ---------- 信号族 ----------
// A. 极值行情后回归：回望 lookback 根，若累计跌幅≥thr 则做多(吃反弹)，涨幅≥thr 做空
const fadeExtreme = (i, { lookback, thr, slPct, tpPts, maxHold }) => {
  const a = i - lookback, b = i; if (a < 0) return null;
  const move = bars[b].c - bars[a].c;
  // 找窗口极值
  let lo = Infinity, hi = -Infinity; for (let k = a; k <= b; k++) { lo = Math.min(lo, bars[k].l); hi = Math.max(hi, bars[k].h); }
  const entry0 = bars[i + 1].o;
  if (move <= -thr) { const stopPx = lo - 100; let sl = entry0 - stopPx; if (sl < 300) sl = 300; return { dir: 'L', stopPts: sl }; }
  if (move >= thr) { const stopPx = hi + 100; let sl = stopPx - entry0; if (sl < 300) sl = 300; return { dir: 'S', stopPts: sl }; }
  return null;
};
// B. HTF顺势回踩：HTF(ema48)向上且价格回踩ema12下方/RSI偏低→做多；反向做空
const htfPullback = (i, { rsiMax, tpPts, slPts, maxHold }) => {
  const up = C48[i] > C200[i] && bars[i].c > C48[i] * 0.997;
  const dn = C48[i] < C200[i] && bars[i].c < C48[i] * 1.003;
  const pulled = bars[i].c < C12[i];
  const rsiL = rsi[i] < rsiMax, rsiH = rsi[i] > 100 - rsiMax;
  if (up && pulled && rsiL) return { dir: 'L' };
  if (dn && !pulled && rsiH) return { dir: 'S' };
  return null;
};
// C. 量能突破：放量突破 N 根最高/最低
const volBreakout = (i, { N, volMult, tpPts, slPts, maxHold }) => {
  if (i < N) return null;
  let mx = -Infinity, mn = Infinity, vs = 0; for (let k = i - N; k < i; k++) { mx = Math.max(mx, bars[k].h); mn = Math.min(mn, bars[k].l); vs += bars[k].v; }
  const avgV = vs / N;
  if (bars[i].c > mx && bars[i].v > volMult * avgV) return { dir: 'L' };
  if (bars[i].c < mn && bars[i].v > volMult * avgV) return { dir: 'S' };
  return null;
};
// D. 共振：RSI极值 + 布林外 + HTF同向 + 量能放大
const resonance = (i, { rsiThr, tpPts, slPts, maxHold }) => {
  const upTrend = C48[i] > C200[i];
  const dnTrend = C48[i] < C200[i];
  const band = SD20[i] * 2;
  const loBand = C20mid(i) - band, hiBand = C20mid(i) + band;
  if (rsi[i] < rsiThr && bars[i].c < loBand && upTrend) return { dir: 'L' };
  if (rsi[i] > 100 - rsiThr && bars[i].c > hiBand && dnTrend) return { dir: 'S' };
  return null;
};
const C20mid = (i) => sma(closes, 20)[i];

// ---------- 网格搜索 ----------
const results = [];
function pushRes(tag, opt, r) { if (r.n >= MIN_N) results.push({ tag, ...opt, ...r }); }

// A: fade extreme
for (const lookback of [12, 24, 48, 96]) // 0.5d/1d/2d/4d 窗口
  for (const thr of [1500, 2000, 2500, 3000, 4000]) // 窗口累计波动阈值(点)
    for (const slPct of [0.5, 0.8, 1.0])
      for (const tpPts of [1000, 1200, 1500])
        for (const maxHold of [24, 48, 72]) {
          const r = backtest((i) => fadeExtreme(i, { lookback, thr, slPct, tpPts, maxHold }), { tpPts, slPts: 0, maxHold });
          pushRes('A-fade', { lookback, thr, slPct, tpPts, maxHold }, r);
        }

// B: htf pullback
for (const rsiMax of [40, 45, 50])
  for (const tpPts of [1000, 1200, 1500])
    for (const slPts of [500, 700, 1000])
      for (const maxHold of [24, 48]) {
        const r = backtest((i) => htfPullback(i, { rsiMax, tpPts, slPts, maxHold }), { tpPts, slPts, maxHold });
        pushRes('B-htf', { rsiMax, tpPts, slPts, maxHold }, r);
      }

// C: vol breakout
for (const N of [12, 24, 48])
  for (const volMult of [1.5, 2.0, 2.5])
    for (const tpPts of [1000, 1500, 2000])
      for (const slPts of [500, 800])
        for (const maxHold of [24, 48]) {
          const r = backtest((i) => volBreakout(i, { N, volMult, tpPts, slPts, maxHold }), { tpPts, slPts, maxHold });
          pushRes('C-vol', { N, volMult, tpPts, slPts, maxHold }, r);
        }

// D: resonance
for (const rsiThr of [25, 30, 35])
  for (const tpPts of [1000, 1500])
    for (const slPts of [500, 800])
      for (const maxHold of [24, 48]) {
        const r = backtest((i) => resonance(i, { rsiThr, tpPts, slPts, maxHold }), { tpPts, slPts, maxHold });
        pushRes('D-reso', { rsiThr, tpPts, slPts, maxHold }, r);
      }

// ---------- 汇总 ----------
console.log(`\n全部方案数(≥${MIN_N}笔): ${results.length}`);
const byWin = [...results].sort((a, b) => b.winRate - a.winRate);
const byPf = [...results].sort((a, b) => b.pf - a.pf);
console.log('\n=== 胜率 TOP15 ===');
console.log('tag | n | 胜率% | 均盈利 | 均赢 | 均亏 | big1000% | PF');
for (const r of byWin.slice(0, 15)) console.log(`${r.tag} | ${r.n} | ${r.winRate.toFixed(1)} | ${r.avg.toFixed(0)} | ${r.avgWin.toFixed(0)} | ${r.avgLoss.toFixed(0)} | ${r.bigPct.toFixed(1)} | ${r.pf.toFixed(2)}`);
console.log('\n=== PF TOP10 ===');
for (const r of byPf.slice(0, 10)) console.log(`${r.tag} | n=${r.n} | 胜率=${r.winRate.toFixed(1)}% | 均盈利=${r.avg.toFixed(0)} | PF=${r.pf.toFixed(2)} | big1000%=${r.bigPct.toFixed(1)}`);

const hit = results.filter(r => r.winRate >= 90 && r.bigPct >= 50);
console.log(`\n*** 达标(胜率≥90% 且 big1000%≥50): ${hit.length} 个 ***`);
for (const r of hit.slice(0, 10)) console.log(JSON.stringify(r));

// 输出 JSON 供存档
writeFileSync('scripts/search4_results.json', JSON.stringify({ total: results.length, byWin: byWin.slice(0, 30), byPf: byPf.slice(0, 20) }, null, 0));
console.log('\n已写入 scripts/search4_results.json');
