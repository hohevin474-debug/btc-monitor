// 网格搜索：在 60 天数据上寻找正期望配置。
// 重点挖 V1（唯一接近 break-even 的策略），并测若干自适应组合。
import fs from 'fs';
import { backtest } from './replay_lib.mjs';

const DATA = process.argv[2] || '/tmp/okx/okx-60d/okx_60d.json';
const raw = JSON.parse(fs.readFileSync(DATA, 'utf8'));

function row(label, r) {
  return `${label.padEnd(34)} | ${String(r.n).padStart(4)}笔 | 胜率 ${r.winRate.toFixed(1).padStart(5)}% | 总 ${String(r.total).padStart(7)}点 | 均盈 ${String(r.avgWin).padStart(6)} | 均亏 ${String(r.avgLoss).padStart(6)} | PF ${String(r.pf).padStart(6)} | 最大亏 ${String(r.maxLoss).padStart(6)} | ≥1000点 ${r.bigWins}`;
}

console.log('=== 基线（与 worker 当前一致）===');
console.log(row('adaptive(当前)', backtest(raw, { mode: 'adaptive' })));
console.log(row('pure v1(当前)', backtest(raw, { mode: 'v1' })));
console.log(row('pure v2(当前)', backtest(raw, { mode: 'v2' })));

console.log('\n=== V1 网格：止盈 tpPct × 止损倍率 stopMult × 入场门槛 v1EntryThr × 最大持仓h ===');
const results = [];
for (const tpPct of [0.5, 0.7, 0.9, 1.1, 1.3]) {
  for (const stopMult of [0.7, 1.0, 1.3]) {
    for (const entryThr of [0.18, 0.25, 0.35]) {
      for (const maxHold of [6, 12, 24]) {
        const r = backtest(raw, { mode: 'v1', v1TpPct: tpPct, v1StopMult: stopMult, v1EntryThr: entryThr, v1MaxHoldH: maxHold });
        if (r.n >= 30) results.push({ tpPct, stopMult, entryThr, maxHold, ...r });
      }
    }
  }
}
results.sort((a, b) => b.pf - a.pf);
console.log('--- Top 12 by PF ---');
for (const r of results.slice(0, 12)) {
  console.log(`tp=${r.tpPct} stopMult=${r.stopMult} entry=${r.entryThr} hold=${r.maxHold}h | n=${String(r.n).padStart(3)} 胜率${r.winRate.toFixed(0).padStart(3)}% 总${String(r.total).padStart(6)} PF${String(r.pf).padStart(5)} 最大亏${r.maxLoss}`);
}
console.log('--- Top 12 by 总盈亏 ---');
[...results].sort((a,b)=>b.total-a.total).slice(0,12).forEach(r=>{
  console.log(`tp=${r.tpPct} stopMult=${r.stopMult} entry=${r.entryThr} hold=${r.maxHold}h | n=${String(r.n).padStart(3)} 胜率${r.winRate.toFixed(0).padStart(3)}% 总${String(r.total).padStart(6)} PF${String(r.pf).padStart(5)} 最大亏${r.maxLoss}`);
});

console.log('\n=== 自适应候选（V1 优配 + 不同 regime 阈值 / V2开关）===');
const bestV1 = results[0];
console.log('bestV1 =', bestV1 && `tp=${bestV1.tpPct} stopMult=${bestV1.stopMult} entry=${bestV1.entryThr} hold=${bestV1.maxHold}h`);
for (const adxTrend of [22, 25, 30]) {
  for (const r2Trend of [0.35, 0.45, 0.55]) {
    for (const v2on of [true, false]) {
      const r = backtest(raw, { mode: 'adaptive', v1TpPct: bestV1.tpPct, v1StopMult: bestV1.stopMult,
        v1EntryThr: bestV1.entryThr, v1MaxHoldH: bestV1.maxHold, regime: { adxTrend, r2Trend }, v2Enabled: v2on });
      console.log(`adxT=${adxTrend} r2T=${r2Trend} v2=${v2on?'on':'off'} | ${row('', r).trim().replace(/^\s*\|/, '')}`);
    }
  }
}
