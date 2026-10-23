// R14: refine RSI 回归家族 @ TP=1000/48h，最大化「严格命中率」与「宽松胜率」（PF>1）
import { readFileSync } from 'node:fs';
const raw = JSON.parse(readFileSync('data/okx_1y_1H.json', 'utf8'));
const C = Array.isArray(raw) ? raw : raw.candles;
const bars = C.map(c => ({ o: +c.open, h: +c.high, l: +c.low, c: +c.close, v: +c.volume })).filter(b => b.c > 0);
const N = bars.length, H = bars.map(b => b.h), L = bars.map(b => b.l), CL = bars.map(b => b.c), V = bars.map(b => b.v);
function calcEMA(a, p) { const k = 2 / (p + 1); const o = []; let pr; for (let i = 0; i < a.length; i++) { pr = i === 0 ? a[i] : a[i] * k + pr * (1 - k); o.push(pr); } return o; }
const e20 = calcEMA(CL, 20), e50 = calcEMA(CL, 50), e200 = calcEMA(CL, 200);
const rsi = new Array(N).fill(50);
{ let g = 0, l = 0; for (let i = 1; i < N; i++) { const ch = CL[i] - CL[i - 1]; const up = Math.max(0, ch), dn = Math.max(0, -ch); if (i <= 14) { g += up; l += dn; if (i === 14) { g /= 14; l /= 14; } continue; } g = (g * 13 + up) / 14; l = (l * 13 + dn) / 14; rsi[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } }
// ATR% 用于波动regime过滤
const atrP = new Array(N).fill(0);
{ let p = 0; for (let i = 1; i < N; i++) { const t = Math.max(H[i] - L[i], Math.abs(H[i] - CL[i - 1]), Math.abs(L[i] - CL[i - 1])); p = i === 1 ? t : (p * 13 + t) / 14; atrP[i] = p / CL[i] * 100; } }

function bt(sigs, tp, sl, mh) {
  let w = 0, l = 0, gW = 0, gL = 0, total = 0, tpc = 0, slc = 0, tc = 0;
  const hs = [0, 0], ht = [0, 0], half = Math.floor(N / 2);
  for (const sig of sigs) {
    const i = sig.i, dir = sig.dir, entry = bars[i + 1].o; if (!entry) continue;
    const tpL = dir === 'L' ? entry + tp : entry - tp, slL = dir === 'L' ? entry - sl : entry + sl;
    let ep = 0, reason = ''; const end = Math.min(i + mh, N - 1);
    for (let j = i + 1; j <= end; j++) { const hi = bars[j].h, lo = bars[j].l; if (dir === 'L') { if (hi >= tpL) { ep = tp; reason = 'TP'; break; } if (lo <= slL) { ep = slL - entry; reason = 'SL'; break; } } else { if (lo <= tpL) { ep = tp; reason = 'TP'; break; } if (hi >= slL) { ep = entry - slL; reason = 'SL'; break; } } }
    if (!reason) { const last = bars[end].c; ep = dir === 'L' ? last - entry : entry - last; reason = 'T'; }
    total++; if (reason === 'TP') tpc++; else if (reason === 'SL') slc++; else tc++;
    const seg = sig.i < half ? 0 : 1;
    if (ep > 0) { w++; gW += ep; hs[seg]++; } else { l++; gL += -ep; }
    ht[seg]++;
  }
  const pf = gL > 0 ? gW / gL : (gW > 0 ? 99 : 0);
  return { n: total, winRate: total ? +(w / total * 100).toFixed(1) : 0, strict: total ? +(tpc / total * 100).toFixed(1) : 0, pf: +pf.toFixed(2), slCnt: slc, t: tc, h1: ht[0] ? +(hs[0] / ht[0] * 100).toFixed(1) : 0, h2: ht[1] ? +(hs[1] / ht[1] * 100).toFixed(1) : 0 };
}

// RSI 回升/回落后反转信号 + 可选过滤
function rsiSig(loThr, hiThr, opt = {}) {
  const { trend = false, atrMax = 99, atrMin = 0 } = opt;
  const s = [];
  for (let i = 250; i < N - 60; i++) {
    const longOk = !trend || CL[i] > e200[i];
    const shortOk = !trend || CL[i] < e200[i];
    if (atrP[i] > atrMax || atrP[i] < atrMin) continue;
    if (rsi[i - 1] < loThr && rsi[i] >= loThr && longOk) s.push({ i, dir: 'L' });
    else if (rsi[i - 1] > hiThr && rsi[i] <= hiThr && shortOk) s.push({ i, dir: 'S' });
  }
  return s;
}

const configs = [];
for (const [lo, hi] of [[20, 80], [25, 75], [30, 70], [35, 65], [15, 85]])
  for (const trend of [false, true])
    for (const [amn, amx] of [[0, 99], [0, 0.5], [0.5, 1.5], [0, 1.0], [1.0, 3.0]])
      configs.push({ label: `RSI${lo}/${hi}${trend ? '+趋势' : ''} ATR%[${amn},${amx}]`, sig: rsiSig(lo, hi, { trend, atrMin: amn, atrMax: amx }) });

const SLs = [3000, 4000, 6000, 8000, 12000];
const rows = [];
for (const cfg of configs) {
  if (!cfg.sig.length) continue;
  for (const sl of SLs) { const r = bt(cfg.sig, 1000, sl, 48); if (r.n >= 30) rows.push({ label: cfg.label, sl, ...r }); }
}
console.log('=== RSI家族 @ TP=1000/48h：严格命中率最高 且 PF>1 前15 ===');
for (const r of rows.filter(r => r.pf > 1).sort((a, b) => b.strict - a.strict).slice(0, 15))
  console.log(`  ${r.label.padEnd(30)} SL=${String(r.sl).padStart(5)} n=${String(r.n).padStart(4)} 严格=${String(r.strict).padStart(5)}% 宽松=${String(r.winRate).padStart(5)}% PF=${String(r.pf).padStart(5)} 上下半=${r.h1}/${r.h2}`);
console.log('\n=== RSI家族：宽松胜率最高 且 PF>1 前10 ===');
for (const r of rows.filter(r => r.pf > 1).sort((a, b) => b.winRate - a.winRate).slice(0, 10))
  console.log(`  ${r.label.padEnd(30)} SL=${String(r.sl).padStart(5)} n=${String(r.n).padStart(4)} 宽松=${String(r.winRate).padStart(5)}% 严格=${String(r.strict).padStart(5)}% PF=${String(r.pf).padStart(5)} 上下半=${r.h1}/${r.h2}`);
