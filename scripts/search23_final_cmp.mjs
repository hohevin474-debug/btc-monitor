// R23: 最终候选精细对比 —— RSI×斜率2D @跨6EMA24 + 抛物线封顶 + 走步/年度/连亏
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
const EMA = {}; for (const p of [20, 22, 24]) EMA[p] = calcEMAarr(CL, p);
const t4 = (() => { const arr = new Array(N).fill(NaN); let k = 0;
  for (let i = 0; i < N; i++) { while (k + 1 < b4.length && b4[k + 1].ts <= TS[i]) k++; if (k >= 12) arr[i] = (b4[k].c - b4[k - 6].c) / b4[k - 6].c * 100; }
  return arr; })();
const TP = 1000, SL = 3000, MH = 48;

function buildSigs(rsiLo, rsiHi, emaP, slopeMin, slopeMax = 99) {
  const s = []; const e = EMA[emaP];
  for (let i = 260; i < N - 50; i++) {
    if (atrP[i] < 0.3 || atrP[i] > 2.0 || isNaN(t4[i])) continue;
    let dir = null;
    if (rsi1[i - 1] < rsiLo && rsi1[i] >= rsiLo) dir = 'L';
    else if (rsi1[i - 1] > rsiHi && rsi1[i] <= rsiHi) dir = 'S';
    if (!dir) continue;
    if (dir === 'L' && (t4[i] < slopeMin || t4[i] > slopeMax)) continue;
    if (dir === 'S' && (t4[i] > -slopeMin || t4[i] < -slopeMax)) continue;
    if (dir === 'L' && CL[i] > e[i]) continue;
    if (dir === 'S' && CL[i] < e[i]) continue;
    s.push({ i, dir });
  }
  return s;
}
function bt(sigs, span = 6) {
  let w = 0, l = 0, gW = 0, gL = 0, total = 0, tpc = 0, maxLoss = 0, streak = 0, maxStreak = 0;
  let busyUntil = -1; const trades = [];
  for (const sig of sigs) {
    if (sig.i <= busyUntil) continue;
    const i = sig.i, dir = sig.dir, entry = bars[i + 1].o;
    const tpL = dir === 'L' ? entry + TP : entry - TP, slL = dir === 'L' ? entry - SL : entry + SL;
    let ep = 0, rs = ''; const end = Math.min(i + MH, N - 1);
    for (let j = i + 1; j <= end; j++) {
      const hi = bars[j].h, lo = bars[j].l;
      if (dir === 'L') { if (hi >= tpL) { ep = TP; rs = 'TP'; break; } if (lo <= slL) { ep = slL - entry; rs = 'SL'; break; } }
      else { if (lo <= tpL) { ep = TP; rs = 'TP'; break; } if (hi >= slL) { ep = entry - slL; rs = 'SL'; break; } }
    }
    if (!rs) { const last = bars[end].c; ep = dir === 'L' ? last - entry : entry - last; rs = 'TIME'; }
    total++; if (rs === 'TP') tpc++;
    if (ep > 0) { w++; gW += ep; streak = 0; } else { l++; gL += -ep; maxLoss = Math.max(maxLoss, -ep); streak++; maxStreak = Math.max(maxStreak, streak); }
    trades.push({ i, dir, ep, rs });
    busyUntil = end;
  }
  const pf = gL > 0 ? gW / gL : (gW > 0 ? 99 : 0);
  return { n: total, strict: +(tpc / total * 100).toFixed(1), pf: +pf.toFixed(2), maxLoss, maxStreak, trades };
}
const split = Math.floor(N * 0.7);
function detail(r) {
  const tr = r.trades.filter(t => t.i < split), te = r.trades.filter(t => t.i >= split);
  const f = a => a.length ? +(a.filter(x => x.rs === 'TP').length / a.length * 100).toFixed(1) : null;
  const y = {};
  for (const yr of [2025, 2026]) { const a = r.trades.filter(t => new Date(TS[t.i]).getFullYear() === yr); y[yr] = a.length ? +(a.filter(x => x.rs === 'TP').length / a.length * 100).toFixed(1) : null; y[yr + 'N'] = a.length; }
  const net = r.trades.reduce((a, t) => a + t.ep, 0) - r.n * 120;
  return `走步 ${f(tr)}%(${tr.length})→${f(te)}%(${te.length}) | 年度 25:${y[2025]}%(${y[2025 + 'N']}) 26:${y[2026]}%(${y[2026 + 'N']}) | 净盈 ${net.toFixed(0)}`;
}

// ===== 1. RSI × 斜率 2D @ 跨6 EMA24 =====
console.log('=== RSI阈值 × 斜率 2D（跨6 EMA24 ATR[0.3,2] 非重叠）：严格%(n) ===');
const rsis = [[38, 62], [40, 60], [41, 59], [42, 58], [43, 57], [44, 56]];
const sts = [0.4, 0.5, 0.6, 0.7, 0.8];
process.stdout.write('          ');
for (const st of sts) process.stdout.write(`斜${st}`.padStart(15));
console.log();
for (const [lo, hi] of rsis) {
  process.stdout.write(`RSI${lo}/${hi}`.padEnd(10));
  for (const st of sts) {
    const r = bt(buildSigs(lo, hi, 24, st));
    process.stdout.write(`${r.strict}%(${r.n})`.padStart(15));
  }
  console.log();
}

// ===== 2. 抛物线封顶（slopeMax）测试 =====
console.log('\n=== 抛物线封顶：EMA24 跨6 RSI42/58 斜0.6 + 上限 ===');
for (const mx of [99, 4, 3.5, 3, 2.5, 2]) {
  const r = bt(buildSigs(42, 58, 24, 0.6, mx));
  console.log(`  上限${mx}%: ${r.strict}%(n${r.n},PF${r.pf},连亏${r.maxStreak}) | ${detail(r)}`);
}
console.log('=== 抛物线封顶：斜0.5 + 上限 ===');
for (const mx of [99, 3.5, 3, 2.5]) {
  const r = bt(buildSigs(42, 58, 24, 0.5, mx));
  console.log(`  上限${mx}%: ${r.strict}%(n${r.n},PF${r.pf},连亏${r.maxStreak}) | ${detail(r)}`);
}

// ===== 3. 最终候选对比 =====
console.log('\n=== 最终候选全指标对比 ===');
const cands = [
  { name: '基线(现部署) RSI42/58 EMA20 斜0.3', lo: 42, hi: 58, emaP: 20, st: 0.3 },
  { name: 'C1 RSI42/58 EMA24 斜0.5', lo: 42, hi: 58, emaP: 24, st: 0.5 },
  { name: 'C2 RSI42/58 EMA24 斜0.6', lo: 42, hi: 58, emaP: 24, st: 0.6 },
  { name: 'C3 RSI42/58 EMA22 斜0.6', lo: 42, hi: 58, emaP: 22, st: 0.6 },
  { name: 'C4 RSI42/58 EMA20 斜0.6', lo: 42, hi: 58, emaP: 20, st: 0.6 },
  { name: 'C5 RSI42/58 EMA24 斜0.7', lo: 42, hi: 58, emaP: 24, st: 0.7 },
  { name: 'C6 RSI43/57 EMA24 斜0.6', lo: 43, hi: 57, emaP: 24, st: 0.6 },
  { name: 'C7 RSI40/60 EMA24 斜0.6', lo: 40, hi: 60, emaP: 24, st: 0.6 },
];
for (const c of cands) {
  const r = bt(buildSigs(c.lo, c.hi, c.emaP, c.st));
  console.log(`  ${c.name.padEnd(36)} n=${String(r.n).padStart(3)} 严格=${String(r.strict).padStart(5)}% PF=${String(r.pf).padStart(5)} 连亏=${r.maxStreak} | ${detail(r)}`);
}

// ===== 4. C2/C3 的逐笔亏损明细 =====
for (const c of [{ name: 'C2 EMA24 斜0.6', lo: 42, hi: 58, emaP: 24, st: 0.6 }, { name: 'C3 EMA22 斜0.6', lo: 42, hi: 58, emaP: 22, st: 0.6 }]) {
  const r = bt(buildSigs(c.lo, c.hi, c.emaP, c.st));
  console.log(`\n=== ${c.name} 亏损明细（共 ${r.trades.filter(t => t.ep <= 0).length} 笔）===`);
  for (const t of r.trades.filter(t => t.ep <= 0))
    console.log(`  ${new Date(TS[t.i]).toISOString().slice(0, 13)} ${t.dir.padEnd(5)} ${t.rs} ${t.ep.toFixed(0)}点`);
}
