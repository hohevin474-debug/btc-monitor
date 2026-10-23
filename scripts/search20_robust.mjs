// R20: 对「斜率0.3+ema」(91.1%/PF7.27) 做严格稳健性检验后再部署
import { readFileSync } from 'node:fs';
const h1 = JSON.parse(readFileSync('data/okx_2y_1H.json', 'utf8'));
const h4 = JSON.parse(readFileSync('data/okx_2y_4H.json', 'utf8'));
const C1 = Array.isArray(h1) ? h1 : h1.candles;
const C4 = Array.isArray(h4) ? h4 : h4.candles;
const bars = C1.map(c => ({ ts: c.ts, o: +c.open, h: +c.high, l: +c.low, c: +c.close })).filter(b => b.c > 0);
const N = bars.length, H = bars.map(b => b.h), L = bars.map(b => b.l), CL = bars.map(b => b.c), TS = bars.map(b => b.ts);
function calcEMAarr(a, p) { const k = 2 / (p + 1); const o = []; let pr; for (let i = 0; i < a.length; i++) { pr = i === 0 ? a[i] : a[i] * k + pr * (1 - k); o.push(pr); } return o; }
const rsi1 = new Array(N).fill(50);
{ let g = 0, l = 0; for (let i = 1; i < N; i++) { const ch = CL[i] - CL[i - 1]; const u = Math.max(0, ch), d = Math.max(0, -ch); if (i <= 14) { g += u; l += d; if (i === 14) { g /= 14; l /= 14; } continue; } g = (g * 13 + u) / 14; l = (l * 13 + d) / 14; rsi1[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } }
const atrP = new Array(N).fill(0);
{ let p = 0; for (let i = 1; i < N; i++) { const t = Math.max(H[i] - L[i], Math.abs(H[i] - CL[i - 1]), Math.abs(L[i] - CL[i - 1])); p = i === 1 ? t : (p * 13 + t) / 14; atrP[i] = p / CL[i] * 100; } }
const e20_1 = calcEMAarr(CL, 20);
const b4 = C4.map(c => ({ ts: c.ts, c: +c.close })).filter(b => b.c > 0);
const e20_4 = calcEMAarr(b4.map(b => b.c), 20);
const t4slope = new Array(N).fill(NaN);
{ let k = 0; for (let i = 0; i < N; i++) { while (k + 1 < b4.length && b4[k + 1].ts <= TS[i]) k++; if (k >= 12) t4slope[i] = (b4[k].c - b4[k - 6].c) / b4[k - 6].c * 100; } }
const YEAR = 24 * 365; // 1H 年 bar 数

function build(slopeThr, lo, hi, amn, amx, useEma) {
  const s = [];
  for (let i = 260; i < N - 50; i++) {
    if (atrP[i] < amn || atrP[i] > amx || isNaN(t4slope[i])) continue;
    let dir = null;
    if (rsi1[i - 1] < lo && rsi1[i] >= lo) dir = 'L'; else if (rsi1[i - 1] > hi && rsi1[i] <= hi) dir = 'S';
    if (!dir) continue;
    if (dir === 'L' && t4slope[i] < slopeThr) continue; if (dir === 'S' && t4slope[i] > -slopeThr) continue;
    if (useEma) { if (dir === 'L' && CL[i] > e20_1[i]) continue; if (dir === 'S' && CL[i] < e20_1[i]) continue; }
    s.push({ i, dir });
  }
  return s;
}
function bt(sigs, tp, sl, mh, from = 0, to = N) {
  let w = 0, l = 0, gW = 0, gL = 0, total = 0, tpc = 0, maxLoss = 0;
  for (const sig of sigs) {
    if (sig.i < from || sig.i >= to) continue;
    const i = sig.i, dir = sig.dir, entry = bars[i + 1].o; if (!entry) continue;
    const tpL = dir === 'L' ? entry + tp : entry - tp, slL = dir === 'L' ? entry - sl : entry + sl;
    let ep = 0, rs = ''; const end = Math.min(i + mh, N - 1);
    for (let j = i + 1; j <= end; j++) { const hi = bars[j].h, lo = bars[j].l; if (dir === 'L') { if (hi >= tpL) { ep = tp; rs = 'TP'; break; } if (lo <= slL) { ep = slL - entry; rs = 'SL'; break; } } else { if (lo <= tpL) { ep = tp; rs = 'TP'; break; } if (hi >= slL) { ep = entry - slL; rs = 'SL'; break; } } }
    if (!rs) { const last = bars[end].c; ep = dir === 'L' ? last - entry : entry - last; }
    total++; if (rs === 'TP') tpc++;
    if (ep > 0) { w++; gW += ep; } else { l++; gL += -ep; maxLoss = Math.max(maxLoss, -ep); }
  }
  const pf = gL > 0 ? gW / gL : (gW > 0 ? 99 : 0);
  return { n: total, strict: total ? +(tpc / total * 100).toFixed(1) : 0, winRate: total ? +(w / total * 100).toFixed(1) : 0, pf: +pf.toFixed(2), maxLoss: +maxLoss.toFixed(0) };
}
const TP = 1000, MH = 48;
const base = build(0.3, 40, 60, 0.3, 2.0, true);
console.log('=== ① 年度分解（斜率0.3+ema 基准）===');
for (const [yi, y0, y1, lbl] of [[0, 0, YEAR, '第1年'], [1, YEAR, 2 * YEAR, '第2年']]) {
  const r = bt(base, TP, 3000, MH, y0, Math.min(y1, N));
  console.log(`  ${lbl}: n=${r.n} 严格=${r.strict}% 宽松=${r.winRate}% PF=${r.pf}`);
}
console.log('\n=== ② SL 敏感性（TP=1000/48h）===');
for (const sl of [2000, 2500, 3000, 4000, 5000]) { const r = bt(base, TP, sl, MH); console.log(`  SL=${sl}: n=${r.n} 严格=${r.strict}% PF=${r.pf} 最大亏=${r.maxLoss}`); }
console.log('\n=== ③ 邻近参数稳健性（TP=1000/SL=3000/48h）===');
for (const [st, lo, hi, amn, amx] of [[0.2, 40, 60, 0.3, 2.0], [0.4, 40, 60, 0.3, 2.0], [0.3, 38, 62, 0.3, 2.0], [0.3, 42, 58, 0.3, 2.0], [0.3, 40, 60, 0.5, 1.5], [0.3, 40, 60, 0.3, 3.0], [0.25, 40, 60, 0.3, 2.0]]) {
  const s = build(st, lo, hi, amn, amx, true); const r = bt(s, TP, 3000, MH);
  console.log(`  斜率${st} RSI${lo}/${hi} ATR[${amn},${amx}]: n=${r.n} 严格=${r.strict}% 宽松=${r.winRate}% PF=${r.pf}`);
}
console.log('\n=== ④ 48h 持仓敏感性（SL=3000）===');
for (const mh of [24, 36, 48, 72]) { const r = bt(base, TP, 3000, mh); console.log(`  maxHold=${mh}h: n=${r.n} 严格=${r.strict}% PF=${r.pf}`); }
