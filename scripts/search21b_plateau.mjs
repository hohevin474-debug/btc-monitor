// R21b: span × slope 二维平面 + 顶部候选的邻域稳健性 + 亏损归因
import { readFileSync } from 'fs';

const h1 = JSON.parse(readFileSync('data/okx_2y_1H.json', 'utf8')).candles;
const h4 = JSON.parse(readFileSync('data/okx_2y_4H.json', 'utf8')).candles;
const bars = h1.map(c => ({ ts: c.ts, o: +c.open, h: +c.high, l: +c.low, c: +c.close, v: +c.volume })).filter(b => b.c > 0);
const b4 = h4.map(c => ({ ts: c.ts, c: +c.close })).filter(b => b.c > 0);
const N = bars.length, H = bars.map(b => b.h), L = bars.map(b => b.l), CL = bars.map(b => b.c), TS = bars.map(b => b.ts);

const rsi1 = new Array(N).fill(50);
{ let g = 0, l = 0;
  for (let i = 1; i < N; i++) { const ch = CL[i] - CL[i - 1]; const u = Math.max(0, ch), d = Math.max(0, -ch);
    if (i <= 14) { g += u; l += d; if (i === 14) { g /= 14; l /= 14; } continue; }
    g = (g * 13 + u) / 14; l = (l * 13 + d) / 14; rsi1[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } }
const atrP = new Array(N).fill(0);
{ let p = 0;
  for (let i = 1; i < N; i++) { const t = Math.max(H[i] - L[i], Math.abs(H[i] - CL[i - 1]), Math.abs(L[i] - CL[i - 1])); p = i === 1 ? t : (p * 13 + t) / 14; atrP[i] = p / CL[i] * 100; } }
function calcEMAarr(a, p) { const k = 2 / (p + 1); const o = []; let pr; for (let i = 0; i < a.length; i++) { pr = i === 0 ? a[i] : a[i] * k + pr * (1 - k); o.push(pr); } return o; }
const EMA = {}; for (const p of [20, 22, 24, 26]) EMA[p] = calcEMAarr(CL, p);
const T4 = {};
for (const span of [4, 5, 6, 7, 8]) {
  const arr = new Array(N).fill(NaN); let k = 0;
  for (let i = 0; i < N; i++) { while (k + 1 < b4.length && b4[k + 1].ts <= TS[i]) k++; if (k >= span * 2) arr[i] = (b4[k].c - b4[k - span].c) / b4[k - span].c * 100; }
  T4[span] = arr;
}
const TP = 1000, SL = 3000, MH = 48;

function buildSigs(rsiLo, rsiHi, emaP, span, slopeThr, amn = 0.3, amx = 2.0) {
  const s = []; const e = EMA[emaP], t4 = T4[span];
  for (let i = 260; i < N - 50; i++) {
    if (atrP[i] < amn || atrP[i] > amx || isNaN(t4[i])) continue;
    let dir = null;
    if (rsi1[i - 1] < rsiLo && rsi1[i] >= rsiLo) dir = 'L';
    else if (rsi1[i - 1] > rsiHi && rsi1[i] <= rsiHi) dir = 'S';
    if (!dir) continue;
    if (dir === 'L' && t4[i] < slopeThr) continue;
    if (dir === 'S' && t4[i] > -slopeThr) continue;
    if (dir === 'L' && CL[i] > e[i]) continue;
    if (dir === 'S' && CL[i] < e[i]) continue;
    s.push({ i, dir });
  }
  return s;
}
function bt(sigs, keepTrades = false, span = 6) {
  let w = 0, l = 0, gW = 0, gL = 0, total = 0, tpc = 0, maxLoss = 0, streak = 0, maxStreak = 0;
  let busyUntil = -1; const trades = [];
  for (const sig of sigs) {
    if (sig.i <= busyUntil) continue;
    const i = sig.i, dir = sig.dir, entry = bars[i + 1].o;
    const tpL = dir === 'L' ? entry + TP : entry - TP, slL = dir === 'L' ? entry - SL : entry + SL;
    let ep = 0, rs = ''; const end = Math.min(i + MH, N - 1);
    let mae = 0, mfe = 0;
    for (let j = i + 1; j <= end; j++) {
      const hi = bars[j].h, lo = bars[j].l;
      if (dir === 'L') { mae = Math.max(mae, entry - lo); mfe = Math.max(mfe, hi - entry); if (hi >= tpL) { ep = TP; rs = 'TP'; break; } if (lo <= slL) { ep = slL - entry; rs = 'SL'; break; } }
      else { mae = Math.max(mae, hi - entry); mfe = Math.max(mfe, entry - lo); if (lo <= tpL) { ep = TP; rs = 'TP'; break; } if (hi >= slL) { ep = entry - slL; rs = 'SL'; break; } }
    }
    if (!rs) { const last = bars[end].c; ep = dir === 'L' ? last - entry : entry - last; rs = 'TIME'; }
    total++; if (rs === 'TP') tpc++;
    if (ep > 0) { w++; gW += ep; streak = 0; } else { l++; gL += -ep; maxLoss = Math.max(maxLoss, -ep); streak++; maxStreak = Math.max(maxStreak, streak); }
    trades.push({ i, dir, entry, ep, rs, mae, mfe, atr: atrP[i], slope: T4[span][i], bars: i });    busyUntil = end;
  }
  const pf = gL > 0 ? gW / gL : (gW > 0 ? 99 : 0);
  return keepTrades ? { n: total, strict: +(tpc / total * 100).toFixed(1), pf: +pf.toFixed(2), maxLoss, maxStreak, trades }
                     : { n: total, strict: +(tpc / total * 100).toFixed(1), pf: +pf.toFixed(2), maxLoss, maxStreak };
}

// ===== 1. span × slope 2D 平面（RSI42/58 EMA20 ATR[0.3,2]）=====
console.log('=== span × slope 2D 平面：严格%(n) — RSI42/58 EMA20 ATR[0.3,2] ===');
const spans = [4, 5, 6, 7, 8], sts = [0.1, 0.2, 0.3, 0.4, 0.5, 0.7, 1.0];
process.stdout.write('        ');
for (const st of sts) process.stdout.write(`斜${st}`.padStart(14));
console.log();
for (const span of spans) {
  process.stdout.write(`跨${span}(4H*${span})`.padEnd(8));
  for (const st of sts) {
    const r = bt(buildSigs(42, 58, 20, span, st), false, span);
    process.stdout.write(`${r.strict}%(${r.n})`.padStart(14));
  }
  console.log();
}

// ===== 2. 顶部候选邻域稳健性：RSI42/58 EMA24 跨6 斜0.5 =====
console.log('\n=== 候选A: RSI42/58 EMA24 跨6 斜0.5 的 3×3 邻域（EMA 22/24/26 × 斜 0.4/0.5/0.6）===');
for (const emaP of [20, 22, 24, 26]) {
  const line = [0.4, 0.5, 0.6].map(st => { const r = bt(buildSigs(42, 58, emaP, 6, st)); return `斜${st}:${r.strict}%(n${r.n},PF${r.pf})`; });
  console.log(`  EMA${emaP}: ${line.join('  ')}`);
}
console.log('  —— span 邻域（EMA24 斜0.5）——');
for (const span of [5, 6, 7]) {
  const r = bt(buildSigs(42, 58, 24, span, 0.5));
  console.log(`  跨${span}: ${r.strict}%(n${r.n},PF${r.pf})`);
}

// ===== 3. 候选B: RSI41/59 EMA24 跨5 斜0.4 ATR[0.4,1.8] 邻域 =====
console.log('\n=== 候选B: RSI41/59 EMA24 跨5 斜0.4 ATR[0.4,1.8] 邻域 ===');
for (const [lo, hi] of [[40, 60], [41, 59], [42, 58], [43, 57]]) {
  const r = bt(buildSigs(lo, hi, 24, 5, 0.4, 0.4, 1.8));
  console.log(`  RSI${lo}/${hi}: ${r.strict}%(n${r.n},PF${r.pf})`);
}
for (const span of [4, 5, 6]) {
  const r = bt(buildSigs(41, 59, 24, span, 0.4, 0.4, 1.8));
  console.log(`  跨${span}: ${r.strict}%(n${r.n},PF${r.pf})`);
}
for (const st of [0.3, 0.4, 0.5]) {
  const r = bt(buildSigs(41, 59, 24, 5, st, 0.4, 1.8));
  console.log(`  斜${st}: ${r.strict}%(n${r.n},PF${r.pf})`);
}

// ===== 4. 亏损归因：基线 + 候选A =====
console.log('\n=== 亏损归因（基线 RSI42/58 EMA20 跨6 斜0.3）===');
const base = bt(buildSigs(42, 58, 20, 6, 0.3), true);
console.log(`n=${base.n} 严格=${base.strict}% 亏损 ${base.trades.filter(t => t.ep <= 0).length} 笔，连亏最多 ${base.maxStreak}`);
for (const t of base.trades.filter(t => t.ep <= 0)) {
  const d = new Date(TS[t.i]);
  console.log(`  ${d.toISOString().slice(0, 13)} ${t.dir.padEnd(5)} 入${t.entry.toFixed(0)} 结果=${t.rs} 盈亏=${t.ep.toFixed(0)} MAE=${t.mae.toFixed(0)} ATR%=${t.atr.toFixed(2)} 4H斜=${t.slope.toFixed(2)}`);
}
console.log('\n=== 亏损归因（候选A RSI42/58 EMA24 跨6 斜0.5）===');
const candA = bt(buildSigs(42, 58, 24, 6, 0.5), true);
console.log(`n=${candA.n} 严格=${candA.strict}% 亏损 ${candA.trades.filter(t => t.ep <= 0).length} 笔，连亏最多 ${candA.maxStreak}`);
for (const t of candA.trades.filter(t => t.ep <= 0)) {
  const d = new Date(TS[t.i]);
  console.log(`  ${d.toISOString().slice(0, 13)} ${t.dir.padEnd(5)} 入${t.entry.toFixed(0)} 结果=${t.rs} 盈亏=${t.ep.toFixed(0)} MAE=${t.mae.toFixed(0)} ATR%=${t.atr.toFixed(2)} 4H斜=${t.slope.toFixed(2)}`);
}
