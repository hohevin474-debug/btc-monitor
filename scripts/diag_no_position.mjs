// 诊断：这10天为什么没建仓 —— 用部署版 analyzeDv 真身逐根回放 11-02→11-12
import { readFileSync, writeFileSync } from 'fs';
{ const src = readFileSync('src/worker.js', 'utf8'); writeFileSync('/tmp/worker_copy.mjs', src + '\nexport { analyzeDv, DV };\n'); }
const { analyzeDv, DV } = await import('/tmp/worker_copy.mjs');

const k1 = JSON.parse(readFileSync('/tmp/kl2/klines.json', 'utf8')).candles;
const k4 = JSON.parse(readFileSync('/tmp/kl4/klines.json', 'utf8')).candles;
const map = c => ({ t: c.ts, o: c.open, h: c.high, l: c.low, c: c.close, vol: c.volume });
const bars = k1.map(map).filter(b => b.c > 0);
const b4 = k4.map(map).filter(b => b.c > 0);
console.log(`1H: ${bars.length} 根 (${new Date(bars[0].t).toISOString().slice(0, 16)}→${new Date(bars[bars.length - 1].t).toISOString().slice(0, 16)})`);
console.log(`4H: ${b4.length} 根\n配置: ${JSON.stringify({ rsiLo: DV.rsiLo, rsiHi: DV.rsiHi, ema: DV.emaPullback, span: DV.trend4Span, slopeMin: DV.trend4SlopeMin, slopeMax: DV.trend4SlopeMax, atr: [DV.atrBandMin, DV.atrBandMax] })}\n`);

const FROM = Date.UTC(2026, 10, 2);   // 11-02 00:00 UTC（10天前）
const k4hAt = ts => { let lo = 0, hi = b4.length - 1, res = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (b4[m].t <= ts) { res = m; lo = m + 1; } else hi = m - 1; } return res < 0 ? [] : b4.slice(0, res + 1); };

// 逐根回放：记录 RSI 穿越事件 + 每根 bar 的门控快照
const events = [];
for (let i = 100; i < bars.length; i++) {
  const bar = bars[i];
  if (bar.t < FROM) continue;
  const sig = analyzeDv(bars.slice(0, i + 1), k4hAt(bar.t), bar.c);
  // 抓 RSI 穿越：从 reasons 判断是否刚穿越
  const isCross = sig.reasons.some(r => r.includes('回升破42') || r.includes('回落破58'));
  if (isCross || sig.direction !== 'WAIT') {
    events.push({
      t: new Date(bar.t).toISOString().slice(0, 16),
      price: bar.c,
      dir: sig.direction,
      reason: sig.reasons.find(r => !r.startsWith('📊')) || sig.reasons[0],
      gates: sig.gates,
    });
  }
}

console.log(`=== 10 天内 (11-02→11-12) RSI 穿越/信号事件: ${events.length} 个 ===\n`);
for (const e of events) {
  console.log(`${e.t}  $${e.price}  ${e.dir === 'WAIT' ? '⛔WAIT' : '✅' + e.dir}`);
  console.log(`   ${e.reason}`);
  if (e.gates) console.log(`   gates: ${JSON.stringify(e.gates)}`);
}

// 汇总：最后 10 天每天的门控概况（用最后一根 bar 快照）
console.log('\n=== 最后 10 天每日收盘时的门控快照 ===');
const byDay = {};
for (let i = 100; i < bars.length; i++) {
  const bar = bars[i];
  if (bar.t < FROM) continue;
  const sig = analyzeDv(bars.slice(0, i + 1), k4hAt(bar.t), bar.c);
  const day = new Date(bar.t).toISOString().slice(0, 10);
  byDay[day] = sig;   // 每天最后一根覆盖
}
for (const [day, sig] of Object.entries(byDay)) {
  const g = sig.gates || {};
  console.log(`${day}  RSI=${g.rsiNow ?? '?'}  4H斜率=${g.t4slope ?? '?'}  (${g.t4dir ?? '?'})  ${sig.direction === 'WAIT' ? 'WAIT' : '信号!'}`);
}
