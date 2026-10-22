// 60 天 BTC 1H 历史回放：对比「纯 V2 / 纯 V1 / 市况自适应」三种模式
// 信号与风控逻辑 1:1 复刻 src/worker.js，仅把 5 分钟心跳换成 1H 一根 K 线。
// 用法: node scripts/replay_60d.mjs <data.json> [warmup]

import fs from 'fs';

const DATA = process.argv[2] || '/tmp/okx/okx-60d/okx_60d.json';
const WARMUP = parseInt(process.argv[3] || '200', 10);

// ===================== 常量（与 worker.js 完全一致）=====================
const BIG_MOVE_POINTS = 500;
const V2_POSITION_HOLD_SEC = 12 * 3600;
const V2_STOP_MULT = 1.3, V2_STOP_MIN_PCT = 0.7, V2_STOP_MAX_PCT = 1.5;
const V2_TRAIL_ACTIVATE_ATR = 1.0;
const V2_BE_POINTS = 250, V2_BE_BUFFER = 0.001;
const V2_RUN_POINTS = 500, V2_RUN_TRAIL_ATR = 2.2;
const V2_POSITION_HOLD_SEC_PROFIT = 24 * 3600;
const REGIME_ADX_TREND = 25, REGIME_ADX_FLAT = 18, REGIME_R2_TREND = 0.45, REGIME_R2_CHOP = 0.30;
const REGIME_HYST_BARS = 12;
const V1_STOP_MULT = 1.0, V1_STOP_MIN_PCT = 0.4, V1_STOP_MAX_PCT = 0.9;
const V1_TP_PCT = 0.7;
const V2_LONG_MA = 160;
const PUSH_MIN_PROB_V1 = 0.5, PUSH_MIN_PROB_V2 = 0.45;
const V2 = {
  minAtrPct: 0.15, momPeriod: 24, momScale: 2, fastMA: 10, slowMA: 40,
  trendScale: 0.5, wMom: 0.35, wTrend: 0.2, wRsi: 0.1, wBreak: 0.25,
  volRatio: 1.1, volBoost: 1.15,
  threshold: 0.50, thresholdLong: 0.60, thresholdShort: 0.50,
  requireTrendAlign: true, minAdx: 20, adxPeriod: 14,
  regimeQuietPctile: 0.2, volAdapt: true, volAdaptLo: 0.85, volAdaptHi: 1.35,
  atrWindow: 168, multicycle: false, longMA: 160, resonance: false,
  driftRef: 0.75, driftStrength: 0.3, atrToSigma: 1.3,
};

// ===================== 工具函数（复刻）=====================
function calcRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;
  const deltas = [];
  for (let i = 1; i < prices.length; i++) deltas.push(prices[i] - prices[i - 1]);
  const recent = deltas.slice(-period);
  let gains = 0, losses = 0;
  for (const d of recent) { if (d > 0) gains += d; else losses += Math.abs(d); }
  gains /= period; losses /= period;
  if (losses === 0) return 100;
  return 100 - 100 / (1 + gains / losses);
}
function calcEMA(data, period) {
  const alpha = 2 / (period + 1);
  let result = data[0];
  for (let i = 1; i < data.length; i++) result = alpha * data[i] + (1 - alpha) * result;
  return result;
}
function calcMACD(prices) {
  if (prices.length < 30) return { line: 0, signal: 0, hist: 0 };
  const closes = prices.slice(-30);
  const ema12 = calcEMA(closes, 12), ema26 = calcEMA(closes, 26);
  const macdLine = ema12 - ema26;
  const signal = calcEMA([macdLine], 9);
  return { line: macdLine, signal, hist: macdLine - signal };
}
function calcBB(prices, period = 20) {
  if (prices.length < period) {
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
    return { upper: avg * 1.02, middle: avg, lower: avg * 0.98, width: 4 };
  }
  const recent = prices.slice(-period);
  const avg = recent.reduce((a, b) => a + b, 0) / period;
  const variance = recent.reduce((s, x) => s + (x - avg) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return { upper: avg + 2 * std, lower: avg - 2 * std, width: ((avg + 2 * std - (avg - 2 * std)) / avg) * 100 };
}
function sma(arr, n) {
  if (!arr.length) return 0;
  if (arr.length < n) return arr.reduce((a, b) => a + b, 0) / arr.length;
  return arr.slice(-n).reduce((a, b) => a + b, 0) / n;
}
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
function calcATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return 0;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const tr = Math.max(candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c), Math.abs(candles[i].l - candles[i - 1].c));
    sum += tr;
  }
  return sum / period;
}
function normalCDF(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}
function calcADX(candles, n = 14) {
  if (!candles || candles.length < n * 2 + 2) return null;
  const tr = [], pdm = [], ndm = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].h, l = candles[i].l, pc = candles[i - 1].c, ph = candles[i - 1].h, pl = candles[i - 1].l;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = h - ph, dn = pl - l;
    pdm.push(up > dn && up > 0 ? up : 0); ndm.push(dn > up && dn > 0 ? dn : 0);
  }
  const rma = (a, n) => {
    const out = new Array(a.length).fill(NaN);
    if (a.length < n) return out;
    let prev = 0; for (let i = 0; i < n; i++) prev += a[i]; prev /= n; out[n - 1] = prev;
    for (let i = n; i < a.length; i++) { prev = (prev * (n - 1) + a[i]) / n; out[i] = prev; }
    return out;
  };
  const atrS = rma(tr, n), pS = rma(pdm, n), nS = rma(ndm, n);
  const dx = [];
  for (let i = n - 1; i < tr.length; i++) {
    if (!atrS[i] || !isFinite(atrS[i])) continue;
    const pdi = 100 * pS[i] / atrS[i], ndi = 100 * nS[i] / atrS[i];
    const den = pdi + ndi; dx.push(den > 0 ? 100 * Math.abs(pdi - ndi) / den : 0);
  }
  if (dx.length < n) return null;
  let adx = 0; for (let i = 0; i < n; i++) adx += dx[i]; adx /= n;
  for (let i = n; i < dx.length; i++) adx = (adx * (n - 1) + dx[i]) / n;
  return adx;
}
function trendScore(klines) {
  const N = Math.min(120, klines.length);
  if (N < 10) return { slopePct: 0, r2: 0 };
  const ys = klines.slice(-N).map(k => k.c);
  const n = N, mx = (n - 1) / 2, my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) { const dx = i - mx, dy = ys[i] - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
  const slope = sxy / sxx; const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
  return { slopePct: (slope / my) * 100, r2 };
}
function classifyRegime(klines) {
  const adx = calcADX(klines) ?? 0;
  const { r2 } = trendScore(klines);
  if (adx >= REGIME_ADX_TREND && r2 >= REGIME_R2_TREND) return 'trend';
  if (adx < REGIME_ADX_FLAT) return 'chop';
  if (adx >= REGIME_ADX_TREND && r2 < REGIME_R2_CHOP) return 'chop';
  return r2 >= REGIME_R2_TREND ? 'trend' : 'chop';
}

// ===================== 信号（复刻 analyze / analyzeV2）=====================
function analyze(price, prices) {
  if (prices.length < 10) return { direction: 'WAIT', probability: 0, confidence: 0, predicted_move: 0, rsi: 50, score: 0 };
  let score = 0;
  const rsi = calcRSI(prices);
  if (rsi > 75) score -= 0.35; else if (rsi > 65) score -= 0.15;
  else if (rsi < 25) score += 0.35; else if (rsi < 35) score += 0.15;
  const macd = calcMACD(prices);
  if (macd.hist > 0 && macd.line > macd.signal) score += 0.12;
  else if (macd.hist < 0 && macd.line < macd.signal) score -= 0.12;
  const bb = calcBB(prices);
  const bbPos = (price - bb.lower) / (bb.upper - bb.lower) || 0.5;
  if (bbPos > 0.9) score -= 0.2; else if (bbPos < 0.1) score += 0.2;
  const ma5 = sma(prices.slice(-5), 5), ma10 = sma(prices.slice(-10), 10);
  const ma20 = prices.length >= 20 ? sma(prices.slice(-20), 20) : ma10;
  if (price > ma5 && ma5 > ma10) score += 0.1; else if (price < ma5 && ma5 < ma10) score -= 0.1;
  if (price > ma20) score += 0.05; else score -= 0.05;
  if (prices.length >= 30) {
    const h30 = Math.max(...prices.slice(-30)), l30 = Math.min(...prices.slice(-30));
    const pos30 = (price - l30) / (h30 - l30) || 0.5;
    if (pos30 > 0.85) score -= 0.1; else if (pos30 < 0.15) score += 0.1;
  }
  let direction = 'WAIT';
  if (score > 0.18) direction = 'LONG'; else if (score < -0.18) direction = 'SHORT';
  const confidence = Math.abs(score);
  let histVol = 1500;
  if (prices.length >= 20) {
    const rets = [];
    for (let i = Math.max(1, prices.length - 20); i < prices.length; i++) rets.push(Math.abs(prices[i] - prices[i - 1]) / prices[i - 1]);
    histVol = (rets.reduce((a, b) => a + b, 0) / rets.length) * prices[prices.length - 1] * 5;
  }
  const predictedMove = histVol * (1 + Math.abs(score) * 0.5);
  let prob500 = Math.min(0.95, predictedMove / 500 * 0.35 + confidence * 0.5 + (bb.width > 8 ? 1 : 0.6) * 0.15);
  if (direction === 'WAIT') prob500 = 0;
  return { direction, probability: +prob500.toFixed(3), confidence: +confidence.toFixed(3), predicted_move: Math.round(predictedMove), rsi: +rsi.toFixed(1), score: +score.toFixed(3) };
}
function analyzeV2(klines, price) {
  const blank = () => ({ direction: 'WAIT', probability: 0, atrPct: 0 });
  if (!klines || klines.length < 60) return blank();
  const closes = klines.map(k => k.c);
  const atr = calcATR(klines, 14);
  const atrPct = (atr / price) * 100;
  let atrPctile = 0.5;
  if (klines.length >= (V2.atrWindow || 168) + 14) {
    const series = []; const w = V2.atrWindow || 168;
    for (let i = klines.length - w; i < klines.length; i++) {
      const a = calcATR(klines.slice(0, i + 1), 14); if (a > 0) series.push((a / klines[i].c) * 100);
    }
    if (series.length) atrPctile = series.filter(x => x < atrPct).length / series.length;
  }
  if (atrPct < V2.minAtrPct) return blank();
  const adx = calcADX(klines, V2.adxPeriod);
  if (V2.minAdx && adx !== null && adx < V2.minAdx) return blank();
  if (V2.regimeQuietPctile && atrPctile < V2.regimeQuietPctile) return blank();
  const momN = V2.momPeriod;
  const mom = (price - closes[closes.length - 1 - momN]) / closes[closes.length - 1 - momN] * 100;
  const maFast = sma(closes, V2.fastMA), maSlow = sma(closes, V2.slowMA);
  const trend = maFast > maSlow ? 'up' : 'down';
  const prev = klines.slice(0, -1).slice(-24);
  const hh = Math.max(...prev.map(k => k.h)), ll = Math.min(...prev.map(k => k.l));
  const breakUp = price > hh, breakDown = price < ll;
  const rsi = calcRSI(closes, 14);
  const rsiMom = (rsi - 50) / 50;
  const vols = klines.map(k => k.vol);
  const volNow = sma(vols.slice(-12), 12), volPrev = sma(vols.slice(-24, -12), 12);
  const volRatio = volPrev > 0 ? volNow / volPrev : 1;
  let score = 0;
  score += clamp(mom / V2.momScale, -1, 1) * V2.wMom;
  score += clamp(((maFast - maSlow) / maSlow * 100) / V2.trendScale, -1, 1) * V2.wTrend;
  score += rsiMom * V2.wRsi;
  if (breakUp) score += V2.wBreak; if (breakDown) score -= V2.wBreak;
  if (volRatio > V2.volRatio) score *= V2.volBoost;
  let volAdj = 1;
  if (V2.volAdapt) volAdj = Math.min(V2.volAdaptHi, Math.max(V2.volAdaptLo, 0.85 + atrPctile));
  const thrLong = (V2.thresholdLong ?? V2.threshold) * volAdj;
  const thrShort = (V2.thresholdShort ?? V2.threshold) * volAdj;
  let direction = 'WAIT';
  if (score > thrLong) direction = 'LONG'; else if (score < -thrShort) direction = 'SHORT';
  if (V2.requireTrendAlign && direction !== 'WAIT') {
    const aligned = (direction === 'LONG' && trend === 'up') || (direction === 'SHORT' && trend === 'down');
    if (!aligned) direction = 'WAIT';
  }
  if (V2.multicycle && direction !== 'WAIT') {
    const longMA = sma(closes, V2.longMA), longTrendUp = price > longMA;
    if (!((direction === 'LONG' && longTrendUp) || (direction === 'SHORT' && !longTrendUp))) direction = 'WAIT';
  }
  const sigma1h = atr / V2.atrToSigma, sigma24 = sigma1h * Math.sqrt(24);
  const baseMove24 = 0.7979 * sigma24;
  const predictedMove = baseMove24 * (1 + Math.abs(score) * 0.3);
  const mu = sigma24 * V2.driftStrength * Math.min(1, Math.abs(score) / V2.driftRef);
  const z = (BIG_MOVE_POINTS - mu) / sigma24;
  const probAtCurrentScore = 1 - normalCDF(z);
  let probability = 0;
  if (direction !== 'WAIT') probability = probAtCurrentScore;
  return { direction, probability: +probability.toFixed(3), confidence: +Math.abs(score).toFixed(3), predicted_move: Math.round(predictedMove), atrPct: +atrPct.toFixed(3), score: +score.toFixed(3) };
}

// ===================== 回放引擎 =====================
function runReplay(bars, mode) {
  const N = bars.length;
  const trades = [];
  let pos = null;
  // 自适应状态
  let active = mode === 'adaptive' ? 'v2' : mode;  // 初始给趋势
  let regimeWant = active, regimeWantBars = 0;
  let trendBars = 0, chopBars = 0;

  for (let i = 0; i < N; i++) {
    const bar = bars[i];
    const klines = bars.slice(0, i + 1);
    const prices = bars.slice(0, i + 1).map(b => b.c);
    const t = bar.t / 1000;

    // 1) 管理已有持仓（用本根 K 线 OHLC 检测离场 / 移动止损）
    if (pos) {
      const isLong = pos.dir === 'LONG';
      const high = bar.h, low = bar.l, close = bar.c;
      const atr = pos.entry * pos.atrPct / 100;
      // 移动止损激活
      if (!pos.trailingActive) {
        if (isLong && high >= pos.entry + atr) pos.trailingActive = true;
        if (!isLong && low <= pos.entry - atr) pos.trailingActive = true;
      }
      // 保本锁（用极值判断本根是否曾触达 +250）
      const extremeProfit = isLong ? high - pos.entry : pos.entry - low;
      if (extremeProfit >= V2_BE_POINTS) {
        const be = isLong ? pos.entry * (1 + V2_BE_BUFFER) : pos.entry * (1 - V2_BE_BUFFER);
        pos.stop = isLong ? Math.max(pos.stop, be) : Math.min(pos.stop, be);
        pos.beLocked = true;
      }
      // 跟踪极值
      if (isLong) pos.best = Math.max(pos.best, high); else pos.best = Math.min(pos.best, low);
      if (pos.trailingActive) {
        const trail = (pos.strategy !== 'v1' && extremeProfit >= V2_RUN_POINTS)
          ? Math.max(pos.stopPct, V2_RUN_TRAIL_ATR * pos.atrPct) : pos.stopPct;
        pos.stop = isLong ? Math.max(pos.stop, pos.best * (1 - trail / 100))
                          : Math.min(pos.stop, pos.best * (1 + trail / 100));
      }
      // 离场判定：止盈(V1) / 止损 / 到期
      let exit = null;
      if (pos.takeProfit) {
        if (isLong && high >= pos.takeProfit) exit = { kind: '止盈', px: pos.takeProfit };
        else if (!isLong && low <= pos.takeProfit) exit = { kind: '止盈', px: pos.takeProfit };
      }
      if (!exit) {
        if (isLong && low <= pos.stop) exit = { kind: '止损', px: Math.max(low, pos.stop) };
        else if (!isLong && high >= pos.stop) exit = { kind: '止损', px: Math.min(high, pos.stop) };
      }
      const held = t - pos.entryTime;
      const holdLimit = (pos.strategy !== 'v1' && pos.beLocked) ? V2_POSITION_HOLD_SEC_PROFIT : V2_POSITION_HOLD_SEC;
      if (!exit && held >= holdLimit) exit = { kind: '到期', px: close };

      if (exit) {
        const pnl = Math.round(isLong ? exit.px - pos.entry : pos.entry - exit.px);
        trades.push({ entryT: pos.entryTime, exitT: t, dir: pos.dir, strat: pos.strategy,
          entry: Math.round(pos.entry), exit: Math.round(exit.px), pnl, kind: exit.kind });
        pos = null;
      }
    }

    // 2) 决定当前策略（自适应模式）
    if (mode === 'adaptive') {
      const regime = classifyRegime(klines);
      if (regime === 'trend') trendBars++; else chopBars++;
      const want = regime === 'trend' ? 'v2' : 'v1';
      if (regimeWant !== want) { regimeWant = want; regimeWantBars = 0; }
      else regimeWantBars++;
      if (active !== want && regimeWantBars >= REGIME_HYST_BARS && !pos) active = want;
    } else {
      const regime = classifyRegime(klines);
      if (regime === 'trend') trendBars++; else chopBars++;
    }

    // 3) 开仓（需无持仓 + 过 warmup）
    if (!pos && i >= WARMUP) {
      const sig = active === 'v2' ? analyzeV2(klines, bar.c) : analyze(bar.c, prices);
      const minProb = active === 'v2' ? PUSH_MIN_PROB_V2 : PUSH_MIN_PROB_V1;
      if (sig.direction !== 'WAIT' && sig.probability >= minProb) {
        const isLong = sig.direction === 'LONG';
        const atrPct = sig.atrPct || (active === 'v2' ? 0.3 : 0.3);
        const stopPct = active === 'v1'
          ? Math.min(V1_STOP_MAX_PCT, Math.max(V1_STOP_MIN_PCT, atrPct * V1_STOP_MULT))
          : Math.min(V2_STOP_MAX_PCT, Math.max(V2_STOP_MIN_PCT, atrPct * V2_STOP_MULT));
        const stop = isLong ? bar.c * (1 - stopPct / 100) : bar.c * (1 + stopPct / 100);
        const takeProfit = active === 'v1'
          ? (isLong ? bar.c * (1 + V1_TP_PCT / 100) : bar.c * (1 - V1_TP_PCT / 100)) : null;
        pos = { dir: sig.direction, entry: bar.c, entryTime: t, strategy: active,
          atrPct, stopPct, stop, takeProfit, best: bar.c, trailingActive: false, beLocked: false };
      }
    }
  }
  // 统计
  const n = trades.length;
  const wins = trades.filter(x => x.pnl > 0), losses = trades.filter(x => x.pnl <= 0);
  const total = trades.reduce((a, x) => a + x.pnl, 0);
  const avgWin = wins.length ? wins.reduce((a, x) => a + x.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, x) => a + x.pnl, 0) / losses.length : 0;
  const grossWin = wins.reduce((a, x) => a + x.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, x) => a + x.pnl, 0));
  const pf = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0);
  const winRate = n ? wins.length / n * 100 : 0;
  const maxLoss = losses.length ? Math.min(...losses.map(x => x.pnl)) : 0;
  const bigWins = trades.filter(x => x.pnl >= 1000).length;
  return { mode, n, winRate, total, avgWin: Math.round(avgWin), avgLoss: Math.round(avgLoss),
    pf: +pf.toFixed(2), maxLoss: Math.round(maxLoss), bigWins,
    trendBars, chopBars,
    trendPct: +((trendBars / (trendBars + chopBars)) * 100).toFixed(1) };
}

// ===================== 主程序 =====================
const raw = JSON.parse(fs.readFileSync(DATA, 'utf8'));
// 升序，构造 {t,o,h,l,c,vol}
const bars = raw.map(b => ({ t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, vol: b.vol }));
console.log(`数据: ${bars.length} 根 1H K线, ${new Date(bars[0].t/1000).toISOString().slice(0,10)} ~ ${new Date(bars.at(-1).t/1000).toISOString().slice(0,10)}`);
console.log(`warmup = ${WARMUP} 根\n`);

const modes = ['v2', 'v1', 'adaptive'];
const results = {};
for (const m of modes) results[m] = runReplay(bars, m);

const fmt = (r) => `${String(r.n).padStart(4)}笔 | 胜率 ${r.winRate.toFixed(1).padStart(5)}% | 总 ${String(r.total).padStart(7)}点 | 均盈 ${String(r.avgWin).padStart(6)} | 均亏 ${String(r.avgLoss).padStart(6)} | PF ${String(r.pf).padStart(6)} | 最大亏 ${String(r.maxLoss).padStart(6)} | ≥1000点 ${r.bigWins}笔`;
console.log('=== 回放结果对比 ===');
for (const m of modes) console.log(`${m.padEnd(9)}: ${fmt(results[m])}`);
console.log('\n=== 市况分布（自适应判定）===');
console.log(`trend(跑V2)占比: ${results.adaptive.trendPct}%  |  chop(跑V1)占比: ${(100-results.adaptive.trendPct).toFixed(1)}%  (趋势${results.adaptive.trendBars}根/震荡${results.adaptive.chopBars}根)`);

console.log('\n=== 详细逐笔（自适应）===');
// 重新跑一次拿 trades 明细
function runDetail(bars, mode) {
  const N = bars.length; const trades = []; let pos = null;
  let active = 'v2', regimeWant = 'v2', regimeWantBars = 0;
  for (let i = 0; i < N; i++) {
    const bar = bars[i]; const klines = bars.slice(0, i + 1);
    const prices = bars.slice(0, i + 1).map(b => b.c); const t = bar.t / 1000;
    if (pos) {
      const isLong = pos.dir === 'LONG'; const high = bar.h, low = bar.l, close = bar.c;
      const atr = pos.entry * pos.atrPct / 100;
      if (!pos.trailingActive) { if (isLong && high >= pos.entry + atr) pos.trailingActive = true; if (!isLong && low <= pos.entry - atr) pos.trailingActive = true; }
      const ep = isLong ? high - pos.entry : pos.entry - low;
      if (ep >= V2_BE_POINTS) { const be = isLong ? pos.entry*(1+V2_BE_BUFFER) : pos.entry*(1-V2_BE_BUFFER); pos.stop = isLong ? Math.max(pos.stop,be) : Math.min(pos.stop,be); pos.beLocked = true; }
      if (isLong) pos.best = Math.max(pos.best, high); else pos.best = Math.min(pos.best, low);
      if (pos.trailingActive) { const trail = (pos.strategy!=='v1' && ep >= V2_RUN_POINTS) ? Math.max(pos.stopPct, V2_RUN_TRAIL_ATR*pos.atrPct) : pos.stopPct; pos.stop = isLong ? Math.max(pos.stop, pos.best*(1-trail/100)) : Math.min(pos.stop, pos.best*(1+trail/100)); }
      let exit = null;
      if (pos.takeProfit) { if (isLong && high >= pos.takeProfit) exit = {kind:'止盈',px:pos.takeProfit}; else if (!isLong && low <= pos.takeProfit) exit = {kind:'止盈',px:pos.takeProfit}; }
      if (!exit) { if (isLong && low <= pos.stop) exit = {kind:'止损',px:Math.max(low,pos.stop)}; else if (!isLong && high >= pos.stop) exit = {kind:'止损',px:Math.min(high,pos.stop)}; }
      const held = t - pos.entryTime; const holdLimit = (pos.strategy!=='v1' && pos.beLocked) ? V2_POSITION_HOLD_SEC_PROFIT : V2_POSITION_HOLD_SEC;
      if (!exit && held >= holdLimit) exit = {kind:'到期',px:close};
      if (exit) { const pnl = Math.round(isLong ? exit.px-pos.entry : pos.entry-exit.px); trades.push({entryT:pos.entryTime,exitT:t,dir:pos.dir,strat:pos.strategy,entry:Math.round(pos.entry),exit:Math.round(exit.px),pnl,kind:exit.kind}); pos = null; }
    }
    if (mode === 'adaptive') {
      const regime = classifyRegime(klines); const want = regime === 'trend' ? 'v2' : 'v1';
      if (regimeWant !== want) { regimeWant = want; regimeWantBars = 0; } else regimeWantBars++;
      if (active !== want && regimeWantBars >= REGIME_HYST_BARS && !pos) active = want;
    }
    if (!pos && i >= WARMUP) {
      const sig = active === 'v2' ? analyzeV2(klines, bar.c) : analyze(bar.c, prices);
      const minProb = active === 'v2' ? PUSH_MIN_PROB_V2 : PUSH_MIN_PROB_V1;
      if (sig.direction !== 'WAIT' && sig.probability >= minProb) {
        const isLong = sig.direction === 'LONG'; const atrPct = sig.atrPct || 0.3;
        const stopPct = active === 'v1' ? Math.min(V1_STOP_MAX_PCT, Math.max(V1_STOP_MIN_PCT, atrPct*V1_STOP_MULT)) : Math.min(V2_STOP_MAX_PCT, Math.max(V2_STOP_MIN_PCT, atrPct*V2_STOP_MULT));
        const stop = isLong ? bar.c*(1-stopPct/100) : bar.c*(1+stopPct/100);
        const takeProfit = active === 'v1' ? (isLong ? bar.c*(1+V1_TP_PCT/100) : bar.c*(1-V1_TP_PCT/100)) : null;
        pos = { dir: sig.direction, entry: bar.c, entryTime: t, strategy: active, atrPct, stopPct, stop, takeProfit, best: bar.c, trailingActive: false, beLocked: false };
      }
    }
  }
  return trades;
}
const det = runDetail(bars, 'adaptive');
for (const tr of det) {
  console.log(`${new Date(tr.entryT*1000).toISOString().slice(5,16)} ${tr.strat.padEnd(2)} ${tr.dir.padEnd(5)} 开 ${String(tr.entry).padStart(6)} → 离 ${String(tr.exit).padStart(6)} (${tr.kind})  ${tr.pnl>=0?'+':''}${tr.pnl}`);
}
fs.writeFileSync('/tmp/replay_adaptive_trades.json', JSON.stringify(det, null, 2));
