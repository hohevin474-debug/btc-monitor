// R13: 新约束 TP=1000 + maxHold=48h，最大化胜率（其他不变：仍追高胜率）
// 1) 先测已部署 D-vstate 信号在 48h 的表现（对比 24h）
// 2) 再扫全信号池（双向/只多/只空）× SL，找 48h 下胜率最高且 PF>1 的真实配置
import { readFileSync } from 'node:fs';
const raw = JSON.parse(readFileSync('data/okx_1y_1H.json', 'utf8'));
const C = Array.isArray(raw) ? raw : raw.candles;
const bars = C.map(c => ({ o: +c.open, h: +c.high, l: +c.low, c: +c.close, v: +c.volume })).filter(b => b.c > 0);
const N = bars.length, O = bars.map(b => b.o), H = bars.map(b => b.h), L = bars.map(b => b.l), CL = bars.map(b => b.c), V = bars.map(b => b.v);
function calcEMA(a, p) { const k = 2 / (p + 1); const o = []; let pr; for (let i = 0; i < a.length; i++) { pr = i === 0 ? a[i] : a[i] * k + pr * (1 - k); o.push(pr); } return o; }
const e20 = calcEMA(CL, 20), e50 = calcEMA(CL, 50), e200 = calcEMA(CL, 200);
const rsi = new Array(N).fill(50);
{ let g = 0, l = 0; for (let i = 1; i < N; i++) { const ch = CL[i] - CL[i - 1]; const up = Math.max(0, ch), dn = Math.max(0, -ch); if (i <= 14) { g += up; l += dn; if (i === 14) { g /= 14; l /= 14; } continue; } g = (g * 13 + up) / 14; l = (l * 13 + dn) / 14; rsi[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } }
// sma(TR,24) —— 与已部署 D-vstate 一致的波动率序列
const tr = new Array(N).fill(0);
for (let i = 1; i < N; i++) tr[i] = Math.max(H[i] - L[i], Math.abs(H[i] - CL[i - 1]), Math.abs(L[i] - CL[i - 1]));
const atrS = new Array(N).fill(NaN); { let s = 0; for (let i = 0; i < N; i++) { s += tr[i]; if (i >= 24) s -= tr[i - 24]; if (i >= 23) atrS[i] = s / 24; } }

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
  return { n: total, winRate: total ? +(w / total * 100).toFixed(1) : 0, strict: total ? +(tpc / total * 100).toFixed(1) : 0, pf: +pf.toFixed(2), tp: tpc, slCnt: slc, t: tc, h1: ht[0] ? +(hs[0] / ht[0] * 100).toFixed(1) : 0, h2: ht[1] ? +(hs[1] / ht[1] * 100).toFixed(1) : 0 };
}

// D-vstate 信号（部署版：sma(TR,24) 分位 + EMA20方向 + 斜率门控）
function dvSignals(hi = 0.9, lo = 0.3, slopeGate = 0.8) {
  const s = [];
  const WIN = 120, lb = 12;
  const pctRank = k => { const v = atrS[k]; let c = 0, cnt = 0; for (let j = Math.max(0, k - WIN); j < k; j++) { if (isNaN(atrS[j])) continue; cnt++; if (atrS[j] <= v) c++; } return cnt ? c / cnt : 0.5; };
  for (let i = 260; i < N - 60; i++) {
    if (isNaN(atrS[i])) continue;
    const rN = pctRank(i), rP = pctRank(i - lb);
    if (!(rP >= hi && rN <= lo)) continue;
    const es = (e50[i] - e50[i - 20]) / e50[i - 20] * 100;
    if (Math.abs(es) > slopeGate) continue;
    s.push({ i, dir: CL[i] < e20[i] ? 'L' : 'S' });
  }
  return s;
}

console.log('=== D-vstate 信号：24h vs 48h（TP=1000）===');
const dv = dvSignals();
console.log('D-vstate 全年信号数:', dv.length);
for (const sl of [800, 1500, 2000, 3000]) {
  for (const mh of [24, 48]) {
    const r = bt(dv, 1000, sl, mh);
    console.log(`  SL=${String(sl).padStart(5)} ${mh}h: n=${String(r.n).padStart(3)} 宽松胜率=${String(r.winRate).padStart(5)}% 严格(TP命中)=${String(r.strict).padStart(5)}% PF=${String(r.pf).padStart(5)} TP/SL/T=${r.tp}/${r.sl}/${r.t} 上下半=${r.h1}/${r.h2}`);
  }
}

// 全信号池 × SL @ 48h，找最高宽松胜率且 PF>1
const gens = {};
gens['D-vstate(部署)'] = () => dv;
gens['EMA20上穿 双向'] = () => { const s = []; for (let i = 250; i < N - 60; i++) { const up = CL[i - 1] <= e20[i - 1] && CL[i] > e20[i]; const dn = CL[i - 1] >= e20[i - 1] && CL[i] < e20[i]; if (up) s.push({ i, dir: 'L' }); else if (dn) s.push({ i, dir: 'S' }); } return s; };
gens['EMA50上穿 双向'] = () => { const s = []; for (let i = 250; i < N - 60; i++) { const up = CL[i - 1] <= e50[i - 1] && CL[i] > e50[i]; const dn = CL[i - 1] >= e50[i - 1] && CL[i] < e50[i]; if (up) s.push({ i, dir: 'L' }); else if (dn) s.push({ i, dir: 'S' }); } return s; };
gens['E200趋势 双向'] = () => { const s = []; for (let i = 250; i < N - 60; i++) { const up = CL[i - 1] <= e200[i - 1] && CL[i] > e200[i]; const dn = CL[i - 1] >= e200[i - 1] && CL[i] < e200[i]; if (up) s.push({ i, dir: 'L' }); else if (dn) s.push({ i, dir: 'S' }); } return s; };
gens['RSI20/80回升 双向'] = () => { const s = []; for (let i = 250; i < N - 60; i++) { if (rsi[i - 1] < 20 && rsi[i] >= 20) s.push({ i, dir: 'L' }); else if (rsi[i - 1] > 80 && rsi[i] <= 80) s.push({ i, dir: 'S' }); } return s; };
gens['RSI30/70回升 双向'] = () => { const s = []; for (let i = 250; i < N - 60; i++) { if (rsi[i - 1] < 30 && rsi[i] >= 30) s.push({ i, dir: 'L' }); else if (rsi[i - 1] > 70 && rsi[i] <= 70) s.push({ i, dir: 'S' }); } return s; };
gens['Donchian20突破 双向'] = () => { const s = []; for (let i = 250; i < N - 60; i++) { let hh = -Infinity, ll = Infinity; for (let j = i - 20; j < i; j++) { hh = Math.max(hh, H[j]); ll = Math.min(ll, L[j]); } if (CL[i] > hh) s.push({ i, dir: 'L' }); else if (CL[i] < ll) s.push({ i, dir: 'S' }); } return s; };

const SLs = [800, 1500, 2000, 3000, 4000, 6000, 8000, 12000];
const rows = [];
for (const [name, gen] of Object.entries(gens)) {
  let sigs; try { sigs = gen(); } catch { continue; }
  if (!sigs.length) continue;
  for (const sl of SLs) { const r = bt(sigs, 1000, sl, 48); if (r.n >= 30) rows.push({ name, sl, ...r }); }
}
console.log('\n=== TP=1000 / 48h：宽松胜率最高 且 PF>1 的前12 ===');
for (const r of rows.filter(r => r.pf > 1).sort((a, b) => b.winRate - a.winRate).slice(0, 12))
  console.log(`  ${r.name.padEnd(18)} SL=${String(r.sl).padStart(5)} n=${String(r.n).padStart(3)} 宽松=${String(r.winRate).padStart(5)}% 严格=${String(r.strict).padStart(5)}% PF=${String(r.pf).padStart(5)} 上下半=${r.h1}/${r.h2}`);
console.log('\n=== TP=1000 / 48h：严格胜率(TP命中)最高 且 PF>1 的前8 ===');
for (const r of rows.filter(r => r.pf > 1).sort((a, b) => b.strict - a.strict).slice(0, 8))
  console.log(`  ${r.name.padEnd(18)} SL=${String(r.sl).padStart(5)} n=${String(r.n).padStart(3)} 宽松=${String(r.winRate).padStart(5)}% 严格=${String(r.strict).padStart(5)}% PF=${String(r.pf).padStart(5)} 上下半=${r.h1}/${r.h2}`);
