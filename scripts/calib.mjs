// 校准脚本：用实盘这段行情（含 09-03~09-24 逆风段）重跑 walk-forward + 参数网格扫描
// 运行：node scripts/calib.mjs   （在 runner 上会尝试用 OKX 补全 09-11 之后的数据）
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

// 必须在导入 backtest.mjs 之前设 BT_LIB，阻止其顶层 main() 自动抓取 OKX
process.env.BT_LIB = '1';
const { runBacktest } = await import('./backtest.mjs');

const TARGET = 500, HORIZONS = [1, 6, 24];

// ---------- 1. 数据：本地 + OKX 补全 ----------
const LOCAL = path.join(process.cwd(), 'data', 'btc_1h_local.json');
const local = JSON.parse(fs.readFileSync(LOCAL, 'utf8'));
const lastT = local[local.length - 1].t;
let tail = [];
try {
  let all = [], after = null;
  for (let i = 0; i < 20; i++) {
    const url = `https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=1H&limit=100${after ? `&after=${after}` : ''}`;
    const out = execSync(`curl -s -m 25 "${url}"`).toString();
    const j = JSON.parse(out);
    if (!j.data || !j.data.length) break;
    for (const r of j.data) all.push({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5] });
    after = j.data[j.data.length - 1][0];
    if (+after < lastT - 2 * 3600 * 1000) break;
  }
  all.sort((a, b) => a.t - b.t);
  tail = all.filter(c => c.t > lastT + 60 * 1000);
  console.log(`[OKX] 抓到 ${all.length} 根, 补全 ${tail.length} 根`);
} catch (e) {
  console.log(`[OKX] 补全失败(${e.message.slice(0, 40)}), 仅用本地数据(至 ${new Date(lastT).toISOString().slice(0, 10)})`);
}
const data = [...local.map(c => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c, vol: c.v })), ...tail].sort((a, b) => a.t - b.t);
console.log(`数据集: ${data.length} 根 | ${new Date(data[0].t).toISOString().slice(0, 10)} ~ ${new Date(data[data.length - 1].t).toISOString().slice(0, 10)}\n`);

// ---------- 2. 基础参数（与线上 V2 默认对齐） ----------
const base = {
  minAtrPct: 0.15, momPeriod: 24, momScale: 2, fastMA: 10, slowMA: 40, trendScale: 0.5,
  wMom: 0.35, wTrend: 0.2, wRsi: 0.1, wBreak: 0.25, volRatio: 1.1, volBoost: 1.15,
  threshold: 0.45, thresholdLong: 0.60, thresholdShort: 0.45, requireTrendAlign: true,
  minAdx: 25, adxPeriod: 14, driftRef: 0.75, driftStrength: 0.3, atrToSigma: 1.3,
  regimeQuietPctile: 0.2, volAdapt: true, volAdaptLo: 0.85, volAdaptHi: 1.35, atrWindow: 168,
  multicycle: false, longMA: 160,
  stopMult: 1.5, stopMin: 1.2, stopMax: 3.0,
};
const wf = (params, segLen = 600, step = 400) => {
  const rows = [];
  for (let s = 80; s + segLen + 24 < data.length; s += step) {
    const seg = data.slice(s, s + segLen);
    const r = runBacktest(seg, 'v2', params, { target: TARGET, horizons: HORIZONS, cooldown: params.cooldownH || 0 });
    const h24 = r.summary.horizons[24] || {};
    rows.push({ from: new Date(seg[0].t).toISOString().slice(0, 10), to: new Date(seg[seg.length - 1].t).toISOString().slice(0, 10), n: h24.n, acc: h24.dirAcc, exp: h24.expectancy, pf: h24.pf });
  }
  return rows;
};

// ---------- 3. Walk-forward 全量（默认参数） ----------
console.log('=== Walk-forward 全量（默认参数） ===');
const wfD = wf({ ...base });
for (const r of wfD) console.log(`  ${r.from}~${r.to}  n=${r.n}  acc=${r.acc}%  exp24=${r.exp}  pf24=${r.pf}`);
const e0 = wfD.map(r => r.exp).filter(x => x != null);
console.log(`  → 24H 正期望段 ${e0.filter(e => e > 0).length}/${e0.length} | 均值期望 ${Math.round(e0.reduce((a, b) => a + b, 0) / e0.length)}\n`);

// ---------- 4. 实盘窗口（09-03~09-24） ----------
const tA = Date.parse('2026-09-03T00:00:00Z'), tB = Date.parse('2026-09-24T23:59:59Z');
let i0 = data.findIndex(d => d.t >= tA), i1 = data.findIndex(d => d.t > tB);
if (i1 < 0) i1 = data.length;
const realSeg = data.slice(Math.max(0, i0), i1);
console.log(`=== 实盘窗口 ${new Date(realSeg[0].t).toISOString().slice(0, 10)}~${new Date(realSeg[realSeg.length - 1].t).toISOString().slice(0, 10)} (${realSeg.length} 根) ===`);
const rd = runBacktest(realSeg, 'v2', { ...base }, { target: TARGET, horizons: HORIZONS, cooldown: base.cooldownH || 0 });
const rh = rd.summary.horizons[24] || {}, rh6 = rd.summary.horizons[6] || {};
console.log(`  默认: n=${rh.n}  acc24=${rh.dirAcc}%  exp24=${rh.expectancy}  pf24=${rh.pf}  |  6H: acc=${rh6.dirAcc}% exp=${rh6.expectancy} pf=${rh6.pf}\n`);

// ---------- 5. 网格扫描（实盘窗口） ----------
console.log('=== 网格扫描（实盘窗口）: threshold × stopMult × minAdx × cooldownH ===');
const grid = { threshold: [0.40, 0.45, 0.50, 0.55, 0.60], stopMult: [1.0, 1.3, 1.5, 2.0], minAdx: [20, 25, 30], cooldownH: [0, 6, 12, 24] };
const results = [];
for (const threshold of grid.threshold)
  for (const stopMult of grid.stopMult)
    for (const minAdx of grid.minAdx)
      for (const cooldownH of grid.cooldownH) {
        const p = { ...base, threshold, thresholdLong: Math.max(threshold, 0.60), thresholdShort: threshold, stopMult, minAdx, cooldownH };
        const r = runBacktest(realSeg, 'v2', p, { target: TARGET, horizons: HORIZONS, cooldown: cooldownH });
        const h24 = r.summary.horizons[24] || {};
        results.push({ threshold, stopMult, minAdx, cooldownH, n: h24.n, acc: h24.dirAcc, exp: h24.expectancy, pf: h24.pf });
      }
const ok = results.filter(r => r.n >= 10 && r.exp > 0 && r.pf > 1).sort((a, b) => b.exp - a.exp);
console.log(`  满足 exp>0 且 pf>1 且 n>=10: ${ok.length}/${results.length}`);
console.log('  Top 12 (按实盘窗口期望):');
console.table(ok.slice(0, 12));

// ---------- 6. 全量验证 Top 组合（防过拟合到实盘窗口） ----------
if (ok.length) {
  console.log('\n=== 全量 walk-forward 验证 Top 5 组合 ===');
  for (const c of ok.slice(0, 5)) {
    const params = { ...base, threshold: c.threshold, thresholdLong: Math.max(c.threshold, 0.60), thresholdShort: c.threshold, stopMult: c.stopMult, minAdx: c.minAdx, cooldownH: c.cooldownH };
    const rows = wf(params);
    const e = rows.map(r => r.exp).filter(x => x != null);
    const p = e.filter(x => x > 0).length;
    const pfAll = rows.map(r => r.pf).filter(x => x != null);
    const avgPf = pfAll.length ? pfAll.reduce((a, b) => a + b, 0) / pfAll.length : 0;
    console.log(`  thr=${c.threshold} sm=${c.stopMult} adx=${c.minAdx} cd=${c.cooldownH} | 实盘: exp=${c.exp} pf=${c.pf} | 全量: 正段 ${p}/${e.length} 均值exp=${Math.round(e.reduce((a, b) => a + b, 0) / e.length)} 均值pf=${avgPf.toFixed(2)}`);
  }
}
console.log('\n=== DONE ===');
