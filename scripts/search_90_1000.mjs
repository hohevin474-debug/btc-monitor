// 目标搜索：胜率>=90% + 单笔盈利>=1000点 + 持仓<=24h
// 通用回放引擎（不耦合 V1/V2），止盈固定 1000 点，止损/持仓参数化，扫描多种信号方法论。
import fs from 'fs';
import { calcRSI, calcBB, sma } from './replay_lib.mjs';

const raw = JSON.parse(fs.readFileSync(new URL('../data/okx_60d.json', import.meta.url), 'utf8'));
const bars = raw.map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, vol: b.vol }));
const N = bars.length;
const closes = bars.map(b => b.c);

function replay(signalFn, { slPts = 300, tpPts = 1000, holdH = 24, warmup = 200 } = {}) {
  const trades = []; let pos = null;
  for (let i = warmup; i < N; i++) {
    const bar = bars[i];
    const prices = closes.slice(0, i + 1);
    if (pos) {
      const isLong = pos.dir === 'LONG';
      const hi = bar.h, lo = bar.l, cl = bar.c;
      if (isLong) pos.best = Math.max(pos.best, hi); else pos.best = Math.min(pos.best, lo);
      let exit = null;
      if (isLong && hi >= pos.tp) exit = { px: pos.tp, kind: 'TP' };
      else if (!isLong && lo <= pos.tp) exit = { px: pos.tp, kind: 'TP' };
      if (!exit) {
        if (isLong && lo <= pos.sl) exit = { px: Math.max(lo, pos.sl), kind: 'SL' };
        else if (!isLong && hi >= pos.sl) exit = { px: Math.min(hi, pos.sl), kind: 'SL' };
      }
      const held = (bar.t / 1000) - pos.entryTime;
      if (!exit && held >= holdH * 3600) exit = { px: cl, kind: 'EXP' };
      if (exit) {
        const pnl = Math.round(isLong ? exit.px - pos.entry : pos.entry - exit.px);
        trades.push({ dir: pos.dir, pnl, kind: exit.kind });
        pos = null;
      }
    }
    if (!pos && i >= warmup) {
      const sig = signalFn(bar, i, prices);
      if (sig && sig !== 'WAIT') {
        const isLong = sig === 'LONG';
        pos = { dir: sig, entry: bar.c, entryTime: bar.t / 1000,
          tp: isLong ? bar.c + tpPts : bar.c - tpPts,
          sl: isLong ? bar.c - slPts : bar.c + slPts, best: bar.c };
      }
    }
  }
  return trades;
}

function stats(trades) {
  const n = trades.length; if (!n) return null;
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const total = trades.reduce((a, t) => a + t.pnl, 0);
  const avgWin = wins.length ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, t) => a + t.pnl, 0) / losses.length : 0;
  const gw = wins.reduce((a, t) => a + t.pnl, 0);
  const gl = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const pf = gl > 0 ? gw / gl : 999;
  const tpN = trades.filter(t => t.kind === 'TP').length;
  return { n, winRate: +(wins.length / n * 100).toFixed(1), total,
    avgWin: Math.round(avgWin), avgLoss: Math.round(avgLoss), pf: +Math.min(pf, 999).toFixed(2), tpPct: +(tpN / n * 100).toFixed(1) };
}

// ---- 信号方法论 ----
function rsiSig(lo, hi) { return (bar, i, p) => { const r = calcRSI(p, 14); return r < lo ? 'LONG' : r > hi ? 'SHORT' : 'WAIT'; }; }
function bbSig(m) { return (bar, i, p) => { const bb = calcBB(p, 20); return bar.c < bb.lower * m ? 'LONG' : bar.c > bb.upper * m ? 'SHORT' : 'WAIT'; }; }
function maDevSig(d) { return (bar, i, p) => { const ma = sma(p.slice(-20), 20); const dev = (bar.c - ma) / ma * 100; return dev < -d ? 'LONG' : dev > d ? 'SHORT' : 'WAIT'; }; }
function rsiBbSig(lo, hi, m) { return (bar, i, p) => { const r = calcRSI(p, 14); const bb = calcBB(p, 20); const up = r > hi || bar.c > bb.upper * m; const dn = r < lo || bar.c < bb.lower * m; return dn ? 'LONG' : up ? 'SHORT' : 'WAIT'; }; }
function candleRevSig(thr) { return (bar, i, p) => { if (i < 1) return 'WAIT'; const prev = bars[i-1]; const pb = (prev.o - prev.c) / prev.o * 100; if (pb > thr) return 'LONG'; if (pb < -thr) return 'SHORT'; return 'WAIT'; }; }
function breakoutPbSig(n) { return (bar, i, p) => { if (i < n + 1) return 'WAIT'; const w = closes.slice(i - n, i); const hh = Math.max(...w.slice(0, -1)); const ll = Math.min(...w.slice(0, -1)); const ma = sma(p.slice(-20), 20); if (closes[i-1] >= hh && bar.c < closes[i-1] && bar.c > ma) return 'LONG'; if (closes[i-1] <= ll && bar.c > closes[i-1] && bar.c < ma) return 'SHORT'; return 'WAIT'; }; }
// ATR 异常 + 反转：波动率骤升后反向
function atrRevSig(mult) { return (bar, i, p) => { if (i < 15) return 'WAIT'; const atr = (() => { let s = 0; for (let k = i - 14; k < i; k++) s += Math.max(bars[k].h - bars[k].l, Math.abs(bars[k].h - bars[k-1].c), Math.abs(bars[k].l - bars[k-1].c)); return s / 14; })(); const prevAtr = (() => { let s = 0; for (let k = i - 28; k < i - 14; k++) s += Math.max(bars[k].h - bars[k].l, Math.abs(bars[k].h - bars[k-1].c), Math.abs(bars[k].l - bars[k-1].c)); return s / 14; })(); if (prevAtr <= 0) return 'WAIT'; const ratio = atr / prevAtr; const body = (bar.c - bar.o) / bar.o * 100; if (ratio > mult && body < -1) return 'LONG'; if (ratio > mult && body > 1) return 'SHORT'; return 'WAIT'; }; }

const results = [];
const SL = [200, 300, 400, 500];
const HOLD = [12, 24];
function run(name, fn) {
  for (const sl of SL) for (const hold of HOLD) {
    const tr = replay(fn, { slPts: sl, holdH: hold });
    const s = stats(tr); if (!s || s.n < 8) continue;
    results.push({ name: `${name}|sl${sl}|h${hold}`, ...s });
  }
}

for (const lo of [18, 20, 25, 30]) for (const hi of [70, 75, 80, 82]) run(`rsi${lo}-${hi}`, rsiSig(lo, hi));
for (const m of [0.995, 1.0, 1.005, 1.01]) run(`bb*m${m}`, bbSig(m));
for (const d of [1, 1.5, 2, 2.5, 3]) run(`maDev${d}`, maDevSig(d));
for (const lo of [20, 25, 30]) for (const hi of [75, 80]) for (const m of [0.998, 1.0, 1.005]) run(`rsiBb${lo}-${hi}-m${m}`, rsiBbSig(lo, hi, m));
for (const thr of [1.5, 2, 2.5, 3]) run(`cRev${thr}`, candleRevSig(thr));
for (const n of [10, 20, 30]) run(`bopb${n}`, breakoutPbSig(n));
for (const mult of [1.5, 2, 2.5]) run(`atrRev${mult}`, atrRevSig(mult));

results.sort((a, b) => b.winRate - a.winRate);
console.log(`总方案数: ${results.length}`);
console.log('=== TOP 45 by 胜率 ===');
for (const r of results.slice(0, 45)) console.log(`${r.name.padEnd(26)} n=${String(r.n).padStart(3)} WR=${String(r.winRate).padStart(5)}% tot=${String(r.total).padStart(6)} aW=${String(r.avgWin).padStart(5)} aL=${String(r.avgLoss).padStart(5)} pf=${String(r.pf).padStart(5)} tp%=${r.tpPct}`);
const hit = results.filter(r => r.winRate >= 85 && r.n >= 10);
console.log(`\n=== 胜率>=85% 且 n>=10: ${hit.length} 个 ===`);
for (const r of hit) console.log(`${r.name} | n=${r.n} WR=${r.winRate}% tot=${r.total} aW=${r.avgWin} aL=${r.avgLoss} pf=${r.pf} tp%=${r.tpPct}`);
const best = results.filter(r => r.n >= 10).sort((a, b) => (b.winRate - a.winRate))[0];
console.log('\n最高胜率方案:', JSON.stringify(best));
fs.writeFileSync(new URL('./search_results.json', import.meta.url), JSON.stringify(results, null, 1));
