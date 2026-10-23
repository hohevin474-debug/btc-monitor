// R16: 多周期(4H定向+1H入场) + ensemble 投票 + 走步验证，冲击更高严格命中率 @ TP=1000/48h
import { readFileSync } from 'node:fs';
const h1 = JSON.parse(readFileSync('data/okx_1y_1H.json', 'utf8'));
const h4 = JSON.parse(readFileSync('data/okx_2y_4H.json', 'utf8'));
const C1 = Array.isArray(h1) ? h1 : h1.candles;
const C4 = Array.isArray(h4) ? h4 : h4.candles;
const bars = C1.map(c => ({ ts: c.ts, o: +c.open, h: +c.high, l: +c.low, c: +c.close, v: +c.volume })).filter(b => b.c > 0);
const N = bars.length, H = bars.map(b => b.h), L = bars.map(b => b.l), CL = bars.map(b => b.c), V = bars.map(b => b.v), TS = bars.map(b => b.ts);
function calcEMAarr(a, p) { const k = 2 / (p + 1); const o = []; let pr; for (let i = 0; i < a.length; i++) { pr = i === 0 ? a[i] : a[i] * k + pr * (1 - k); o.push(pr); } return o; }

// 1H 指标
const rsi1 = new Array(N).fill(50);
{ let g = 0, l = 0; for (let i = 1; i < N; i++) { const ch = CL[i] - CL[i - 1]; const u = Math.max(0, ch), d = Math.max(0, -ch); if (i <= 14) { g += u; l += d; if (i === 14) { g /= 14; l /= 14; } continue; } g = (g * 13 + u) / 14; l = (l * 13 + d) / 14; rsi1[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } }
const atrP = new Array(N).fill(0);
{ let p = 0; for (let i = 1; i < N; i++) { const t = Math.max(H[i] - L[i], Math.abs(H[i] - CL[i - 1]), Math.abs(L[i] - CL[i - 1])); p = i === 1 ? t : (p * 13 + t) / 14; atrP[i] = p / CL[i] * 100; } }
const volSma = new Array(N).fill(0);
{ let s = 0; for (let i = 0; i < N; i++) { s += V[i]; if (i >= 24) s -= V[i - 24]; volSma[i] = i >= 23 ? s / 24 : V[i]; } }

// 4H 趋势：EMA20 + 近6根(24h)变化，映射到每个 1H 根
const b4 = C4.map(c => ({ ts: c.ts, c: +c.close })).filter(b => b.c > 0);
const e20_4 = calcEMAarr(b4.map(b => b.c), 20);
const trend4 = new Array(N).fill(0);   // +1 多 / -1 空 / 0 平
{
  let k = 0;
  for (let i = 0; i < N; i++) {
    while (k + 1 < b4.length && b4[k + 1].ts <= TS[i]) k++;
    if (k >= 20) {
      const slope = (b4[k].c - b4[k - 6].c) / b4[k - 6].c * 100;   // 4H 近24h斜率
      trend4[i] = b4[k].c > e20_4[k] && slope > 0.15 ? 1 : (b4[k].c < e20_4[k] && slope < -0.15 ? -1 : 0);
    }
  }
}

// 信号：RSI 1H 35/65 回归 + ATR带 + 可选(4H对齐/量能)
function genSig(opt) {
  const { use4h = false, useVol = false } = opt;
  const s = [];
  for (let i = 260; i < N - 50; i++) {
    if (atrP[i] < 0.5 || atrP[i] > 1.5) continue;
    let dir = null;
    if (rsi1[i - 1] < 35 && rsi1[i] >= 35) dir = 'L';
    else if (rsi1[i - 1] > 65 && rsi1[i] <= 65) dir = 'S';
    if (!dir) continue;
    if (use4h) { const t = trend4[i]; if (dir === 'L' && t < 0) continue; if (dir === 'S' && t > 0) continue; }
    if (useVol && V[i] < volSma[i]) continue;
    s.push({ i, dir });
  }
  return s;
}

function bt(sigs, tp, sl, mh, from = 0, to = N) {
  let w = 0, l = 0, gW = 0, gL = 0, total = 0, tpc = 0;
  for (const sig of sigs) {
    if (sig.i < from || sig.i >= to) continue;
    const i = sig.i, dir = sig.dir, entry = bars[i + 1].o; if (!entry) continue;
    const tpL = dir === 'L' ? entry + tp : entry - tp, slL = dir === 'L' ? entry - sl : entry + sl;
    let ep = 0, rs = ''; const end = Math.min(i + mh, N - 1);
    for (let j = i + 1; j <= end; j++) { const hi = bars[j].h, lo = bars[j].l; if (dir === 'L') { if (hi >= tpL) { ep = tp; rs = 'TP'; break; } if (lo <= slL) { ep = slL - entry; rs = 'SL'; break; } } else { if (lo <= tpL) { ep = tp; rs = 'TP'; break; } if (hi >= slL) { ep = entry - slL; rs = 'SL'; break; } } }
    if (!rs) { const last = bars[end].c; ep = dir === 'L' ? last - entry : entry - last; }
    total++; if (rs === 'TP') tpc++;
    if (ep > 0) { w++; gW += ep; } else { l++; gL += -ep; }
  }
  const pf = gL > 0 ? gW / gL : 0;
  return { n: total, winRate: total ? +(w / total * 100).toFixed(1) : 0, strict: total ? +(tpc / total * 100).toFixed(1) : 0, pf: +pf.toFixed(2) };
}

const TP = 1000, SL = 3000, MH = 48;
const split = Math.floor(N * 0.7);
const variants = [
  { label: 'RSI基线(已部署)', opt: {} },
  { label: 'RSI+4H趋势对齐', opt: { use4h: true } },
  { label: 'RSI+量能确认', opt: { useVol: true } },
  { label: 'RSI+4H+量能', opt: { use4h: true, useVol: true } },
];
console.log('=== R16 多周期/ensemble @ TP=1000/SL=3000/48h（走步: 前70%训练 后30%测试）===\n');
console.log('配置              | 全年n 全年严格 | 训练集n 训练严格 | 测试集n 测试严格 | 全年PF');
console.log('-'.repeat(90));
for (const v of variants) {
  const sig = genSig(v.opt);
  const full = bt(sig, TP, SL, MH);
  const tr = bt(sig, TP, SL, MH, 0, split);
  const te = bt(sig, TP, SL, MH, split, N);
  console.log(`${v.label.padEnd(17)} | ${String(full.n).padStart(4)} ${String(full.strict).padStart(6)}% | ${String(tr.n).padStart(5)} ${String(tr.strict).padStart(6)}% | ${String(te.n).padStart(5)} ${String(te.strict).padStart(6)}% | ${full.pf}`);
}

// 也测：4H对齐但放宽 ATR 带 / 不同 RSI 阈值组合
console.log('\n=== RSI+4H对齐 下扫描 RSI阈值 & ATR带 ===');
for (const [lo, hi] of [[30, 70], [35, 65], [40, 60], [25, 75]])
  for (const [amn, amx] of [[0.5, 1.5], [0.3, 2.0], [0.5, 2.5], [0.8, 2.0]]) {
    const s = [];
    for (let i = 260; i < N - 50; i++) {
      if (atrP[i] < amn || atrP[i] > amx) continue;
      let dir = null;
      if (rsi1[i - 1] < lo && rsi1[i] >= lo) dir = 'L'; else if (rsi1[i - 1] > hi && rsi1[i] <= hi) dir = 'S';
      if (!dir) continue;
      const t = trend4[i]; if (dir === 'L' && t < 0) continue; if (dir === 'S' && t > 0) continue;
      s.push({ i, dir });
    }
    const full = bt(s, TP, SL, MH), te = bt(s, TP, SL, MH, split, N);
    if (full.n >= 30) console.log(`  RSI${lo}/${hi} ATR[${amn},${amx}] 全年n=${String(full.n).padStart(4)} 严格=${String(full.strict).padStart(5)}% PF=${String(full.pf).padStart(5)} | 测试集n=${String(te.n).padStart(3)} 测试严格=${String(te.strict).padStart(5)}%`);
  }
