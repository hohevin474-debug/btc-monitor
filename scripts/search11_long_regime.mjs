// R11: 只做多 + 趋势regime过滤 + 信号投票，冲击 90% 胜率（TP=1000, ≤24h）
// 同时输出「严格胜率(只算TP命中)」与「宽止损胜率前沿」，定位真实可达边界。
import { readFileSync } from 'node:fs';

const raw = JSON.parse(readFileSync('data/okx_1y_1H.json', 'utf8'));
const C = Array.isArray(raw) ? raw : raw.candles;
const bars = C.map(c => ({ t: c.ts, o: +c.open, h: +c.high, l: +c.low, c: +c.close, v: +c.volume })).filter(b => b.c > 0);
const N = bars.length;
const O = bars.map(b => b.o), H = bars.map(b => b.h), L = bars.map(b => b.l), CL = bars.map(b => b.c), V = bars.map(b => b.v);
function calcEMA(a, p) { const k = 2 / (p + 1); const o = []; let pr; for (let i = 0; i < a.length; i++) { pr = i === 0 ? a[i] : a[i] * k + pr * (1 - k); o.push(pr); } return o; }
const e20 = calcEMA(CL, 20), e50 = calcEMA(CL, 50), e200 = calcEMA(CL, 200);
const rsi = new Array(N).fill(50);
{ let g = 0, l = 0; for (let i = 1; i < N; i++) { const ch = CL[i] - CL[i - 1]; const up = Math.max(0, ch), dn = Math.max(0, -ch); if (i <= 14) { g += up; l += dn; if (i === 14) { g /= 14; l /= 14; } continue; } g = (g * 13 + up) / 14; l = (l * 13 + dn) / 14; rsi[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } }
const TP = 1000, MAXHOLD = 24;

function backtest(sigs, sl, strictWin = false) {
  let w = 0, l = 0, gW = 0, gL = 0, total = 0, tp = 0, slc = 0, tc = 0;
  const hs = [0, 0], ht = [0, 0]; const half = Math.floor(N / 2);
  for (const sig of sigs) {
    const i = sig.i, dir = sig.dir, entry = bars[i + 1].o; if (!entry) continue;
    const tpL = dir === 'L' ? entry + TP : entry - TP;
    const slL = dir === 'L' ? entry - sl : entry + sl;
    let ep = 0, reason = ''; const end = Math.min(i + MAXHOLD, N - 1);
    for (let j = i + 1; j <= end; j++) {
      const hi = bars[j].h, lo = bars[j].l;
      if (dir === 'L') { if (hi >= tpL) { ep = TP; reason = 'TP'; break; } if (lo <= slL) { ep = slL - entry; reason = 'SL'; break; } }
      else { if (lo <= tpL) { ep = TP; reason = 'TP'; break; } if (hi >= slL) { ep = entry - slL; reason = 'SL'; break; } }
    }
    if (!reason) { const last = bars[end].c; ep = dir === 'L' ? last - entry : entry - last; reason = 'T'; }
    total++;
    if (reason === 'TP') tp++; else if (reason === 'SL') slc++; else tc++;
    const seg = sig.i < half ? 0 : 1;
    const isWin = strictWin ? reason === 'TP' : ep > 0;
    if (isWin) { w++; if (strictWin) gW += TP; else gW += ep; hs[seg]++; } else { const lss = strictWin ? (reason === 'SL' ? sl : Math.abs(ep)) : Math.abs(ep); l++; gL += lss; }
    ht[seg]++;
  }
  const pf = gL > 0 ? gW / gL : (gW > 0 ? 99 : 0);
  return { n: total, winRate: total ? +(w / total * 100).toFixed(1) : 0, pf: +pf.toFixed(2), tp, slc, tc, h1: ht[0] ? +(hs[0] / ht[0] * 100).toFixed(1) : 0, h2: ht[1] ? +(hs[1] / ht[1] * 100).toFixed(1) : 0 };
}

// 信号生成（含 regime/方向过滤）
const gens = {};
// EMA20 穿越（原始双向）
gens['EMA20穿越 双向'] = () => { const s = []; for (let i = 250; i < N - 30; i++) { const up = CL[i - 1] <= e20[i - 1] && CL[i] > e20[i]; const dn = CL[i - 1] >= e20[i - 1] && CL[i] < e20[i]; if (up) s.push({ i, dir: 'L' }); else if (dn) s.push({ i, dir: 'S' }); } return s; };
// EMA20 上穿 只做多
gens['EMA20上穿 只做多'] = () => { const s = []; for (let i = 250; i < N - 30; i++) if (CL[i - 1] <= e20[i - 1] && CL[i] > e20[i]) s.push({ i, dir: 'L' }); return s; };
// EMA50 上穿 只做多
gens['EMA50上穿 只做多'] = () => { const s = []; for (let i = 250; i < N - 30; i++) if (CL[i - 1] <= e50[i - 1] && CL[i] > e50[i]) s.push({ i, dir: 'L' }); return s; };
// 价格站上 EMA200 后回踩 EMA20 只做多
gens['E200趋势+回踩E20 只多'] = () => { const s = []; for (let i = 250; i < N - 30; i++) if (CL[i] > e200[i] && CL[i - 1] <= e20[i - 1] && CL[i] > e20[i]) s.push({ i, dir: 'L' }); return s; };
// 站上 EMA200 且 EMA20>EMA50 时 EMA20 上穿（强趋势顺势）
gens['强趋势顺势 只多'] = () => { const s = []; for (let i = 250; i < N - 30; i++) if (CL[i] > e200[i] && e20[i] > e50[i] && CL[i - 1] <= e20[i - 1] && CL[i] > e20[i]) s.push({ i, dir: 'L' }); return s; };
// RSI 从超卖回升 只做多
gens['RSI20回升 只多'] = () => { const s = []; for (let i = 250; i < N - 30; i++) if (rsi[i - 1] < 20 && rsi[i] >= 20 && CL[i] > e200[i]) s.push({ i, dir: 'L' }); return s; };
gens['RSI30回升 只多'] = () => { const s = []; for (let i = 250; i < N - 30; i++) if (rsi[i - 1] < 30 && rsi[i] >= 30 && CL[i] > e200[i]) s.push({ i, dir: 'L' }); return s; };
// 站上 EMA200 后 Donchian20 突破 只多
gens['E200+Donchian20 只多'] = () => { const s = []; for (let i = 250; i < N - 30; i++) { let hh = -Infinity; for (let j = i - 20; j < i; j++) hh = Math.max(hh, H[j]); if (CL[i] > e200[i] && CL[i] > hh) s.push({ i, dir: 'L' }); } return s; };
// EMA200 上方 且 EMA20 上穿 EMA50 只多
gens['E200+金叉20/50 只多'] = () => { const s = []; for (let i = 250; i < N - 30; i++) if (CL[i] > e200[i] && e20[i - 1] <= e50[i - 1] && e20[i] > e50[i]) s.push({ i, dir: 'L' }); return s; };

const SLs = [1500, 2000, 2500, 3000, 4000, 5000, 6000, 8000, 10000, 15000];
console.log('=== 只做多 + 趋势过滤：胜率前沿（TP=1000, ≤24h, 严格胜率=只算TP命中）===\n');
const all = [];
for (const [name, gen] of Object.entries(gens)) {
  let sigs; try { sigs = gen(); } catch { continue; }
  if (!sigs.length) continue;
  for (const sl of SLs) {
    const gen_r = backtest(sigs, sl, false);
    const str_r = backtest(sigs, sl, true);
    all.push({ name, sl, ...gen_r, strictWinRate: str_r.winRate, strictPF: str_r.pf });
  }
  // 打印该信号宽松胜率最优
  const best = all.filter(r => r.name === name && r.n >= 20).sort((a, b) => b.winRate - a.winRate)[0];
  if (best) console.log(`${name.padEnd(22)} 最优SL=${String(best.sl).padStart(6)} n=${String(best.n).padStart(4)} 宽松胜率=${String(best.winRate).padStart(5)}% (严格=${best.strictWinRate}%) PF=${String(best.pf).padStart(5)}/严格${best.strictPF} TP/SL/T=${best.tp}/${best.slc}/${best.tc} 上下半=${best.h1}/${best.h2}`);
}

console.log('\n=== 达标（宽松胜率≥90 & PF>1 & n≥20）===');
const pass = all.filter(r => r.winRate >= 90 && r.pf > 1 && r.n >= 20).sort((a, b) => b.pf - a.pf);
if (!pass.length) {
  console.log('仍无。展示宽松胜率≥75 的（按胜率）：');
  for (const r of all.filter(r => r.winRate >= 75 && r.n >= 20).sort((a, b) => b.winRate - a.winRate).slice(0, 20))
    console.log(`  ${r.name.padEnd(22)} SL=${String(r.sl).padStart(6)} n=${String(r.n).padStart(4)} 胜率=${String(r.winRate).padStart(5)}% PF=${String(r.pf).padStart(5)} 严格=${r.strictWinRate}% 上下半=${r.h1}/${r.h2}`);
} else {
  for (const r of pass) console.log(`  ${r.name.padEnd(22)} SL=${String(r.sl).padStart(6)} n=${String(r.n).padStart(4)} 胜率=${r.winRate}% PF=${r.pf} 严格=${r.strictWinRate}% 上下半=${r.h1}/${r.h2}`);
}
