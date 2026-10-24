// R21: 部署策略参数邻域全扫描 —— 全量2年4H数据(5040根, 2024-07→2026-10)
// 口径：线上非重叠 + 下一根开盘价入场 + TP1000/SL3000/48h + 当根4H(含未收盘)
// 网格：RSI阈值 × EMA周期 × 4H斜率跨度 × 4H斜率阈值 × ATR带
import { readFileSync } from 'fs';

const h1 = JSON.parse(readFileSync('data/okx_2y_1H.json', 'utf8')).candles;
const h4 = JSON.parse(readFileSync('data/okx_2y_4H.json', 'utf8')).candles;
const bars = h1.map(c => ({ ts: c.ts, o: +c.open, h: +c.high, l: +c.low, c: +c.close, v: +c.volume })).filter(b => b.c > 0);
const b4 = h4.map(c => ({ ts: c.ts, c: +c.close })).filter(b => b.c > 0);

const N = bars.length, H = bars.map(b => b.h), L = bars.map(b => b.l), CL = bars.map(b => b.c), TS = bars.map(b => b.ts);
console.log(`1H: ${N} 根 (${new Date(TS[0]).toISOString().slice(0, 10)}→${new Date(TS[N - 1]).toISOString().slice(0, 10)})  4H: ${b4.length} 根`);

// —— 预计算指标（与部署版 byte-for-byte 一致：Wilder RSI/ATR、SMA-init EMA）——
const rsi1 = new Array(N).fill(50);
{ let g = 0, l = 0;
  for (let i = 1; i < N; i++) {
    const ch = CL[i] - CL[i - 1]; const u = Math.max(0, ch), d = Math.max(0, -ch);
    if (i <= 14) { g += u; l += d; if (i === 14) { g /= 14; l /= 14; } continue; }
    g = (g * 13 + u) / 14; l = (l * 13 + d) / 14;
    rsi1[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  } }
const atrP = new Array(N).fill(0);
{ let p = 0;
  for (let i = 1; i < N; i++) {
    const t = Math.max(H[i] - L[i], Math.abs(H[i] - CL[i - 1]), Math.abs(L[i] - CL[i - 1]));
    p = i === 1 ? t : (p * 13 + t) / 14;
    atrP[i] = p / CL[i] * 100;
  } }
function calcEMAarr(a, p) { const k = 2 / (p + 1); const o = []; let pr; for (let i = 0; i < a.length; i++) { pr = i === 0 ? a[i] : a[i] * k + pr * (1 - k); o.push(pr); } return o; }
const EMA = {}; for (const p of [16, 18, 20, 22, 24]) EMA[p] = calcEMAarr(CL, p);
// 4H 斜率（当根4H含未收盘）各跨度
const T4 = {};
for (const span of [4, 5, 6, 7, 8]) {
  const arr = new Array(N).fill(NaN); let k = 0;
  for (let i = 0; i < N; i++) {
    while (k + 1 < b4.length && b4[k + 1].ts <= TS[i]) k++;
    if (k >= span * 2) arr[i] = (b4[k].c - b4[k - span].c) / b4[k - span].c * 100;
  }
  T4[span] = arr;
}
// 4H EMA20 位置（追加门控候选）
const e20_4 = calcEMAarr(b4.map(b => b.c), 20);
const T4EMA = new Array(N).fill(NaN);
{ let k = 0; for (let i = 0; i < N; i++) { while (k + 1 < b4.length && b4[k + 1].ts <= TS[i]) k++; if (k >= 20) T4EMA[i] = b4[k].c - e20_4[k]; } }
// 回调深度（价低于EMA20的幅度%，追加门控候选）
const PB = {}; for (const p of [20]) PB[p] = CL.map((c, i) => (c - EMA[p][i]) / EMA[p][i] * 100);

const TP = 1000, SL = 3000, MH = 48;

function buildSigs(rsiLo, rsiHi, emaP, span, slopeThr, amn, amx, extra = {}) {
  const s = [];
  const e = EMA[emaP], t4 = T4[span];
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
    // 追加门控
    if (extra.t4ema && dir === 'L' && !(T4EMA[i] > 0)) continue;
    if (extra.t4ema && dir === 'S' && !(T4EMA[i] < 0)) continue;
    if (extra.pbMin != null && dir === 'L' && PB[20][i] > -extra.pbMin) continue;   // 价至少低于EMA20 pbMin%
    if (extra.pbMin != null && dir === 'S' && PB[20][i] < extra.pbMin) continue;
    s.push({ i, dir });
  }
  return s;
}

function bt(sigs) {
  let w = 0, l = 0, gW = 0, gL = 0, total = 0, tpc = 0, maxLoss = 0, maxLossStreak = 0, curStreak = 0;
  let busyUntil = -1;
  const trades = [];
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
    if (ep > 0) { w++; gW += ep; curStreak = 0; } else { l++; gL += -ep; maxLoss = Math.max(maxLoss, -ep); curStreak++; maxLossStreak = Math.max(maxLossStreak, curStreak); }
    trades.push({ i, dir, entry, ep, rs });
    busyUntil = end;
  }
  const pf = gL > 0 ? gW / gL : (gW > 0 ? 99 : 0);
  return { n: total, strict: +(tpc / total * 100).toFixed(1), pf: +pf.toFixed(2), maxLoss: +maxLoss.toFixed(0), maxLossStreak, trades };
}

const split = Math.floor(N * 0.7);
function wf(trades) {
  const tr = trades.filter(t => t.i < split), te = trades.filter(t => t.i >= split);
  const f = a => a.length ? +(a.filter(x => x.rs === 'TP').length / a.length * 100).toFixed(1) : null;
  return { trS: f(tr), trN: tr.length, teS: f(te), teN: te.length };
}
function yearly(trades) {
  const o = {};
  for (const yr of [2024, 2025, 2026]) {
    const arr = trades.filter(t => new Date(TS[t.i]).getFullYear() === yr);
    o[yr] = arr.length ? +(arr.filter(x => x.rs === 'TP').length / arr.length * 100).toFixed(1) : null;
    o[yr + 'N'] = arr.length;
  }
  return o;
}

// —— 基线核对 ——
{
  const r = bt(buildSigs(42, 58, 20, 6, 0.3, 0.3, 2.0));
  console.log(`\n[基线核对] 部署配置: n=${r.n} 严格=${r.strict}% PF=${r.pf} 最大亏=${r.maxLoss} 连亏=${r.maxLossStreak}`);
}

// —— 网格扫描 ——
const grid = [];
for (const [lo, hi] of [[38, 62], [40, 60], [41, 59], [42, 58], [43, 57], [44, 56], [35, 65], [30, 70]])
  for (const emaP of [16, 18, 20, 22, 24])
    for (const span of [4, 5, 6, 7, 8])
      for (const st of [0.1, 0.2, 0.3, 0.4, 0.5])
        for (const [amn, amx] of [[0.3, 2.0], [0.4, 1.8], [0.5, 1.5]])
          grid.push({ lo, hi, emaP, span, st, amn, amx });

console.log(`\n网格共 ${grid.length} 个配置，扫描中...`);
const t0 = Date.now();
const rows = [];
for (const g of grid) {
  const sigs = buildSigs(g.lo, g.hi, g.emaP, g.span, g.st, g.amn, g.amx);
  const r = bt(sigs);
  rows.push({ cfg: `RSI${g.lo}/${g.hi} EMA${g.emaP} 跨${g.span} 斜${g.st} ATR[${g.amn},${g.amx}]`, ...g, ...r });
}
console.log(`扫描完成，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// 过滤：严格≥90 且 n≥60
const pass = rows.filter(r => r.strict >= 90 && r.n >= 60);
console.log(`\n严格≥90% 且 n≥60 的配置: ${pass.length} 个`);
console.log('=== 按 PF 排序 前20 ===');
for (const r of pass.sort((a, b) => b.pf - a.pf).slice(0, 20)) {
  const w = wf(r.trades), y = yearly(r.trades);
  console.log(`  ${r.cfg.padEnd(42)} n=${String(r.n).padStart(3)} 严格=${String(r.strict).padStart(5)}% PF=${String(r.pf).padStart(5)} 连亏=${r.maxLossStreak} | 走步 ${w.trS}%→${w.teS}%(n${w.teN}) | 年度 ${y[2025] ?? '-'}%/${y[2026] ?? '-'}%`);
}

// 若没有严格≥90且n≥60的，放宽看严格≥88的
if (pass.length < 5) {
  const near = rows.filter(r => r.strict >= 88 && r.n >= 60);
  console.log(`\n=== 严格≥88% 且 n≥60（按严格排序前15）===`);
  for (const r of near.sort((a, b) => b.strict - a.strict).slice(0, 15)) {
    const w = wf(r.trades), y = yearly(r.trades);
    console.log(`  ${r.cfg.padEnd(42)} n=${String(r.n).padStart(3)} 严格=${String(r.strict).padStart(5)}% PF=${String(r.pf).padStart(5)} 连亏=${r.maxLossStreak} | 走步 ${w.trS}%→${w.teS}%(n${w.teN}) | 年度 ${y[2025] ?? '-'}%/${y[2026] ?? '-'}%`);
  }
}

// 高原分析：以基线为中心，看每个维度单独变化时严格命中率分布
console.log('\n=== 高原分析（基线 RSI42/58 EMA20 跨6 斜0.3，单维度变化）===');
const base = { lo: 42, hi: 58, emaP: 20, span: 6, st: 0.3, amn: 0.3, amx: 2.0 };
for (const dim of ['lo', 'emaP', 'span', 'st']) {
  const vals = [...new Set(grid.map(g => g[dim]))].sort((a, b) => a - b);
  const line = vals.map(v => {
    const g = { ...base, [dim]: v };
    // lo/hi 联动
    if (dim === 'lo') { const d = v - 42; g.hi = 58 - d; }
    const r = bt(buildSigs(g.lo, g.hi, g.emaP, g.span, g.st, g.amn, g.amx));
    return `${v}:${r.strict}%(n${r.n})`;
  }).join('  ');
  console.log(`  ${dim}: ${line}`);
}
for (const [amn, amx] of [[0.3, 2.0], [0.4, 1.8], [0.5, 1.5], [0.2, 2.5], [0.6, 1.2]]) {
  const r = bt(buildSigs(base.lo, base.hi, base.emaP, base.span, base.st, amn, amx));
  console.log(`  ATR[${amn},${amx}]: ${r.strict}%(n${r.n}) PF${r.pf}`);
}
