// 监督学习特征导出（P2 准备，不重写生产策略）
// 从 1H K 线导出「标注数据集」：每行一个样本（某时刻的窗口特征）+ 未来 24H 方向标签。
// 未来用途：训练 XGBoost/LSTM 分类器替代规则阈值。当前仅导出，不训练。
// 用法：node scripts/export_features.mjs [数据文件] [输出] [horizon]
process.env.BT_LIB = '1';
const { calcRSI, calcATR, calcADX, sma } = await import('./backtest.mjs');
import fs from 'fs';

const file = process.argv[2] || '/workspace/btc-analysis/btc_1h_6900根.json';
const out = process.argv[3] || '/workspace/btc-analysis/features.csv';
const H = parseInt(process.argv[4] || '24'); // 标签前瞻窗口（K线根数）

const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
const c = raw.map(k => ({ t: k.t, o: k.o, h: k.h, l: k.l, c: k.c, vol: k.v }));
const N = c.length;

const header = [
  'idx', 'ts',
  'rsi14', 'atrPct', 'adx14',
  'mom24', 'mom6',
  'ma10_40_slope', 'volRatio',
  'price', 'future_ret', 'label',
].join(',');

const lines = [header];
for (let i = 60; i + H < N; i++) {
  const win = c.slice(0, i + 1);
  const closes = win.map(x => x.c);
  const rsi = calcRSI(closes, 14);
  const atr = calcATR(win, 14);
  const atrPct = (atr / c[i].c) * 100;
  const adx = calcADX(win, 14);
  const maFast = sma(closes, 10);
  const maSlow = sma(closes, 40);
  const slope = (maFast - maSlow) / maSlow * 100;
  const mom24 = (c[i].c - closes[closes.length - 1 - 24]) / closes[closes.length - 1 - 24] * 100;
  const mom6 = (c[i].c - closes[closes.length - 1 - 6]) / closes[closes.length - 1 - 6] * 100;
  const volNow = sma(c.slice(-12).map(x => x.vol), 12);
  const volPrev = sma(c.slice(-24, -12).map(x => x.vol), 12);
  const volRatio = volPrev > 0 ? volNow / volPrev : 1;
  const futureRet = (c[i + H].c - c[i].c) / c[i].c * 100;
  // 标签：未来 H 根收盘相对当前涨/跌（二分类）。可据需改为多类或回归。
  const label = futureRet > 0 ? 1 : 0;
  lines.push([
    i, new Date(c[i].t).toISOString(),
    rsi.toFixed(1), atrPct.toFixed(3), adx != null ? adx.toFixed(1) : 'NA',
    mom24.toFixed(2), mom6.toFixed(2),
    slope.toFixed(3), volRatio.toFixed(2),
    c[i].c, futureRet.toFixed(3), label,
  ].join(','));
}

fs.writeFileSync(out, lines.join('\n'));
console.log(`✅ 导出 ${lines.length - 1} 行特征 → ${out}`);
console.log(`   特征: rsi14 / atrPct / adx14 / mom24 / mom6 / ma10_40_slope / volRatio`);
console.log(`   标签: 未来${H}H 收盘涨跌(1=涨,0=跌)`);
// 标签分布
const labels = lines.slice(1).map(l => +l.split(',')[11]);
const up = labels.filter(x => x === 1).length;
console.log(`   标签分布: 涨 ${up} / 跌 ${labels.length - up} (基线 ${(100 * up / labels.length).toFixed(0)}%)`);
