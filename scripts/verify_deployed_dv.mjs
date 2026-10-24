// 部署版 analyzeDv 真身复算（全2年数据）——直接 import 线上代码，非重新实现
// 口径：与原搜索脚本一致 —— 当根4H(含未收盘) + 下一根开盘价入场 + TP/SL/48h + 非重叠
// 用法：node scripts/verify_deployed_dv.mjs （自动从 src/worker.js 生成临时副本）
import { readFileSync, writeFileSync } from 'fs';

// 把 src/worker.js 复制到 /tmp 并追加命名导出，供 import（不改动仓库内文件）
{
  const src = readFileSync('src/worker.js', 'utf8');
  writeFileSync('/tmp/worker_copy.mjs', src + '\nexport { analyzeDv, DV };\n');
}
const { analyzeDv, DV } = await import('/tmp/worker_copy.mjs');

const raw1 = JSON.parse(readFileSync('data/okx_2y_1H.json', 'utf8'));
const raw4 = JSON.parse(readFileSync('data/okx_2y_4H.json', 'utf8'));
const map = c => ({ t: c.ts, o: c.open, h: c.high, l: c.low, c: c.close, vol: c.volume });
const bars = raw1.candles.map(map).filter(b => b.c > 0);
const b4 = raw4.candles.map(map).filter(b => b.c > 0);
const N = bars.length;
console.log(`1H: ${N} 根  4H: ${b4.length} 根`);
console.log(`配置: RSI${DV.rsiLo}/${DV.rsiHi} EMA${DV.emaPullback} 跨${DV.trend4Span} 斜率[${DV.trend4SlopeMin},${DV.trend4SlopeMax}] ATR[${DV.atrBandMin},${DV.atrBandMax}] TP${DV.tpPoints} SL${DV.slPoints}`);

// 当根4H：最后一条 ts <= 当前1H bar ts 的4H（含未收盘），与线上一致
function k4hAt(ts) {
  let lo = 0, hi = b4.length - 1, res = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (b4[mid].t <= ts) { res = mid; lo = mid + 1; } else hi = mid - 1; }
  return res < 0 ? [] : b4.slice(0, res + 1);
}

const TP = DV.tpPoints, SL = DV.slPoints, MH = DV.maxHoldSec / 3600;
const sigs = [];
for (let i = 300; i < N - 50; i++) {
  const sig = analyzeDv(bars.slice(0, i + 1), k4hAt(bars[i].t), bars[i].c);
  if (sig.direction !== 'WAIT') sigs.push({ i, dir: sig.direction === 'LONG' ? 'L' : 'S' });
}
console.log(`\n信号总数(未去重叠): ${sigs.length}`);

function bt(sigs, nonOverlap = true) {
  let w = 0, l = 0, gW = 0, gL = 0, total = 0, tpc = 0, maxLoss = 0, streak = 0, maxStreak = 0;
  let busyUntil = -1; const trades = [];
  for (const sig of sigs) {
    if (nonOverlap && sig.i <= busyUntil) continue;
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
    if (nonOverlap) busyUntil = end;
  }
  const pf = gL > 0 ? gW / gL : (gW > 0 ? 99 : 0);
  return { n: total, strict: +(tpc / total * 100).toFixed(1), winRate: +(w / total * 100).toFixed(1), pf: +pf.toFixed(2), maxLoss: +maxLoss.toFixed(0), maxStreak, trades };
}

const r = bt(sigs, true);
console.log(`\n===== 部署版 analyzeDv 真身复算（非重叠=线上口径）=====`);
console.log(`信号数        : ${r.n}`);
console.log(`严格命中率    : ${r.strict}%  (真打到 TP ${TP} 点)`);
console.log(`宽松盈利离场率: ${r.winRate}%`);
console.log(`盈亏比 PF     : ${r.pf}`);
console.log(`最大单笔亏损  : ${r.maxLoss} 点`);
console.log(`最大连亏      : ${r.maxStreak} 笔`);
const net = r.trades.reduce((a, t) => a + t.ep, 0) - r.n * 120;
console.log(`扣费后净盈亏  : ${net.toFixed(0)} 点 (万6×2=120点/笔)`);
const split = Math.floor(N * 0.7);
const tr = r.trades.filter(t => t.i < split), te = r.trades.filter(t => t.i >= split);
console.log(`走步          : 训练 ${(tr.filter(x => x.rs === 'TP').length / tr.length * 100).toFixed(1)}% (n=${tr.length})  测试 ${(te.filter(x => x.rs === 'TP').length / te.length * 100).toFixed(1)}% (n=${te.length})`);
for (const yr of [2025, 2026]) {
  const arr = r.trades.filter(t => new Date(bars[t.i].t).getFullYear() === yr);
  console.log(`  ${yr}: n=${arr.length} 严格 ${(arr.filter(x => x.rs === 'TP').length / arr.length * 100).toFixed(1)}%`);
}
console.log('\n===== 达标检查 =====');
console.log(`胜率 ≥90%      : ${r.strict >= 90 ? '✅' : '❌'} (${r.strict}%)`);
console.log(`单笔盈利 1000点: ${TP >= 1000 ? '✅' : '❌'}`);
console.log(`持仓 ≤48h      : ${MH <= 48 ? '✅' : '❌'}`);
console.log(`最大亏损 ≤3000 : ${r.maxLoss <= 3000 ? '✅' : '❌'} (${r.maxLoss})`);
console.log(`扣费后仍盈利   : ${net > 0 ? '✅' : '❌'} (${net.toFixed(0)})`);
