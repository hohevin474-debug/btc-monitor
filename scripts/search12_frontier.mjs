// R12: 三条放松路径的真实最优策略（非神谕）
// A: 保1000点+≤1天 → 追最高胜率(上限79.6%)
// B: 保90%胜率+≤1天 → 降目标到~700点
// C: 保90%胜率+1000点 → 放宽到48h
import { readFileSync } from 'node:fs';
const raw = JSON.parse(readFileSync('data/okx_1y_1H.json', 'utf8'));
const C = Array.isArray(raw) ? raw : raw.candles;
const bars = C.map(c => ({ o: +c.open, h: +c.high, l: +c.low, c: +c.close, v: +c.volume })).filter(b => b.c > 0);
const N = bars.length, CL = bars.map(b => b.c), H = bars.map(b => b.h), L = bars.map(b => b.l), V = bars.map(b => b.v);
function calcEMA(a, p) { const k = 2 / (p + 1); const o = []; let pr; for (let i = 0; i < a.length; i++) { pr = i === 0 ? a[i] : a[i] * k + pr * (1 - k); o.push(pr); } return o; }
const e20 = calcEMA(CL, 20), e50 = calcEMA(CL, 50), e200 = calcEMA(CL, 200);
const rsi = new Array(N).fill(50);
{ let g = 0, l = 0; for (let i = 1; i < N; i++) { const ch = CL[i] - CL[i - 1]; const up = Math.max(0, ch), dn = Math.max(0, -ch); if (i <= 14) { g += up; l += dn; if (i === 14) { g /= 14; l /= 14; } continue; } g = (g * 13 + up) / 14; l = (l * 13 + dn) / 14; rsi[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } }

// 信号生成器（只做多系列 + 双向）
const gens = {};
gens['EMA20上穿 双向'] = () => { const s = []; for (let i = 250; i < N - 60; i++) { const up = CL[i - 1] <= e20[i - 1] && CL[i] > e20[i]; const dn = CL[i - 1] >= e20[i - 1] && CL[i] < e20[i]; if (up) s.push({ i, dir: 'L' }); else if (dn) s.push({ i, dir: 'S' }); } return s; };
gens['EMA20上穿 只多'] = () => { const s = []; for (let i = 250; i < N - 60; i++) if (CL[i - 1] <= e20[i - 1] && CL[i] > e20[i]) s.push({ i, dir: 'L' }); return s; };
gens['EMA50上穿 只多'] = () => { const s = []; for (let i = 250; i < N - 60; i++) if (CL[i - 1] <= e50[i - 1] && CL[i] > e50[i]) s.push({ i, dir: 'L' }); return s; };
gens['E200趋势+回踩E20 只多'] = () => { const s = []; for (let i = 250; i < N - 60; i++) if (CL[i] > e200[i] && CL[i - 1] <= e20[i - 1] && CL[i] > e20[i]) s.push({ i, dir: 'L' }); return s; };
gens['E200+Donchian20 只多'] = () => { const s = []; for (let i = 250; i < N - 60; i++) { let hh = -Infinity; for (let j = i - 20; j < i; j++) hh = Math.max(hh, H[j]); if (CL[i] > e200[i] && CL[i] > hh) s.push({ i, dir: 'L' }); } return s; };
gens['RSI20回升+E200 只多'] = () => { const s = []; for (let i = 250; i < N - 60; i++) if (rsi[i - 1] < 20 && rsi[i] >= 20 && CL[i] > e200[i]) s.push({ i, dir: 'L' }); return s; };
gens['RSI30回升+E200 只多'] = () => { const s = []; for (let i = 250; i < N - 60; i++) if (rsi[i - 1] < 30 && rsi[i] >= 30 && CL[i] > e200[i]) s.push({ i, dir: 'L' }); return s; };
gens['EMA20下穿 双向'] = () => { const s = []; for (let i = 250; i < N - 60; i++) { const up = CL[i - 1] <= e20[i - 1] && CL[i] > e20[i]; const dn = CL[i - 1] >= e20[i - 1] && CL[i] < e20[i]; if (up) s.push({ i, dir: 'L' }); else if (dn) s.push({ i, dir: 'S' }); } return s; };

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
  return { n: total, winRate: total ? +(w / total * 100).toFixed(1) : 0, pf: +pf.toFixed(2), tp: tpc, sl: slc, t: tc, h1: ht[0] ? +(hs[0] / ht[0] * 100).toFixed(1) : 0, h2: ht[1] ? +(hs[1] / ht[1] * 100).toFixed(1) : 0 };
}

const SLs = [1000, 1500, 2000, 3000, 4000, 6000, 8000, 12000];
function bestFor(tp, mh, targetWR) {
  let best = null;
  for (const [name, gen] of Object.entries(gens)) {
    let sigs; try { sigs = gen(); } catch { continue; }
    if (!sigs.length) continue;
    for (const sl of SLs) {
      const r = bt(sigs, tp, sl, mh);
      if (r.n < 30 || r.pf <= 1) continue;
      const score = targetWR ? (r.winRate - Math.abs(r.winRate - targetWR)) : r.winRate; // 靠近目标或越高越好
      if (!best || r.winRate > best.r.winRate) best = { name, sl, r };
    }
  }
  return best;
}

for (const [label, tp, mh, target] of [
  ['A: 1000点/≤1天 追最高胜率(神谕上限79.6%)', 1000, 24, 79.6],
  ['B: ~700点/≤1天 冲90%胜率(神谕上限91.5%)', 700, 24, 90],
  ['C: 1000点/48h 冲90%胜率(神谕上限94.2%)', 1000, 48, 90],
]) {
  console.log(`\n=== ${label} ===`);
  const b = bestFor(tp, mh, target);
  if (b) console.log(`  最优: ${b.name} | SL=${b.sl} | n=${b.r.n} 胜率=${b.r.winRate}% PF=${b.r.pf} | TP/SL/T=${b.r.tp}/${b.r.sl}/${b.r.t} 上下半=${b.r.h1}/${b.r.h2}`);
  else console.log('  无 PF>1 的组合');
}
