// R23b: 最终配置稳健性终检 —— 封顶灵敏度 × RSI邻域 × SL敏感性 × 逐笔核对
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
const t4 = (() => { const arr = new Array(N).fill(NaN); let k = 0;
  for (let i = 0; i < N; i++) { while (k + 1 < b4.length && b4[k + 1].ts <= TS[i]) k++; if (k >= 12) arr[i] = (b4[k].c - b4[k - 6].c) / b4[k - 6].c * 100; }
  return arr; })();

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
function bt(sigs, tp = 1000, sl = 3000) {
  let w = 0, l = 0, gW = 0, gL = 0, total = 0, tpc = 0, maxLoss = 0, streak = 0, maxStreak = 0;
  let busyUntil = -1; const trades = []; const mh = 48;
  for (const sig of sigs) {
    if (sig.i <= busyUntil) continue;
    const i = sig.i, dir = sig.dir, entry = bars[i + 1].o;
    const tpL = dir === 'L' ? entry + tp : entry - tp, slL = dir === 'L' ? entry - sl : entry + sl;
    let ep = 0, rs = ''; const end = Math.min(i + mh, N - 1);
    for (let j = i + 1; j <= end; j++) {
      const hi = bars[j].h, lo = bars[j].l;
      if (dir === 'L') { if (hi >= tpL) { ep = tp; rs = 'TP'; break; } if (lo <= slL) { ep = slL - entry; rs = 'SL'; break; } }
      else { if (lo <= tpL) { ep = tp; rs = 'TP'; break; } if (hi >= slL) { ep = entry - slL; rs = 'SL'; break; } }
    }
    if (!rs) { const last = bars[end].c; ep = dir === 'L' ? last - entry : entry - last; rs = 'TIME'; }
    total++; if (rs === 'TP') tpc++;
    if (ep > 0) { w++; gW += ep; streak = 0; } else { l++; gL += -ep; maxLoss = Math.max(maxLoss, -ep); streak++; maxStreak = Math.max(maxStreak, streak); }
    trades.push({ i, dir, ep, rs, slope: t4[i] });
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
  return `走步 ${f(tr)}%(${tr.length})→${f(te)}%(${te.length}) | 25年${y[2025]}%(${y[2025 + 'N']}) 26年${y[2026]}%(${y[2026 + 'N']}) | 净盈${net.toFixed(0)}`;
}

// ===== 1. 封顶灵敏度 × RSI 邻域（EMA24 跨6 斜0.6）=====
console.log('=== 封顶上限 × RSI（EMA24 跨6 斜0.6）：严格%(n,PF) ===');
const caps = [99, 3, 2.75, 2.5, 2.25, 2];
process.stdout.write('          ');
for (const c of caps) process.stdout.write(`上限${c}`.padStart(20));
console.log();
for (const [lo, hi] of [[38, 62], [40, 60], [41, 59], [42, 58], [43, 57]]) {
  process.stdout.write(`RSI${lo}/${hi}`.padEnd(10));
  for (const c of caps) {
    const r = bt(buildSigs(lo, hi, 24, 0.6, c));
    process.stdout.write(`${r.strict}%(${r.n},${r.pf})`.padStart(20));
  }
  console.log();
}

// ===== 2. SL 敏感性（RSI42/58 EMA24 斜0.6 上限2.5）=====
console.log('\n=== SL 敏感性（RSI42/58 EMA24 跨6 斜0.6 上限2.5）===');
for (const sl of [1500, 2000, 2500, 3000, 4000, 5000]) {
  const r = bt(buildSigs(42, 58, 24, 0.6, 2.5), 1000, sl);
  console.log(`  SL=${sl}: ${r.strict}%(n${r.n},PF${r.pf},最大亏${r.maxLoss}) | ${detail(r)}`);
}

// ===== 3. TP 敏感性（确认不是只对1000点特殊）=====
console.log('\n=== TP 敏感性（同上，SL=3000）===');
for (const tp of [800, 1000, 1200, 1500]) {
  const r = bt(buildSigs(42, 58, 24, 0.6, 2.5), tp, 3000);
  console.log(`  TP=${tp}: ${r.strict}%(n${r.n},PF${r.pf})`);
}

// ===== 4. 最终配置逐笔核对（RSI42/58 EMA24 斜0.6 上限2.5）=====
const fin = bt(buildSigs(42, 58, 24, 0.6, 2.5));
console.log(`\n=== 最终配置逐笔（n=${fin.n}, 严格=${fin.strict}%, 连亏最多${fin.maxStreak}）===`);
for (const t of fin.trades) {
  const d = new Date(TS[t.i]);
  console.log(`  ${d.toISOString().slice(0, 13)} ${t.dir.padEnd(5)} 斜率=${t.slope.toFixed(2).padStart(6)} ${t.rs.padEnd(4)} ${t.ep >= 0 ? '+' : ''}${t.ep.toFixed(0)}`);
}

// ===== 5. 半样本稳健性：前后各一年单独看 =====
console.log('\n=== 前后各一年单独检验（最终配置）===');
const oneYear = Math.floor(N / 2);
for (const [name, from, to] of [['第一年', 0, oneYear], ['第二年', oneYear, N]]) {
  const sigs = buildSigs(42, 58, 24, 0.6, 2.5).filter(s => s.i >= from && s.i < to);
  const r = bt(sigs);
  console.log(`  ${name}: n=${r.n} 严格=${r.strict}% PF=${r.pf} 最大亏=${r.maxLoss} 连亏=${r.maxStreak}`);
}
