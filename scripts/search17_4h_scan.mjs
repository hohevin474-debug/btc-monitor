// R17: 4H趋势对齐 RSI 的参数空间彻底扫描 + 走步验证，找 (n大 & 严格高 & 测试稳) 最优
import { readFileSync } from 'node:fs';
const h1 = JSON.parse(readFileSync('data/okx_1y_1H.json', 'utf8'));
const h4 = JSON.parse(readFileSync('data/okx_2y_4H.json', 'utf8'));
const C1 = Array.isArray(h1) ? h1 : h1.candles;
const C4 = Array.isArray(h4) ? h4 : h4.candles;
const bars = C1.map(c => ({ ts: c.ts, o: +c.open, h: +c.high, l: +c.low, c: +c.close, v: +c.volume })).filter(b => b.c > 0);
const N = bars.length, H = bars.map(b => b.h), L = bars.map(b => b.l), CL = bars.map(b => b.c), TS = bars.map(b => b.ts);
function calcEMAarr(a, p) { const k = 2 / (p + 1); const o = []; let pr; for (let i = 0; i < a.length; i++) { pr = i === 0 ? a[i] : a[i] * k + pr * (1 - k); o.push(pr); } return o; }
const rsi1 = new Array(N).fill(50);
{ let g = 0, l = 0; for (let i = 1; i < N; i++) { const ch = CL[i] - CL[i - 1]; const u = Math.max(0, ch), d = Math.max(0, -ch); if (i <= 14) { g += u; l += d; if (i === 14) { g /= 14; l /= 14; } continue; } g = (g * 13 + u) / 14; l = (l * 13 + d) / 14; rsi1[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); } }
const atrP = new Array(N).fill(0);
{ let p = 0; for (let i = 1; i < N; i++) { const t = Math.max(H[i] - L[i], Math.abs(H[i] - CL[i - 1]), Math.abs(L[i] - CL[i - 1])); p = i === 1 ? t : (p * 13 + t) / 14; atrP[i] = p / CL[i] * 100; } }
const b4 = C4.map(c => ({ ts: c.ts, c: +c.close })).filter(b => b.c > 0);
const e20_4 = calcEMAarr(b4.map(b => b.c), 20);

// 4H 趋势分值：连续型，供不同阈值/模式使用
const t4slope = new Array(N).fill(NaN), t4ema = new Array(N).fill(NaN);
{ let k = 0; for (let i = 0; i < N; i++) { while (k + 1 < b4.length && b4[k + 1].ts <= TS[i]) k++; if (k >= 12) { t4slope[i] = (b4[k].c - b4[k - 6].c) / b4[k - 6].c * 100; t4ema[i] = b4[k].c - e20_4[k]; } } }

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

const TP = 1000, SL = 3000, MH = 48, split = Math.floor(N * 0.7);
const rows = [];
for (const [lo, hi] of [[30, 70], [35, 65], [40, 60]])
  for (const [amn, amx] of [[0.3, 2.0], [0.5, 1.5], [0.5, 2.5], [0.8, 3.0]])
    for (const slopeThr of [0.1, 0.2, 0.3, 0.5])
      for (const mode of ['blockOpp', 'requireAlign']) {
        const s = [];
        for (let i = 260; i < N - 50; i++) {
          if (atrP[i] < amn || atrP[i] > amx || isNaN(t4slope[i])) continue;
          let dir = null;
          if (rsi1[i - 1] < lo && rsi1[i] >= lo) dir = 'L'; else if (rsi1[i - 1] > hi && rsi1[i] <= hi) dir = 'S';
          if (!dir) continue;
          if (mode === 'blockOpp') { if (dir === 'L' && t4slope[i] < -slopeThr) continue; if (dir === 'S' && t4slope[i] > slopeThr) continue; }
          else { if (dir === 'L' && t4slope[i] < slopeThr) continue; if (dir === 'S' && t4slope[i] > -slopeThr) continue; }
          s.push({ i, dir });
        }
        const full = bt(s, TP, SL, MH), tr = bt(s, TP, SL, MH, 0, split), te = bt(s, TP, SL, MH, split, N);
        rows.push({ cfg: `RSI${lo}/${hi} ATR[${amn},${amx}] 斜率${slopeThr} ${mode === 'blockOpp' ? '阻反向' : '需同向'}`, ...full, trStrict: tr.strict, teStrict: te.strict, teN: te.n });
      }

console.log('=== R17: 按 (测试严格 且 n≥40) 排序 前15 ===');
for (const r of rows.filter(r => r.n >= 40 && r.teN >= 12).sort((a, b) => b.teStrict - a.teStrict).slice(0, 15))
  console.log(`  ${r.cfg.padEnd(40)} n=${String(r.n).padStart(3)} 严格=${String(r.strict).padStart(5)}% PF=${String(r.pf).padStart(5)} | 测试n=${String(r.teN).padStart(2)} 测试严格=${String(r.teStrict).padStart(5)}% 训练=${r.trStrict}%`);
console.log('\n=== 按全年严格 且 n≥40 排序 前10 ===');
for (const r of rows.filter(r => r.n >= 40).sort((a, b) => b.strict - a.strict).slice(0, 10))
  console.log(`  ${r.cfg.padEnd(40)} n=${String(r.n).padStart(3)} 严格=${String(r.strict).padStart(5)}% PF=${String(r.pf).padStart(5)} 最大亏=${String(r.maxLoss).padStart(4)} | 测试n=${String(r.teN).padStart(2)} 测试严格=${String(r.teStrict).padStart(5)}%`);
