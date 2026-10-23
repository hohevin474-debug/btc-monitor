// 部署版忠实复算：口径 = 原搜索脚本（search17/18/19）
// - 信号检测：1H 收盘 bar i（RSI[i-1]<42≤RSI[i] 或 RSI[i-1]>58≥RSSI[i]）
// - 4H 趋势：当根4H（最后一条 ts<=TS[i] 的4H，含未收盘），近6根(24h)斜率 ≥0.3%
// - 入场：bars[i+1].o（下一根开盘价，诚实无前视）
// - 出场：TP=1000 / SL=3000 / 48h 到期收盘价，触达判定用 high/low
// - 非重叠：持仓期间禁止新开仓（与线上 worker 一致）
// - 门控全部复刻 analyzeDv：ATR%∈[0.3,2.0] + 1H 价<EMA20(多)/价>EMA20(空)
import { readFileSync } from 'fs';

const h1 = JSON.parse(readFileSync('/workspace/btc-cloudflare/data/okx_2y_1H.json', 'utf8'));
const h4 = JSON.parse(readFileSync('/workspace/btc-cloudflare/data/okx_2y_4H.json', 'utf8'));
const C1 = h1.candles, C4 = h4.candles;
const bars = C1.map(c => ({ ts: c.ts, o: +c.open, h: +c.high, l: +c.low, c: +c.close })).filter(b => b.c > 0);
const b4 = C4.map(c => ({ ts: c.ts, c: +c.close })).filter(b => b.c > 0);

const N = bars.length, H = bars.map(b => b.h), L = bars.map(b => b.l), CL = bars.map(b => b.c), TS = bars.map(b => b.ts);
const TP = 1000, SL = 3000, MH = 48;
const RSI_LO = 42, RSI_HI = 58, ATR_MIN = 0.3, ATR_MAX = 2.0, SLOPE_MIN = 0.3, EMA_P = 20;

// Wilder RSI(14)
const rsi1 = new Array(N).fill(50);
{ let g = 0, l = 0;
  for (let i = 1; i < N; i++) {
    const ch = CL[i] - CL[i - 1]; const u = Math.max(0, ch), d = Math.max(0, -ch);
    if (i <= 14) { g += u; l += d; if (i === 14) { g /= 14; l /= 14; } continue; }
    g = (g * 13 + u) / 14; l = (l * 13 + d) / 14;
    rsi1[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  } }

// Wilder ATR(14) %
const atrP = new Array(N).fill(0);
{ let p = 0;
  for (let i = 1; i < N; i++) {
    const t = Math.max(H[i] - L[i], Math.abs(H[i] - CL[i - 1]), Math.abs(L[i] - CL[i - 1]));
    p = i === 1 ? t : (p * 13 + t) / 14;
    atrP[i] = p / CL[i] * 100;
  } }

// 1H EMA20
function calcEMAarr(a, p) { const k = 2 / (p + 1); const o = []; let pr; for (let i = 0; i < a.length; i++) { pr = i === 0 ? a[i] : a[i] * k + pr * (1 - k); o.push(pr); } return o; }
const e20_1 = calcEMAarr(CL, EMA_P);

// 4H 斜率：当根4H（含未收盘），近6根=24h
const t4slope = new Array(N).fill(NaN);
{ let k = 0;
  for (let i = 0; i < N; i++) {
    while (k + 1 < b4.length && b4[k + 1].ts <= TS[i]) k++;
    if (k >= 12) t4slope[i] = (b4[k].c - b4[k - 6].c) / b4[k - 6].c * 100;
  } }

// 生成全部信号（未做非重叠）
const sigs = [];
for (let i = 260; i < N - 50; i++) {
  if (atrP[i] < ATR_MIN || atrP[i] > ATR_MAX || isNaN(t4slope[i])) continue;
  let dir = null;
  if (rsi1[i - 1] < RSI_LO && rsi1[i] >= RSI_LO) dir = 'L';
  else if (rsi1[i - 1] > RSI_HI && rsi1[i] <= RSI_HI) dir = 'S';
  if (!dir) continue;
  // 4H 趋势同向
  if (dir === 'L' && t4slope[i] < SLOPE_MIN) continue;
  if (dir === 'S' && t4slope[i] > -SLOPE_MIN) continue;
  // 1H 真回调
  if (dir === 'L' && CL[i] > e20_1[i]) continue;
  if (dir === 'S' && CL[i] < e20_1[i]) continue;
  sigs.push({ i, dir });
}
console.log(`信号总数(未去重叠): ${sigs.length}`);

// 回测函数：nonOverlap=true 时持仓期间屏蔽新信号（与线上一致）
function bt(sigs, { nonOverlap = true } = {}) {
  let w = 0, l = 0, gW = 0, gL = 0, total = 0, tpc = 0, maxLoss = 0;
  let busyUntil = -1; // 持仓占用到的 bar 索引
  const trades = [];
  for (const sig of sigs) {
    if (nonOverlap && sig.i <= busyUntil) continue;
    const i = sig.i, dir = sig.dir, entry = bars[i + 1].o;
    const tpL = dir === 'L' ? entry + TP : entry - TP, slL = dir === 'L' ? entry - SL : entry + SL;
    let ep = 0, rs = ''; const end = Math.min(i + MH, N - 1);
    for (let j = i + 1; j <= end; j++) {
      const hi = bars[j].h, lo = bars[j].l;
      if (dir === 'L') { if (hi >= tpL) { ep = TP; rs = 'TP'; break; } if (lo <= slL) { ep = slL - entry; rs = 'SL'; break; } }
      else { if (lo <= tpL) { ep = TP; rs = 'TP'; break; } if (hi >= slL) { ep = entry - slL; rs = 'SL'; break; } }
    }
    if (!rs) { const last = bars[end].c; ep = dir === 'L' ? last - entry : entry - last; rs = 'TIME'; }
    total++; if (rs === 'TP') tpc++;
    if (ep > 0) { w++; gW += ep; } else { l++; gL += -ep; maxLoss = Math.max(maxLoss, -ep); }
    trades.push({ i, dir, entry, ep, rs });
    if (nonOverlap) busyUntil = end; // 占用到持仓结束
  }
  const pf = gL > 0 ? gW / gL : (gW > 0 ? 99 : 0);
  return { n: total, strict: +(tpc / total * 100).toFixed(1), winRate: +(w / total * 100).toFixed(1), pf: +pf.toFixed(2), maxLoss: +maxLoss.toFixed(0), trades };
}

for (const mode of [{ nonOverlap: true }, { nonOverlap: false }]) {
  const r = bt(sigs, mode);
  console.log(`\n===== ${mode.nonOverlap ? '非重叠(与线上一致)' : '允许重叠(原搜索口径)'} =====`);
  console.log(`信号数        : ${r.n}`);
  console.log(`严格命中率    : ${r.strict}%  (真打到 TP 1000 点)`);
  console.log(`宽松盈利离场率: ${r.winRate}%`);
  console.log(`盈亏比 PF     : ${r.pf}`);
  console.log(`最大单笔亏损  : ${r.maxLoss} 点`);
  const net = r.trades.reduce((a, t) => a + t.ep, 0) - r.n * 120;
  console.log(`扣费后净盈亏  : ${net.toFixed(0)} 点 (万6×2=120点/笔)`);
  // 年度
  for (const yr of [2025, 2026]) {
    const arr = r.trades.filter(t => new Date(TS[t.i]).getFullYear() === yr);
    if (!arr.length) continue;
    const t = arr.filter(x => x.rs === 'TP').length;
    console.log(`  ${yr}: n=${arr.length} 严格 ${(t / arr.length * 100).toFixed(1)}%`);
  }
  // 走步
  const split = Math.floor(N * 0.7);
  const tr = r.trades.filter(t => t.i < split), te = r.trades.filter(t => t.i >= split);
  const trT = tr.filter(x => x.rs === 'TP').length, teT = te.filter(x => x.rs === 'TP').length;
  console.log(`  走步: 训练 ${(trT / Math.max(1, tr.length) * 100).toFixed(1)}% (n=${tr.length})  测试 ${(teT / Math.max(1, te.length) * 100).toFixed(1)}% (n=${te.length})`);
}
