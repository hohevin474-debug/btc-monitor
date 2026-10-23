// 第二轮：移动止损(trailing) + 极端共振入场。
// 思路：极严入场(提高胜率) + 盈利后启动 trailing(让赢家跑出 1000+ 大波，而非固定止盈锁死胜率)。
// 目标：在"单笔盈利 1000 点+"前提下尽量抬高胜率。
import fs from 'fs';
import { calcRSI, calcBB, sma, calcATR } from './replay_lib.mjs';

const raw = JSON.parse(fs.readFileSync(new URL('../data/okx_60d.json', import.meta.url), 'utf8'));
const bars = raw.map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, vol: b.vol }));
const N = bars.length;
const closes = bars.map(b => b.c);

function replayTrailing(signalFn, { slPts = 300, activate = 300, trailDist = 400, holdH = 24, warmup = 200 } = {}) {
  const trades = []; let pos = null;
  for (let i = warmup; i < N; i++) {
    const bar = bars[i]; const prices = closes.slice(0, i + 1);
    if (pos) {
      const isLong = pos.dir === 'LONG';
      const hi = bar.h, lo = bar.l, cl = bar.c;
      if (isLong) pos.best = Math.max(pos.best, hi); else pos.best = Math.min(pos.best, lo);
      const ep = isLong ? pos.best - pos.entry : pos.entry - pos.best;
      if (ep >= activate) {
        const newStop = isLong ? pos.best - trailDist : pos.best + trailDist;
        if (isLong) pos.stop = Math.max(pos.stop, newStop); else pos.stop = Math.min(pos.stop, newStop);
      }
      let exit = null;
      if (isLong && lo <= pos.stop) exit = { px: Math.max(lo, pos.stop), kind: 'SL' };
      else if (!isLong && hi >= pos.stop) exit = { px: Math.min(hi, pos.stop), kind: 'SL' };
      const held = (bar.t / 1000) - pos.entryTime;
      if (!exit && held >= holdH * 3600) exit = { px: cl, kind: 'EXP' };
      if (exit) { const pnl = Math.round(isLong ? exit.px - pos.entry : pos.entry - exit.px); trades.push({ dir: pos.dir, pnl, kind: exit.kind }); pos = null; }
    }
    if (!pos && i >= warmup) {
      const sig = signalFn(bar, i, prices);
      if (sig && sig !== 'WAIT') {
        const isLong = sig === 'LONG';
        pos = { dir: sig, entry: bar.c, entryTime: bar.t / 1000, stop: isLong ? bar.c - slPts : bar.c + slPts, best: bar.c };
      }
    }
  }
  return trades;
}

function stats(trades) {
  const n = trades.length; if (!n) return null;
  const wins = trades.filter(t => t.pnl > 0); const losses = trades.filter(t => t.pnl <= 0);
  const total = trades.reduce((a, t) => a + t.pnl, 0);
  const avgWin = wins.length ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, t) => a + t.pnl, 0) / losses.length : 0;
  const gw = wins.reduce((a, t) => a + t.pnl, 0); const gl = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const pf = gl > 0 ? gw / gl : 999;
  const big = trades.filter(t => t.pnl >= 1000).length;
  return { n, winRate: +(wins.length / n * 100).toFixed(1), total, avgWin: Math.round(avgWin), avgLoss: Math.round(avgLoss), pf: +Math.min(pf, 999).toFixed(2), bigPct: +(big / n * 100).toFixed(1) };
}

// ---- 信号（越严=胜率潜力越高）----
function rsiExt(lo, hi) { return (b, i, p) => { const r = calcRSI(p, 14); return r < lo ? 'LONG' : r > hi ? 'SHORT' : 'WAIT'; }; }
function rsiBbExt(lo, hi, m) { return (b, i, p) => { const r = calcRSI(p, 14); const bb = calcBB(p, 20); const dn = r < lo || b.c < bb.lower * m; const up = r > hi || b.c > bb.upper * m; return dn ? 'LONG' : up ? 'SHORT' : 'WAIT'; }; }
function candleRev(thr) { return (b, i, p) => { if (i < 1) return 'WAIT'; const pv = bars[i - 1]; const pb = (pv.o - pv.c) / pv.o * 100; if (pb > thr) return 'LONG'; if (pb < -thr) return 'SHORT'; return 'WAIT'; }; }
function atrRev(mult) { return (b, i, p) => { if (i < 28) return 'WAIT'; const atr = (() => { let s = 0; for (let k = i - 14; k < i; k++) s += Math.max(bars[k].h - bars[k].l, Math.abs(bars[k].h - bars[k - 1].c), Math.abs(bars[k].l - bars[k - 1].c)); return s / 14; })(); const prev = (() => { let s = 0; for (let k = i - 28; k < i - 14; k++) s += Math.max(bars[k].h - bars[k].l, Math.abs(bars[k].h - bars[k - 1].c), Math.abs(bars[k].l - bars[k - 1].c)); return s / 14; })(); if (prev <= 0) return 'WAIT'; const body = (b.c - b.o) / b.o * 100; if (atr / prev > mult && body < -1) return 'LONG'; if (atr / prev > mult && body > 1) return 'SHORT'; return 'WAIT'; }; }
function extreme3() { return (b, i, p) => { const r = calcRSI(p, 14); const bb = calcBB(p, 20); const ma = sma(p.slice(-20), 20); const dev = (b.c - ma) / ma * 100; if (r < 30 && b.c < bb.lower && dev < -1.5) return 'LONG'; if (r > 70 && b.c > bb.upper && dev > 1.5) return 'SHORT'; return 'WAIT'; }; }
function extreme4() { return (b, i, p) => { const r = calcRSI(p, 14); const bb = calcBB(p, 20); const ma = sma(p.slice(-20), 20); const dev = (b.c - ma) / ma * 100; const bbPos = (b.c - bb.lower) / (bb.upper - bb.lower); if (r < 25 && bbPos < 0.05 && dev < -2) return 'LONG'; if (r > 75 && bbPos > 0.95 && dev > 2) return 'SHORT'; return 'WAIT'; }; }

const results = [];
const SL = [200, 300, 400]; const ACT = [200, 300, 400]; const TR = [300, 400, 500]; const HOLD = [12, 24];
function run(name, fn) {
  for (const sl of SL) for (const a of ACT) for (const tr of TR) for (const h of HOLD) {
    const t = replayTrailing(fn, { slPts: sl, activate: a, trailDist: tr, holdH: h });
    const s = stats(t); if (!s || s.n < 8) continue;
    results.push({ name: `${name}|sl${sl}|a${a}|tr${tr}|h${h}`, ...s });
  }
}
for (const lo of [20, 25, 30]) for (const hi of [70, 75, 80]) run(`rsi${lo}-${hi}`, rsiExt(lo, hi));
for (const lo of [25, 30]) for (const hi of [75, 80]) run(`rsiBb${lo}-${hi}`, rsiBbExt(lo, hi, 1.0));
for (const thr of [1.5, 2, 2.5, 3]) run(`cRev${thr}`, candleRev(thr));
for (const mult of [1.5, 2, 2.5]) run(`atrRev${mult}`, atrRev(mult));
run(`extreme3`, extreme3());
run(`extreme4`, extreme4());

results.sort((a, b) => b.winRate - a.winRate);
console.log(`总方案数: ${results.length}`);
console.log('=== TOP 25 by 胜率 ===');
for (const r of results.slice(0, 25)) console.log(`${r.name.padEnd(34)} n=${String(r.n).padStart(3)} WR=${String(r.winRate).padStart(5)}% tot=${String(r.total).padStart(6)} aW=${String(r.avgWin).padStart(5)} aL=${String(r.avgLoss).padStart(5)} pf=${String(r.pf).padStart(5)} big%=${r.bigPct}`);
const byPf = results.filter(r => r.n >= 12).sort((a, b) => b.pf - a.pf);
console.log('\n=== TOP 15 by PF (n>=12) ===');
for (const r of byPf.slice(0, 15)) console.log(`${r.name.padEnd(34)} n=${String(r.n).padStart(3)} WR=${r.winRate}% tot=${r.total} aW=${r.avgWin} aL=${r.avgLoss} pf=${r.pf} big%=${r.bigPct}`);
const big = results.filter(r => r.n >= 12 && r.avgWin >= 800);
console.log(`\n=== 平均盈利>=800 且 n>=12: ${big.length} 个 ===`);
for (const r of big.slice(0, 12)) console.log(`${r.name} | n=${r.n} WR=${r.winRate}% aW=${r.avgWin} aL=${r.avgLoss} pf=${r.pf} big%=${r.bigPct}`);
fs.writeFileSync(new URL('./search2_results.json', import.meta.url), JSON.stringify(results, null, 1));
