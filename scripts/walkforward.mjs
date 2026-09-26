// Walk-forward 稳健性检验（P0-2）
// 目的：把历史切成多段，用【生产默认 v2 参数】逐段跑回测，
//       看策略在不同行情段的表现是否稳定 —— 暴露过拟合（某段大亏）。
// 用法：node scripts/walkforward.mjs [数据文件] [段长] [步进]
process.env.BT_LIB = '1';
const { runBacktest } = await import('./backtest.mjs');
import fs from 'fs';

const file = process.argv[2] || '/workspace/btc-analysis/btc_1h_6900根.json';
const segLen = parseInt(process.argv[3] || '600');   // 每段 K 线数（≈25天/1H）
const step = parseInt(process.argv[4] || '400');      // 滑动步进
const target = 500;
const horizons = [1, 6, 24];

const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const data = raw.map(c => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, vol: c.v }));
const N = data.length;

// 与生产 V2 完全对齐的默认参数（含本次新增的 regime / 自适应阈值 / 止损模拟）
const params = {
  minAtrPct: 0.15, momPeriod: 24, momScale: 2, fastMA: 10, slowMA: 40, trendScale: 0.5,
  wMom: 0.35, wTrend: 0.2, wRsi: 0.1, wBreak: 0.25, volRatio: 1.1, volBoost: 1.15,
  threshold: 0.45, thresholdLong: 0.60, thresholdShort: 0.45, requireTrendAlign: true,
  minAdx: 25, adxPeriod: 14, driftRef: 0.75, driftStrength: 0.3, atrToSigma: 1.3,
  regimeQuietPctile: 0.2, volAdapt: true, volAdaptLo: 0.85, volAdaptHi: 1.35, atrWindow: 168,
  multicycle: false, longMA: 160,
};

const rows = [];
for (let start = 80; start + segLen + 24 < N; start += step) {
  const seg = data.slice(start, start + segLen);
  const r = runBacktest(seg, 'v2', params, { target, horizons, cooldown: 0 });
  const h24 = r.summary.horizons[24] || {};
  const h6 = r.summary.horizons[6] || {};
  rows.push({
    from: new Date(seg[0].t).toISOString().slice(0, 10),
    to: new Date(seg[seg.length - 1].t).toISOString().slice(0, 10),
    n: h24.n ?? 0,
    acc24: h24.dirAcc ?? null,
    exp24: h24.expectancy ?? null,
    pf24: h24.pf ?? null,
    exp6: h6.expectancy ?? null,
  });
}

console.log(`\nWalk-forward 稳健性检验 | 数据 ${N} 根 | 段长 ${segLen} | 步进 ${step} | 目标 ${target}点\n`);
console.table(rows);

const exps24 = rows.map(r => r.exp24).filter(x => x != null);
const exps6 = rows.map(r => r.exp6).filter(x => x != null);
const pos24 = exps24.filter(e => e > 0).length;
const pos6 = exps6.filter(e => e > 0).length;
console.log(`段数: ${rows.length}`);
console.log(`24H: 正期望段 ${pos24}/${exps24.length} (${(100 * pos24 / exps24.length).toFixed(0)}%) | 均值期望 ${Math.round(exps24.reduce((a, b) => a + b, 0) / exps24.length)} 点`);
console.log(`6H : 正期望段 ${pos6}/${exps6.length} (${(100 * pos6 / exps6.length).toFixed(0)}%) | 均值期望 ${Math.round(exps6.reduce((a, b) => a + b, 0) / exps6.length)} 点`);
const accs = rows.map(r => r.acc24).filter(x => x != null);
console.log(`24H 胜率范围: ${Math.min(...accs).toFixed(0)}% ~ ${Math.max(...accs).toFixed(0)}% | 均值 ${Math.round(accs.reduce((a, b) => a + b, 0) / accs.length)}%`);
