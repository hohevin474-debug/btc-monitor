#!/usr/bin/env node
/**
 * 过热衰减（momCap）验证
 *
 * 起因：实盘 2026-09-04 的失败。BTC 24H 急涨到 81,300（局部顶），
 * V2 的动量分量早已饱和（±2% 打满），score 冲到 0.9 发出强 LONG，
 * 6H 后跌到 79,729，单笔亏 1570 点；等它转向 SHORT 时已在 79,800 的山脚，
 * 只赚到 336 点。典型的山顶追多、山脚追空。
 *
 * 假设：动量的信息在趋势中段最有效，急涨/急跌末端是反转风险最高的位置，
 *       此时应该衰减甚至取消动量权重。
 *
 * 关注重点不是平均收益，而是**尾部亏损**有没有变小 —— 用户投诉的是
 * 「赚的时候赚一点，亏的时候亏一大截」。
 *
 * 用法：BT_LIB=1 BT_LOCAL=<klines.json> node scripts/overheat.mjs
 */
import { readFileSync } from 'node:fs';
import { runBacktest } from './backtest.mjs';

const file = process.env.BT_LOCAL;
if (!file) { console.error('需要 BT_LOCAL=<klines.json>'); process.exit(1); }
const raw = JSON.parse(readFileSync(file, 'utf8'));
const candles = Array.isArray(raw) ? raw : raw.candles;
console.log(`数据: ${candles.length} 根 | ${new Date(candles[0].t).toISOString().slice(0, 10)} → ${new Date(candles.at(-1).t).toISOString().slice(0, 10)}\n`);

const pnl = (t) => (t.ok_24 ? Math.abs(t.p_24) : -Math.abs(t.p_24));

function evaluate(params) {
  const { trades } = runBacktest(candles, 'v2', params, { target: 500, horizons: [6, 24] });
  const valid = trades.filter(t => t.p_24 !== undefined);
  if (valid.length < 20) return null;
  const ps = valid.map(pnl).sort((a, b) => a - b);
  const n = ps.length;
  const wins = valid.filter(t => t.ok_24).reduce((a, t) => a + Math.abs(t.p_24), 0);
  const losses = valid.filter(t => !t.ok_24).reduce((a, t) => a + Math.abs(t.p_24), 0);
  return {
    n,
    exp: Math.round(ps.reduce((a, b) => a + b, 0) / n),
    pf: losses > 0 ? +(wins / losses).toFixed(2) : null,
    acc: +(valid.filter(t => t.ok_24).length / n * 100).toFixed(1),
    // 尾部风险：最差 1% / 5% 的平均亏损
    tail1: Math.round(ps.slice(0, Math.max(1, Math.floor(n * 0.01))).reduce((a, b) => a + b, 0) / Math.max(1, Math.floor(n * 0.01))),
    tail5: Math.round(ps.slice(0, Math.max(1, Math.floor(n * 0.05))).reduce((a, b) => a + b, 0) / Math.max(1, Math.floor(n * 0.05))),
    worst: Math.round(ps[0]),
    mfe: Math.round(valid.reduce((a, t) => a + t.mfe, 0) / n),
    mae: Math.round(valid.reduce((a, t) => a + t.mae, 0) / n),
  };
}

console.log('配置                              信号数  24H期望  盈亏比  准确率  最差1%   最差5%   单笔最差  MFE    MAE');
console.log('-'.repeat(104));

const cases = [
  ['基线（无过热衰减）', {}],
  ['momCap=2.0 kill=4.0', { momCap: 2.0, momKill: 4.0 }],
  ['momCap=2.5 kill=5.0', { momCap: 2.5, momKill: 5.0 }],
  ['momCap=3.0 kill=5.0', { momCap: 3.0, momKill: 5.0 }],
  ['momCap=3.0 kill=6.0', { momCap: 3.0, momKill: 6.0 }],
  ['momCap=4.0 kill=6.0', { momCap: 4.0, momKill: 6.0 }],
  ['momCap=4.0 kill=8.0', { momCap: 4.0, momKill: 8.0 }],
  ['momCap=5.0 kill=8.0', { momCap: 5.0, momKill: 8.0 }],
];

const results = [];
for (const [label, extra] of cases) {
  const r = evaluate({ threshold: 0.5, ...extra });
  if (!r) { console.log(`${label.padEnd(32)} 信号太少`); continue; }
  results.push({ label, extra, r });
  console.log(
    `${label.padEnd(32)} ${String(r.n).padStart(5)}  ${String(r.exp).padStart(7)}  ${String(r.pf).padStart(6)}  ${String(r.acc).padStart(6)}%  ${String(r.tail1).padStart(7)}  ${String(r.tail5).padStart(7)}  ${String(r.worst).padStart(8)}  ${String(r.mfe).padStart(5)} ${String(r.mae).padStart(6)}`
  );
}

// ---- 分段稳健性：过热衰减应该在多数时间段都不变差 ----
console.log('\n' + '='.repeat(104));
console.log('分段稳健性（8 个月切 6 段，24H 期望；看衰减有没有在多数段改善）');
console.log('='.repeat(104));
const BLOCKS = 6, bs = Math.ceil(candles.length / BLOCKS);
const picks = [{}, { momCap: 3.0, momKill: 6.0 }, { momCap: 4.0, momKill: 8.0 }];
for (const extra of picks) {
  const label = Object.keys(extra).length ? `momCap=${extra.momCap} kill=${extra.momKill}` : '基线';
  const { trades } = runBacktest(candles, 'v2', { threshold: 0.5, ...extra }, { target: 500, horizons: [24] });
  const exps = [];
  for (let b = 0; b < BLOCKS; b++) {
    const seg = trades.filter(t => t.idx >= b * bs && t.idx < (b + 1) * bs && t.p_24 !== undefined);
    exps.push(seg.length >= 15 ? Math.round(seg.reduce((a, t) => a + pnl(t), 0) / seg.length) : null);
  }
  console.log(`  ${label.padEnd(24)} ${exps.map(e => (e === null ? '    -' : String(e).padStart(5))).join(' ')}   合计 ${exps.filter(e => e !== null).reduce((a, b) => a + b, 0)}`);
}
console.log('\n  注：期望提高是好事，但真正要盯的是「最差1%/最差5%」有没有收敛。');
console.log('     平均赚得多但尾部亏得更狠的配置，长期拿不住。');
