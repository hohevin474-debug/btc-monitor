// 第三轮：极严多条件共振入场，专门冲"用极低频率换高胜率"。
// 条件：RSI 极端 AND 布林带极值 AND 偏离 MA 幅度 AND (可选)长影线反转。
// 验证：即使入场极严，稳定样本下胜率能否逼近 90%？
import fs from 'fs';
import { calcRSI, calcBB, sma } from './replay_lib.mjs';

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
      if (ep >= activate) { const ns = isLong ? pos.best - trailDist : pos.best + trailDist; if (isLong) pos.stop = Math.max(pos.stop, ns); else pos.stop = Math.min(pos.stop, ns); }
      let exit = null;
      if (isLong && lo <= pos.stop) exit = { px: Math.max(lo, pos.stop), kind: 'SL' };
      else if (!isLong && hi >= pos.stop) exit = { px: Math.min(hi, pos.stop), kind: 'SL' };
      const held = (bar.t / 1000) - pos.entryTime;
      if (!exit && held >= holdH * 3600) exit = { px: cl, kind: 'EXP' };
      if (exit) { const pnl = Math.round(isLong ? exit.px - pos.entry : pos.entry - exit.px); trades.push({ dir: pos.dir, pnl, kind: exit.kind }); pos = null; }
    }
    if (!pos && i >= warmup) {
      const sig = signalFn(bar, i, prices);
      if (sig && sig !== 'WAIT') { const isLong = sig === 'LONG'; pos = { dir: sig, entry: bar.c, entryTime: bar.t / 1000, stop: isLong ? bar.c - slPts : bar.c + slPts, best: bar.c }; }
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
  const pf = gl > 0 ? gw / gl : 999; const big = trades.filter(t => t.pnl >= 1000).length;
  return { n, winRate: +(wins.length / n * 100).toFixed(1), total, avgWin: Math.round(avgWin), avgLoss: Math.round(avgLoss), pf: +Math.min(pf, 999).toFixed(2), bigPct: +(big / n * 100).toFixed(1) };
}

// 极严共振入场
function quad(opts) {
  const { rsiLo, bbPosThr, devThr, wick } = opts;
  return (b, i, p) => {
    const r = calcRSI(p, 14); const bb = calcBB(p, 20); const ma = sma(p.slice(-20), 20);
    const dev = (b.c - ma) / ma * 100; const bbPos = (b.c - bb.lower) / (bb.upper - bb.lower);
    const body = Math.abs(b.c - b.o);
    const lowerWick = b.c > b.o ? (b.o - b.l) : (b.c - b.l);
    const upperWick = b.c > b.o ? (b.h - b.c) : (b.h - b.o);
    const dn = r < rsiLo && bbPos < bbPosThr && dev < -devThr && (!wick || lowerWick > body * 1.5);
    const up = r > (100 - rsiLo) && bbPos > (1 - bbPosThr) && dev > devThr && (!wick || upperWick > body * 1.5);
    return dn ? 'LONG' : up ? 'SHORT' : 'WAIT';
  };
}

const results = [];
const SL = [200, 300]; const ACT = [200, 300]; const TR = [300, 400]; const HOLD = [12, 24];
function run(name, fn) {
  for (const sl of SL) for (const a of ACT) for (const tr of TR) for (const h of HOLD) {
    const t = replayTrailing(fn, { slPts: sl, activate: a, trailDist: tr, holdH: h });
    const s = stats(t); if (!s || s.n < 6) continue;
    results.push({ name: `${name}|sl${sl}|a${a}|tr${tr}|h${h}`, ...s });
  }
}
for (const rsiLo of [20, 25]) for (const bbPosThr of [0.05, 0.1]) for (const devThr of [2, 3]) for (const wick of [false, true])
  run(`q_r${rsiLo}_bb${bbPosThr}_d${devThr}_w${wick ? 1 : 0}`, quad({ rsiLo, bbPosThr, devThr, wick }));

results.sort((a, b) => b.winRate - a.winRate);
console.log(`总方案: ${results.length}`);
console.log('=== TOP 20 by 胜率 ===');
for (const r of results.slice(0, 20)) console.log(`${r.name.padEnd(34)} n=${String(r.n).padStart(3)} WR=${String(r.winRate).padStart(5)}% tot=${String(r.total).padStart(6)} aW=${String(r.avgWin).padStart(5)} aL=${String(r.avgLoss).padStart(5)} pf=${String(r.pf).padStart(5)} big%=${r.bigPct}`);
const ok = results.filter(r => r.n >= 10).sort((a, b) => b.winRate - a.winRate);
console.log(`\n=== n>=10 最高胜率 (${ok.length} 个) ===`);
for (const r of ok.slice(0, 10)) console.log(`${r.name} | n=${r.n} WR=${r.winRate}% aW=${r.avgWin} aL=${r.avgLoss} pf=${r.pf} big%=${r.bigPct}`);
const bestBig = results.filter(r => r.n >= 10 && r.avgWin >= 800).sort((a, b) => b.winRate - a.winRate);
console.log(`\n=== n>=10 且 平均盈利>=800: ${bestBig.length} 个 ===`);
for (const r of bestBig.slice(0, 10)) console.log(`${r.name} | n=${r.n} WR=${r.winRate}% aW=${r.avgWin} pf=${r.pf} big%=${r.bigPct}`);
fs.writeFileSync(new URL('./search3_results.json', import.meta.url), JSON.stringify(results, null, 1));
