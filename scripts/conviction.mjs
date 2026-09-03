#!/usr/bin/env node
/**
 * 信心度过滤分析：只推高确信信号，能不能把准确率提上去？
 *
 * 背景：V2 默认参数在 6040 根 K 线里发了 3971 次信号 —— 66% 的时间都在场，
 * 这根本不算筛选，用户感觉「准确率低」就是这么来的。
 * 直觉是：|score| 越大越有把握，那设个门槛只推强信号应该更准。
 * 但直觉经常是错的（可能强信号恰恰是追高），所以用数据验证。
 *
 * 用法：BT_LIB=1 BT_LOCAL=<klines.json> node scripts/conviction.mjs [target]
 */
import { readFileSync } from 'node:fs';
import { runBacktest } from './backtest.mjs';

const target = parseInt(process.argv[2] || '500', 10);
const H = 24;
const file = process.env.BT_LOCAL;
if (!file) { console.error('需要 BT_LOCAL=<klines.json>'); process.exit(1); }
const raw = JSON.parse(readFileSync(file, 'utf8'));
const candles = Array.isArray(raw) ? raw : raw.candles;
console.log(`数据: ${candles.length} 根 | ${new Date(candles[0].t).toISOString().slice(0, 10)} → ${new Date(candles.at(-1).t).toISOString().slice(0, 10)}`);

// 全量跑一遍 V2，拿到所有信号（含 WAIT 之外的）
const { trades } = runBacktest(candles, 'v2', {}, { target, horizons: [6, 24] });
const withScore = trades.filter(t => t.strength !== undefined);
console.log(`V2 信号总数: ${trades.length}，带 score 的: ${withScore.length}`);

const scores = withScore.map(t => t.strength).sort((a, b) => a - b);
const pct = (p) => scores[Math.floor(scores.length * p)];
console.log(`|score| 分布: P10 ${pct(0.1).toFixed(3)} | P25 ${pct(0.25).toFixed(3)} | 中位 ${pct(0.5).toFixed(3)} | P75 ${pct(0.75).toFixed(3)} | P90 ${pct(0.9).toFixed(3)} | P99 ${pct(0.99).toFixed(3)}`);

// ⚠️ 关键：t.p_24 是「原始价格变动」，做空时赚钱它是负的。
// 必须按方向折算成策略盈亏：方向对了记 +|变动|，错了记 -|变动|。
// （跟 backtest.mjs 的 summarize() 保持一致）
const pnlOf = (t) => (t.ok_24 ? Math.abs(t.p_24) : -Math.abs(t.p_24));

function stats(list) {
  if (!list.length) return null;
  const n = list.length;
  const ok = list.filter(t => t.ok_24).length;
  const hit = list.filter(t => t.hit_24).length;
  const sum = list.reduce((a, t) => a + pnlOf(t), 0);
  const wins = list.filter(t => t.ok_24).reduce((a, t) => a + Math.abs(t.p_24), 0);
  const losses = list.filter(t => !t.ok_24).reduce((a, t) => a + Math.abs(t.p_24), 0);
  return {
    n,
    acc: Math.round(ok / n * 1000) / 10,
    hit: Math.round(hit / n * 1000) / 10,
    exp: Math.round(sum / n),
    pf: losses > 0 ? Math.round(wins / losses * 100) / 100 : (wins > 0 ? Infinity : 0),
    mfe: Math.round(list.reduce((a, t) => a + t.mfe, 0) / n),
    mae: Math.round(list.reduce((a, t) => a + t.mae, 0) / n),
  };
}

// ---- 1. 按 |score| 分桶 ----
const EDGES = [0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.70, 0.85, 1.01];
console.log('\n' + '='.repeat(88));
console.log('按 |score| 分桶（24H 窗口）');
console.log('='.repeat(88));
console.log('  |score| 区间        信号数   占比   准确率  500点捕捉   期望   盈亏比   MFE     MAE');
for (let i = 0; i < EDGES.length - 1; i++) {
  const lo = EDGES[i], hi = EDGES[i + 1];
  const b = withScore.filter(t => t.strength >= lo && t.strength < hi);
  if (b.length < 5) continue;
  const s = stats(b);
  console.log(
    `  ${lo.toFixed(2)} – ${hi >= 1 ? '∞ ' : hi.toFixed(2)}   ${String(s.n).padStart(7)} ${String(Math.round(s.n / withScore.length * 1000) / 10).padStart(6)}%   ${String(s.acc).padStart(6)}%  ${String(s.hit).padStart(7)}%  ${String(s.exp).padStart(6)}  ${String(s.pf).padStart(6)}  ${String(s.mfe).padStart(6)} ${String(s.mae).padStart(6)}`
  );
}

// ---- 2. 累积门槛：只做 |score| >= X 的信号 ----
const THRESHOLDS = [0.25, 0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60, 0.70, 0.85];
console.log('\n' + '='.repeat(88));
console.log('累积门槛：只推 |score| >= X 的信号（覆盖率 = 有信号的小时占比）');
console.log('='.repeat(88));
console.log('  门槛    信号数  覆盖率   准确率  500点捕捉   期望   盈亏比   MFE     MAE   总收益');
const usable = candles.length - 80 - H;
for (const th of THRESHOLDS) {
  const b = withScore.filter(t => t.strength >= th);
  if (b.length < 10) continue;
  const s = stats(b);
  const total = b.reduce((a, t) => a + pnlOf(t), 0);
  console.log(
    `  ${th.toFixed(2)}   ${String(s.n).padStart(7)} ${String(Math.round(s.n / usable * 1000) / 10).padStart(6)}%   ${String(s.acc).padStart(6)}%  ${String(s.hit).padStart(7)}%  ${String(s.exp).padStart(6)}  ${String(s.pf).padStart(6)}  ${String(s.mfe).padStart(6)} ${String(s.mae).padStart(6)}  ${String(Math.round(total / 1000)).padStart(6)}k`
  );
}

// ---- 3. 稳健性：前后半段分开看，确认不是某段行情的运气 ----
console.log('\n' + '='.repeat(88));
console.log('稳健性检验：把 8 个月切成 6 段，看每个门槛在几段里为正');
console.log('='.repeat(88));
const BLOCKS = 6;
const blockSize = Math.ceil(candles.length / BLOCKS);
console.log('  门槛    各段期望(点)                                        为正段数  判定');
const robust = [];
for (let th = 0.25; th <= 0.7001; th += 0.05) {
  const th2 = Math.round(th * 100) / 100;
  const exps = [];
  for (let b = 0; b < BLOCKS; b++) {
    const list = withScore.filter(t => t.idx >= b * blockSize && t.idx < (b + 1) * blockSize && t.strength >= th2);
    const s = stats(list);
    exps.push(s && s.n >= 15 ? s.exp : null);
  }
  const valid = exps.filter(e => e !== null);
  const pos = valid.filter(e => e > 0).length;
  const row = exps.map(e => (e === null ? '   -' : String(e).padStart(4))).join(' ');
  const verdict = pos === valid.length && valid.length >= 5 ? '✅ 全段为正'
    : pos >= Math.ceil(valid.length * 0.8) ? '⚠️ 多数为正' : '❌ 不稳定';
  if (pos === valid.length && valid.length >= 5) robust.push(th2);
  console.log(`  ${th2.toFixed(2)}  ${row}    ${pos}/${valid.length}    ${verdict}`);
}
console.log(`\n  → 在所有时间段都为正、且样本足够的门槛: ${robust.length ? robust.map(t => t.toFixed(2)).join(', ') : '无'}`);
console.log('    这才是能放心上线的值；只看全量期望会被某一段行情带偏。');

// ---- 4. 对照：V1 均值回归同门槛下的表现 ----
const v1 = runBacktest(candles, 'meanReversion', {}, { target, horizons: [6, 24] });
const v1s = v1.trades.filter(t => t.strength !== undefined);
console.log('\n' + '='.repeat(88));
console.log('对照组：V1 均值回归（现行旧策略）');
console.log('='.repeat(88));
const v1all = stats(v1s);
console.log(`  V1 全量: 信号 ${v1all.n} | 准确率 ${v1all.acc}% | 500点捕捉 ${v1all.hit}% | 期望 ${v1all.exp}点 | 盈亏比 ${v1all.pf} | MFE ${v1all.mfe} / MAE ${v1all.mae}`);
console.log('  （V1 的 strength 含义与 V2 不同，这里只作整体对照，不做分桶比较）');
