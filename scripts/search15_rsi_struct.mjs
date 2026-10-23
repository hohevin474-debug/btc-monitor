// R15: RSI35/65 + ATR过滤 基础上叠加结构性确认，冲更高命中率 @ TP=1000/48h
import { readFileSync } from 'node:fs';
const raw = JSON.parse(readFileSync('data/okx_1y_1H.json', 'utf8'));
const C = Array.isArray(raw) ? raw : raw.candles;
const bars = C.map(c => ({ o: +c.open, h: +c.high, l: +c.low, c: +c.close, v: +c.volume })).filter(b => b.c > 0);
const N = bars.length, H = bars.map(b => b.h), L = bars.map(b => b.l), CL = bars.map(b => b.c), V = bars.map(b => b.v);
function calcEMA(a, p) { const k = 2 / (p + 1); const o = []; let pr; for (let i = 0; i < a.length; i++) { pr = i === 0 ? a[i] : a[i] * k + pr * (1 - k); o.push(pr); } return o; }
const e20 = calcEMA(CL, 20), e50 = calcEMA(CL, 50), e200 = calcEMA(CL, 200);
const rsi = new Array(N).fill(50);
{ let g = 0, l = 0; for (let i = 1; i < N; i++) { const ch = CL[i] - CL[i - 1]; const up = Math.max(0, ch), dn = Math.max(0, -ch); if (i <= 14) { g += up; l += dn; if (i === 14) { g /= 14; l /= 14; } continue; } g = (g * 13 + up) / 14; l = (l * 13 + dn) / 14; rsi[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } }
const atrP = new Array(N).fill(0);
{ let p = 0; for (let i = 1; i < N; i++) { const t = Math.max(H[i] - L[i], Math.abs(H[i] - CL[i - 1]), Math.abs(L[i] - CL[i - 1])); p = i === 1 ? t : (p * 13 + t) / 14; atrP[i] = p / CL[i] * 100; } }
// 布林带 (20,2)
const bbUp = new Array(N), bbDn = new Array(N);
for (let i = 19; i < N; i++) { let s = 0; for (let j = i - 19; j <= i; j++) s += CL[j]; const m = s / 20; let v = 0; for (let j = i - 19; j <= i; j++) v += (CL[j] - m) ** 2; const sd = Math.sqrt(v / 20); bbUp[i] = m + 2 * sd; bbDn[i] = m - 2 * sd; }

function bt(sigs, tp, sl, mh) {
  let w = 0, l = 0, gW = 0, gL = 0, total = 0, tpc = 0;
  const hs = [0, 0], ht = [0, 0], half = Math.floor(N / 2);
  for (const sig of sigs) {
    const i = sig.i, dir = sig.dir, entry = bars[i + 1].o; if (!entry) continue;
    const tpL = dir === 'L' ? entry + tp : entry - tp, slL = dir === 'L' ? entry - sl : entry + sl;
    let ep = 0, reason = ''; const end = Math.min(i + mh, N - 1);
    for (let j = i + 1; j <= end; j++) { const hi = bars[j].h, lo = bars[j].l; if (dir === 'L') { if (hi >= tpL) { ep = tp; reason = 'TP'; break; } if (lo <= slL) { ep = slL - entry; reason = 'SL'; break; } } else { if (lo <= tpL) { ep = tp; reason = 'TP'; break; } if (hi >= slL) { ep = entry - slL; reason = 'SL'; break; } } }
    if (!reason) { const last = bars[end].c; ep = dir === 'L' ? last - entry : entry - last; }
    total++; if (reason === 'TP') tpc++;
    const seg = sig.i < half ? 0 : 1;
    if (ep > 0) { w++; gW += ep; hs[seg]++; } else { l++; gL += -ep; }
    ht[seg]++;
  }
  const pf = gL > 0 ? gW / gL : (gW > 0 ? 99 : 0);
  return { n: total, winRate: total ? +(w / total * 100).toFixed(1) : 0, strict: total ? +(tpc / total * 100).toFixed(1) : 0, pf: +pf.toFixed(2), h1: ht[0] ? +(hs[0] / ht[0] * 100).toFixed(1) : 0, h2: ht[1] ? +(hs[1] / ht[1] * 100).toFixed(1) : 0 };
}

// 基础：RSI35/65 回升 + ATR%∈[amn,amx] + 可选结构确认
function sig(opt) {
  const { lo = 35, hi = 65, amn = 0.5, amx = 1.5, stretch = 0, bb = false, trend = false } = opt;
  const s = [];
  for (let i = 250; i < N - 60; i++) {
    if (atrP[i] < amn || atrP[i] > amx) continue;
    const distE20 = Math.abs(CL[i] - e20[i]) / CL[i] * 100;
    if (stretch && distE20 < stretch) continue;
    const lOK = (!bb || CL[i] <= bbDn[i]) && (!trend || true);
    const sOK = (!bb || CL[i] >= bbUp[i]);
    if (rsi[i - 1] < lo && rsi[i] >= lo && lOK) s.push({ i, dir: 'L' });
    else if (rsi[i - 1] > hi && rsi[i] <= hi && sOK) s.push({ i, dir: 'S' });
  }
  return s;
}

const variants = [
  { label: 'RSI35/65+ATR (基线)', opt: {} },
  { label: 'RSI35/65+ATR+偏离EMA≥1%', opt: { stretch: 1.0 } },
  { label: 'RSI35/65+ATR+偏离EMA≥1.5%', opt: { stretch: 1.5 } },
  { label: 'RSI35/65+ATR+偏离EMA≥2%', opt: { stretch: 2.0 } },
  { label: 'RSI35/65+ATR+布林触边', opt: { bb: true } },
  { label: 'RSI30/70+ATR+偏离EMA≥1.5%', opt: { lo: 30, hi: 70, stretch: 1.5 } },
  { label: 'RSI40/60+ATR+偏离EMA≥1.5%', opt: { lo: 40, hi: 60, stretch: 1.5 } },
  { label: 'RSI35/65+ATR+偏离≥1.5% 宽ATR[0.3,2]', opt: { stretch: 1.5, amn: 0.3, amx: 2.0 } },
  { label: 'RSI35/65+ATR[0.5,1.5]+偏离≥1%', opt: { stretch: 1.0 } },
];
const SLs = [4000, 6000, 8000, 12000];
const rows = [];
for (const v of variants) { const s = sig(v.opt); if (s.length < 20) continue; for (const sl of SLs) { const r = bt(s, 1000, sl, 48); if (r.n >= 25) rows.push({ label: v.label, sl, ...r }); } }
console.log('=== R15: 叠加结构确认 @ TP=1000/48h：严格命中最高 前12 ===');
for (const r of rows.filter(r => r.pf > 1).sort((a, b) => b.strict - a.strict).slice(0, 12))
  console.log(`  ${r.label.padEnd(26)} SL=${String(r.sl).padStart(5)} n=${String(r.n).padStart(4)} 严格=${String(r.strict).padStart(5)}% 宽松=${String(r.winRate).padStart(5)}% PF=${String(r.pf).padStart(5)} 上下半=${r.h1}/${r.h2}`);
