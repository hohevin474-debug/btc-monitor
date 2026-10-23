#!/usr/bin/env node
/** 第九轮：打磨 D-vstate —— 用与线上部署完全一致的信号逻辑重建回放台，
 *  然后测试各类入口过滤器 / 止损宽度，目标在保持 TP=1000 / ≤24h 前提下抬升胜率。
 *  用法: node scripts/search9_refine_dv.mjs [datafile]
 */
import { readFileSync, writeFileSync } from 'node:fs';
const path = process.argv[2] || 'data/okx_1y_1H.json';
const raw = JSON.parse(readFileSync(path, 'utf8'));
const C = Array.isArray(raw) ? raw : raw.candles;
const bars = C.map(c => ({ t: c.ts ?? c.t, o: +(c.open ?? c.o), h: +(c.high ?? c.h), l: +(c.low ?? c.l), c: +(c.close ?? c.c), v: +(c.volume ?? c.vol) })).filter(b => b.c > 0);
const N = bars.length;
const closes = bars.map(b => b.c), highs = bars.map(b => b.h), lows = bars.map(b => b.l), vols = bars.map(b => b.v);

// ---- 与 search8 验证出 72.4%/PF3.28 完全一致的量价方法 ----
// 关键：波动序列用 sma(TrueRange, 24)（不是部署里误用的 ATR14 占价%）
function calcEMA(arr, p) { const k = 2 / (p + 1); const o = new Array(arr.length); let pr; for (let i = 0; i < arr.length; i++) { pr = i === 0 ? arr[i] : arr[i] * k + pr * (1 - k); o[i] = pr; } return o; }
const e20 = calcEMA(closes, 20), e50 = calcEMA(closes, 50);

// 单根 TrueRange → 24 根 SMA（与 search8 atrS 一致）
const tr = new Array(N).fill(0);
for (let i = 1; i < N; i++) tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
const atrS = new Array(N).fill(NaN);
let s = 0;
for (let i = 0; i < N; i++) { s += tr[i]; if (i >= 24) s -= tr[i - 24]; if (i >= 23) atrS[i] = s / 24; }

// pctRank：窗口 120，排除当前根（与 search8 pctRank 一致）
const WIN = 120;
function pctRank(k) {
  if (isNaN(atrS[k])) return 0.5;
  const v = atrS[k]; let c = 0, n = 0;
  for (let j = Math.max(0, k - WIN); j < k; j++) { if (isNaN(atrS[j])) continue; n++; if (atrS[j] <= v) c++; }
  return n ? c / n : 0.5;
}
// RSI(14)
function rsi(period) {
  const o = new Array(N).fill(50); let g = 0, l = 0;
  for (let i = 1; i < N; i++) {
    const ch = closes[i] - closes[i - 1];
    const up = Math.max(0, ch), dn = Math.max(0, -ch);
    if (i <= period) { g += up; l += dn; if (i === period) { g /= period; l /= period; } continue; }
    g = (g * (period - 1) + up) / period; l = (l * (period - 1) + dn) / period;
    o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return o;
}
const rsi14 = rsi(14);

// ---- 信号生成（与 search8 验证一致）----
const DV = { atrWindow: 120, lookback: 12, hiPctile: 0.9, loPctile: 0.3, emaPeriod: 20 };
function dvSignal(i) {
  if (isNaN(atrS[i])) return null;
  const rNow = pctRank(i), rPrev = pctRank(i - DV.lookback);
  if (!(rPrev >= DV.hiPctile && rNow <= DV.loPctile)) return null;
  const dir = closes[i] < e20[i] ? 'L' : 'S';
  return { dir, rNow, rPrev, atrPct: atrS[i], rsi: rsi14[i], e50slope: (e50[i] - e50[i - 20]) / e50[i - 20] * 100 };
}

// ---- 回测（与部署一致：TP=1000/SL/≤24h，下一根开盘入场）----
function backtest(sigFilter, { tpPts = 1000, slPts = 800, maxHold = 24, label = '' }) {
  let wins = 0, losses = 0, total = 0, gW = 0, gL = 0, sumPts = 0;
  const losers = [], winners = [];
  for (let i = 260; i < N - maxHold - 1; i++) {
    const base = dvSignal(i); if (!base) continue;
    if (sigFilter && !sigFilter(base, i)) continue;
    const dir = base.dir, entry = bars[i + 1].o;
    let stop = dir === 'L' ? entry - slPts : entry + slPts;
    let target = dir === 'L' ? entry + tpPts : entry - tpPts;
    let ep = 0, reason = '';
    for (let j = i + 1; j <= i + maxHold && j < N; j++) {
      const hi = highs[j], lo = lows[j];
      if (dir === 'L') { if (hi >= target) { ep = tpPts; reason = 'TP'; break; } if (lo <= stop) { ep = stop - entry; reason = 'SL'; break; } }
      else { if (lo <= target) { ep = tpPts; reason = 'TP'; break; } if (hi >= stop) { ep = entry - stop; reason = 'SL'; break; } }
    }
    if (!reason) { const last = bars[Math.min(i + maxHold, N - 1)].c; ep = dir === 'L' ? last - entry : entry - last; reason = 'EXP'; }
    total++;
    const rec = { entry, ep, reason, ...base, idx: i };
    if (ep > 0) { wins++; gW += ep; sumPts += ep; winners.push(rec); }
    else if (ep < 0) { losses++; gL += -ep; sumPts += ep; losers.push(rec); }
  }
  const pf = gL > 0 ? gW / gL : (gW > 0 ? 99 : 0);
  const wr = total ? wins / total * 100 : 0;
  return { label, n: total, winRate: +wr.toFixed(1), avg: +((total ? sumPts / total : 0)).toFixed(0), pf: +pf.toFixed(2), losers, winners };
}

function halfSplit(r) {
  const mid = Math.floor(r.n / 2);
  const a = r.losers.concat(r.winners).sort((x, y) => x.idx - y.idx);
  const f = a.slice(0, mid), s = a.slice(mid);
  const wf = f.filter(x => x.ep > 0).length, ws = s.filter(x => x.ep > 0).length;
  return { h1: (wf / f.length * 100).toFixed(1), h2: (ws / s.length * 100).toFixed(1) };
}

console.log(`数据: ${N} 根 1H | 与部署一致逻辑(ATR14/pctRank120/lookback12/EMA20)\n`);

// 基线
const base = backtest(null, { slPts: 800, label: '基线 SL800' });
console.log(`【基线】 n=${base.n} 胜率=${base.winRate}% 均盈利=${base.avg} PF=${base.pf} | 上下半=${JSON.stringify(halfSplit(base))}`);
console.log(`  亏损单(${base.losers.length})原因:`, base.losers.reduce((m, x) => (m[x.reason] = (m[x.reason] || 0) + 1, m), {}));

// 止损宽度扫描
console.log('\n=== 止损宽度扫描 (TP=1000, ≤24h) ===');
for (const sl of [600, 800, 1000, 1200, 1500, 2000]) {
  const r = backtest(null, { slPts: sl, label: `SL${sl}` });
  const hs = halfSplit(r);
  console.log(`SL=${sl}: n=${r.n} 胜率=${r.winRate}% 均盈利=${r.avg} PF=${r.pf} | 上下半=${hs.h1}/${hs.h2}`);
}

// 过滤器扫描
console.log('\n=== 入口过滤器 (TP=1000/SL800/≤24h) ===');
const filters = [
  ['无过滤(基线)', null],
  ['RSI∈[35,65]', (b) => b.rsi >= 35 && b.rsi <= 65],
  ['RSI∈[30,70]', (b) => b.rsi >= 30 && b.rsi <= 70],
  ['EMA50斜率|≤0.8%|', (b) => Math.abs(b.e50slope) <= 0.8],
  ['EMA50斜率|≤1.5%|', (b) => Math.abs(b.e50slope) <= 1.5],
  ['RSI∈[35,65]+斜率≤0.8%', (b) => b.rsi >= 35 && b.rsi <= 65 && Math.abs(b.e50slope) <= 0.8],
  ['当前atrPct为窗口最低', (b, i) => { // 局部极小值：当前是近 24 根里最低的
    let mn = Infinity; for (let k = i - 23; k <= i; k++) if (!isNaN(atrS[k])) mn = Math.min(mn, atrS[k]);
    return atrS[i] <= mn + 1e-9;
  }],
  ['RSI∈[35,65]+局部最低', (b, i) => {
    if (!(b.rsi >= 35 && b.rsi <= 65)) return false;
    let mn = Infinity; for (let k = i - 23; k <= i; k++) if (!isNaN(atrS[k])) mn = Math.min(mn, atrS[k]);
    return atrS[i] <= mn + 1e-9;
  }],
];
for (const [name, f] of filters) {
  const r = backtest(f, { slPts: 800, label: name });
  const hs = halfSplit(r);
  console.log(`${name}: n=${r.n} 胜率=${r.winRate}% 均盈利=${r.avg} PF=${r.pf} | 上下半=${hs.h1}/${hs.h2}`);
}

// 最优过滤组合 + 止损联合（精选）
console.log('\n=== 精选联合调优 ===');
const combos = [
  ['RSI∈[35,65]+SL1000', (b) => b.rsi >= 35 && b.rsi <= 65, 1000],
  ['RSI∈[30,70]+SL1000', (b) => b.rsi >= 30 && b.rsi <= 70, 1000],
  ['斜率≤0.8%+SL1000', (b) => Math.abs(b.e50slope) <= 0.8, 1000],
  ['RSI∈[35,65]+斜率≤0.8%+SL1000', (b) => b.rsi >= 35 && b.rsi <= 65 && Math.abs(b.e50slope) <= 0.8, 1000],
  ['RSI∈[35,65]+局部最低+SL1000', (b, i) => { if (!(b.rsi >= 35 && b.rsi <= 65)) return false; let mn = Infinity; for (let k = i - 23; k <= i; k++) if (!isNaN(atrS[k])) mn = Math.min(mn, atrS[k]); return atrS[i] <= mn + 1e-9; }, 1000],
  ['RSI∈[35,65]+斜率≤0.8%+SL1200', (b) => b.rsi >= 35 && b.rsi <= 65 && Math.abs(b.e50slope) <= 0.8, 1200],
];
for (const [name, f, sl] of combos) {
  const r = backtest(f, { slPts: sl, label: name });
  const hs = halfSplit(r);
  console.log(`${name}: n=${r.n} 胜率=${r.winRate}% 均盈利=${r.avg} PF=${r.pf} | 上下半=${hs.h1}/${hs.h2}`);
}

const out = { base, note: '与部署 analyzeDv 同逻辑重建' };
writeFileSync('scripts/search9_results.json', JSON.stringify(out, null, 0));
console.log('\n已写 scripts/search9_results.json');

// ---- 细粒度斜率扫描（确认 0.8% 非过拟合）----
console.log('\n=== 细粒度 EMA50 斜率门控 (TP=1000/SL800/≤24h) ===');
for (const thr of [0.4,0.6,0.8,1.0,1.2,1.5,2.0]) {
  const r = backtest((b)=>Math.abs(b.e50slope)<=thr, {slPts:800,label:`slope≤${thr}%`});
  const hs = halfSplit(r);
  console.log(`斜率≤${thr}%: n=${r.n} 胜率=${r.winRate}% 均盈利=${r.avg} PF=${r.pf} | 上下半=${hs.h1}/${hs.h2}`);
}
