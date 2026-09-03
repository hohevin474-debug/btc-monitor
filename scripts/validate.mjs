#!/usr/bin/env node
/**
 * 样本外验证器（walk-forward validation）
 *
 * 为什么需要它：网格搜索在「60 天、24H 窗口」上只有约 59 个独立样本，
 * 拿 54 组参数去挑最好的，挑出来的很可能是运气而不是规律。
 * 典型症状：训练集期望 +1141 点、信号只有 19 个 —— 这是过拟合的 textbook 案例。
 *
 * 做法：
 *   1. 用「滚动扩展窗口」切多个 fold，每个 fold 在前面训练、在后面测试
 *   2. 每个 fold 各自独立挑参数，再看它在**后面那段没见过的数据**上表现如何
 *   3. 只有「每个 fold 的样本外都为正、且跑赢买入持有」的参数才算数
 *
 * 用法：BT_LIB=1 BT_LOCAL=<klines.json> node scripts/validate.mjs [target]
 */
import { readFileSync } from 'node:fs';
import { runBacktest, gridSearch, STRATEGIES } from './backtest.mjs';

const target = parseInt(process.argv[2] || '500', 10);
const HORIZONS = [6, 24];
const H = 24; // 主评估窗口
const MIN_TEST_SIGNALS = 20; // 样本外信号太少则不采信

const file = process.env.BT_LOCAL;
if (!file) { console.error('需要 BT_LOCAL=<klines.json>'); process.exit(1); }
const raw = JSON.parse(readFileSync(file, 'utf8'));
const candles = Array.isArray(raw) ? raw : raw.candles;
console.log(`数据: ${candles.length} 根 | ${new Date(candles[0].t).toISOString().slice(0, 10)} → ${new Date(candles.at(-1).t).toISOString().slice(0, 10)}`);

// ---------------------------------------------------------------
// 基准：躺平不动能赚多少？（这轮行情涨了 30%，不比这个就是白干）
// ---------------------------------------------------------------
function baselines(cs) {
  const out = {};
  for (const dir of ['LONG', 'SHORT']) {
    const ps = [];
    let hit = 0, mfe = 0, mae = 0;
    for (let i = 80; i < cs.length - H; i++) {
      const entry = cs[i].c;
      const diff = cs[i + H].c - entry;
      const p = dir === 'LONG' ? diff : -diff;
      ps.push(p);
      if (Math.abs(diff) >= target) hit++;
      for (let k = 1; k <= H; k++) {
        const hi = cs[i + k].h - entry, lo = cs[i + k].l - entry;
        mfe += dir === 'LONG' ? Math.max(0, hi) : Math.max(0, -lo);
        mae += dir === 'LONG' ? Math.min(0, lo) : Math.min(0, -hi);
      }
    }
    const n = ps.length;
    out[dir] = {
      n,
      expectancy: Math.round(ps.reduce((a, b) => a + b, 0) / n),
      accuracy: Math.round(ps.filter(x => x > 0).length / n * 1000) / 10,
      hitRate: Math.round(hit / n * 1000) / 10,
      avgMFE: Math.round(mfe / n),
      avgMAE: Math.round(mae / n),
    };
  }
  return out;
}

console.log('\n' + '='.repeat(74));
console.log('基准：躺平不动（每个时点都持有 24H）');
console.log('='.repeat(74));
const base = baselines(candles);
for (const d of ['LONG', 'SHORT']) {
  const b = base[d];
  console.log(`  始终${d === 'LONG' ? '做多' : '做空'}: 期望 ${String(b.expectancy).padStart(6)}点 | 胜率 ${b.accuracy}% | ${target}点捕捉 ${b.hitRate}% | MFE ${b.avgMFE} / MAE ${b.avgMAE}`);
}
const benchLong = base.LONG.expectancy;
console.log(`  → 策略要在 24H 窗口上跑赢「+${benchLong} 点」才算有价值`);

// ---------------------------------------------------------------
// 滚动扩展窗口的 walk-forward
// ---------------------------------------------------------------
const n = candles.length;
const folds = [];
// 训练段 40% / 50% / 60% / 70%，测试段各取其后 15%
for (const trainFrac of [0.40, 0.50, 0.60, 0.70]) {
  const trEnd = Math.floor(n * trainFrac);
  const teEnd = Math.min(n, trEnd + Math.floor(n * 0.15));
  if (teEnd - trEnd < 60) continue;
  folds.push({
    name: `训练${Math.round(trainFrac * 100)}%`,
    train: candles.slice(0, trEnd),
    test: candles.slice(trEnd, teEnd),
  });
}
console.log(`\n切出 ${folds.length} 个 fold：${folds.map(f => `${f.name}(训练${f.train.length}/测试${f.test.length})`).join('  ')}`);

const GRIDS = {
  v2: {
    minAtrPct: [0.15, 0.25, 0.4],
    momPeriod: [12, 24, 48],
    threshold: [0.3, 0.45, 0.6],
    wBreak: [0.15, 0.25],
  },
  breakout: {
    lookback: [24, 48, 72],
    buffer: [0, 0.15, 0.3],
    minAtrPct: [0.1, 0.25, 0.4],
  },
  squeeze: {
    bbPeriod: [20],
    squeezeQ: [0.15, 0.25, 0.4],
    bbMult: [1.5, 2, 2.5],
  },
};

const results = {};

for (const sName of Object.keys(GRIDS)) {
  console.log('\n' + '='.repeat(74));
  console.log(`${STRATEGIES[sName].name} — walk-forward`);
  console.log('='.repeat(74));
  const foldRows = [];

  for (const f of folds) {
    // 1) 在训练段网格搜索，挑 24H 期望最高的
    const gs = gridSearch(f.train, sName, GRIDS[sName], { target, horizons: HORIZONS });
    if (!gs.length) { console.log(`  ${f.name}: 无有效参数`); continue; }
    const best = gs[0];
    const b24 = best.summary.horizons[24] || {};

    // 2) 拿这组参数去测试段跑（完全没见过的数据）
    const test = runBacktest(f.test, sName, best.params, { target, horizons: HORIZONS });
    const t24 = test.summary.horizons[24] || {};

    // 3) 同时测默认参数，作为对照组
    const dflt = runBacktest(f.test, sName, {}, { target, horizons: HORIZONS });
    const d24 = dflt.summary.horizons[24] || {};

    const ok = (t24.n || 0) >= MIN_TEST_SIGNALS;
    foldRows.push({
      fold: f.name,
      params: best.params,
      trainExp: Math.round(b24.expectancy || 0),
      trainAcc: b24.dirAcc,
      trainN: b24.n,
      testExp: Math.round(t24.expectancy || 0),
      testAcc: t24.dirAcc,
      testN: t24.n,
      testPF: t24.pf,
      dfltExp: Math.round(d24.expectancy || 0),
      dfltN: d24.n,
      ok,
    });

    console.log(`\n  ${f.name}`);
    console.log(`    训练集最优: ${JSON.stringify(best.params)}`);
    console.log(`      训练: 信号 ${String(b24.n).padStart(4)} | 准确率 ${String(b24.dirAcc).padStart(5)}% | 期望 ${String(Math.round(b24.expectancy || 0)).padStart(6)}点`);
    console.log(`      测试: 信号 ${String(t24.n).padStart(4)} | 准确率 ${String(t24.dirAcc).padStart(5)}% | 期望 ${String(Math.round(t24.expectancy || 0)).padStart(6)}点 | 盈亏比 ${t24.pf ?? '-'} ${ok ? '' : `⚠️ 信号<${MIN_TEST_SIGNALS}，不采信`}`);
    console.log(`      默认参数对照组: 信号 ${String(d24.n).padStart(4)} | 期望 ${String(Math.round(d24.expectancy || 0)).padStart(6)}点`);
  }

  const valid = foldRows.filter(r => r.ok);
  const avgTest = valid.length ? Math.round(valid.reduce((a, r) => a + r.testExp, 0) / valid.length) : null;
  const avgTrain = valid.length ? Math.round(valid.reduce((a, r) => a + r.trainExp, 0) / valid.length) : null;
  const avgDflt = valid.length ? Math.round(valid.reduce((a, r) => a + r.dfltExp, 0) / valid.length) : null;
  const positive = valid.filter(r => r.testExp > 0).length;

  results[sName] = { foldRows, avgTrain, avgTest, avgDflt, positive, total: valid.length, benchLong };

  console.log(`\n  ── ${STRATEGIES[sName].name} 汇总 ──`);
  console.log(`    训练集平均期望 ${avgTrain} 点 → 测试集平均期望 ${avgTest} 点  (衰减 ${avgTrain ? Math.round((1 - avgTest / avgTrain) * 100) : '-'}%)`);
  console.log(`    默认参数测试集平均期望 ${avgDflt} 点`);
  console.log(`    样本外为正的 fold: ${positive}/${valid.length}`);
  if (avgTest !== null) {
    console.log(`    vs 买入持有(${benchLong}点): ${avgTest > benchLong ? `✅ 跑赢 ${avgTest - benchLong} 点` : `❌ 跑输 ${benchLong - avgTest} 点`}`);
  }
}

// ---------------------------------------------------------------
// 结论
// ---------------------------------------------------------------
console.log('\n' + '='.repeat(74));
console.log('结论');
console.log('='.repeat(74));
const rows = Object.entries(results)
  .filter(([, r]) => r.avgTest !== null)
  .sort((a, b) => b[1].avgTest - a[1].avgTest);
for (const [name, r] of rows) {
  const verdict = r.positive === r.total && r.avgTest > r.benchLong ? '✅ 稳健且跑赢躺平'
    : r.positive === r.total ? '⚠️ 稳健但没跑赢躺平'
      : r.positive > 0 ? '⚠️ 部分 fold 为负' : '❌ 样本外失效';
  console.log(`  ${STRATEGIES[name].name.padEnd(16)} 样本外均值 ${String(r.avgTest).padStart(6)}点 | 正fold ${r.positive}/${r.total} | ${verdict}`);
}
console.log('\n  注：训练集期望远高于测试集 = 过拟合。判据是「测试集」那一列，不是训练集。');
