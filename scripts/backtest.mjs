/**
 * BTC 策略离线回测引擎
 *
 * 为什么要这个：
 *   线上系统 500 点达标率 0%、方向准确率不稳定，靠拍脑袋调参数无法验证。
 *   这里用 OKX 真实历史 K 线，对多个策略族做网格搜索，用数据决定参数。
 *
 * 运行方式：
 *   node scripts/backtest.mjs              本地跑（需要能访问 OKX）
 *   GITHUB ACTIONS: workflow_dispatch 触发，结果作为 artifact 下载
 *
 * 输出：
 *   - 控制台可读报告
 *   - backtest_report.json（供进一步分析）
 */

const OKX_KLINE = 'https://www.okx.com/api/v5/market/history-candles';
const OKX_KLINE_LIVE = 'https://www.okx.com/api/v5/market/candles';

// ============================================================
// 数据获取
// ============================================================
async function fetchCandles(bar = '1H', total = 1000) {
  const out = [];
  const perReq = 100; // OKX 单次上限 100（history-candles）
  let after = null;

  while (out.length < total) {
    let url = `${OKX_KLINE}?instId=BTC-USDT&bar=${bar}&limit=${perReq}`;
    if (after) url += `&after=${after}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': 'BTC-Backtest/1.0' },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) throw new Error(`OKX HTTP ${resp.status}`);
    const j = await resp.json();
    if (j.code !== '0' || !Array.isArray(j.data) || j.data.length === 0) break;

    // OKX 返回: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]
    // 时间倒序（最新在前）
    for (const d of j.data) {
      out.push({
        t: parseInt(d[0]),
        o: parseFloat(d[1]),
        h: parseFloat(d[2]),
        l: parseFloat(d[3]),
        c: parseFloat(d[4]),
        vol: parseFloat(d[5]),
      });
    }
    // next page: 用最早一根的时间戳
    after = j.data[j.data.length - 1][0];
    if (j.data.length < perReq) break;
  }

  // 去重 + 按时间升序
  const seen = new Set();
  const clean = [];
  for (const c of out) {
    if (seen.has(c.t)) continue;
    seen.add(c.t);
    clean.push(c);
  }
  clean.sort((a, b) => a.t - b.t);
  return clean.slice(-total);
}

// ============================================================
// 技术指标
// ============================================================
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gain = 0, loss = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d; else loss -= d;
  }
  if (loss === 0) return 100;
  const rs = (gain / period) / (loss / period);
  return 100 - 100 / (1 + rs);
}

function calcEMA(arr, period) {
  const k = 2 / (period + 1);
  let ema = arr[0];
  for (let i = 1; i < arr.length; i++) ema = arr[i] * k + ema * (1 - k);
  return ema;
}

function calcMACD(closes) {
  if (closes.length < 26) return { hist: 0, line: 0, signal: 0 };
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const line = ema12 - ema26;
  // signal: EMA(9) of macd line（这里用简化：对最近9个 line 值求 EMA）
  const lines = [];
  for (let i = Math.max(0, closes.length - 12); i < closes.length; i++) {
    const sub = closes.slice(0, i + 1);
    if (sub.length < 26) continue;
    lines.push(calcEMA(sub, 12) - calcEMA(sub, 26));
  }
  const signal = lines.length >= 2 ? calcEMA(lines, Math.min(9, lines.length)) : line;
  return { line, signal, hist: line - signal };
}

function calcBB(closes, period = 20, mult = 2) {
  if (closes.length < period) return { upper: 0, middle: 0, lower: 0, width: 0, pos: 0.5 };
  const recent = closes.slice(-period);
  const avg = recent.reduce((a, b) => a + b, 0) / period;
  const variance = recent.reduce((s, x) => s + (x - avg) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  const upper = avg + mult * std;
  const lower = avg - mult * std;
  const last = closes[closes.length - 1];
  return {
    upper, middle: avg, lower,
    width: (upper - lower) / avg * 100,
    pos: (upper - lower) > 0 ? (last - lower) / (upper - lower) : 0.5,
  };
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i - 1].c),
      Math.abs(candles[i].l - candles[i - 1].c)
    );
    sum += tr;
  }
  return sum / period;
}

function sma(arr, n) {
  if (arr.length < n) return arr.reduce((a, b) => a + b, 0) / arr.length;
  return arr.slice(-n).reduce((a, b) => a + b, 0) / n;
}

// ============================================================
// 策略族
// ============================================================

/**
 * A. 均值回归（当前线上策略的等价实现）
 * RSI 超买做空、超卖做多，叠加 MACD / 布林带位置 / 均线
 */
function strategyMeanReversion(candles, p = {}) {
  const closes = candles.map(c => c.c);
  if (closes.length < 30) return { dir: 'WAIT', strength: 0 };

  const rsi = calcRSI(closes, p.rsiPeriod || 14);
  const macd = calcMACD(closes);
  const bb = calcBB(closes, p.bbPeriod || 20, 2);
  const price = closes[closes.length - 1];
  const ma5 = sma(closes, 5), ma10 = sma(closes, 10), ma20 = sma(closes, 20);

  let score = 0;
  if (rsi > 75) score -= 0.35;
  else if (rsi > 65) score -= 0.15;
  else if (rsi < 25) score += 0.35;
  else if (rsi < 35) score += 0.15;

  if (macd.hist > 0 && macd.line > macd.signal) score += 0.12;
  else if (macd.hist < 0 && macd.line < macd.signal) score -= 0.12;

  if (bb.pos > 0.9) score -= 0.2;
  else if (bb.pos < 0.1) score += 0.2;

  if (price > ma5 && ma5 > ma10) score += 0.1;
  else if (price < ma5 && ma5 < ma10) score -= 0.1;
  if (price > ma20) score += 0.05; else score -= 0.05;

  const h30 = Math.max(...closes.slice(-30));
  const l30 = Math.min(...closes.slice(-30));
  const pos30 = (price - l30) / (h30 - l30) || 0.5;
  if (pos30 > 0.85) score -= 0.1;
  else if (pos30 < 0.15) score += 0.1;

  const thr = p.threshold ?? 0.18;
  return { dir: score > thr ? 'LONG' : score < -thr ? 'SHORT' : 'WAIT', strength: Math.abs(score), score };
}

/**
 * B. 趋势突破
 * 价格突破 N 周期高点做多、跌破低点做空，用 ATR 过滤假突破
 */
function strategyBreakout(candles, p = {}) {
  if (candles.length < (p.lookback || 24) + 20) return { dir: 'WAIT', strength: 0 };
  const n = p.lookback || 24;
  const closes = candles.map(c => c.c);
  const price = closes[closes.length - 1];

  // 排除当前 K 线本身，避免自指
  const prev = candles.slice(0, -1).slice(-n);
  const hh = Math.max(...prev.map(c => c.h));
  const ll = Math.min(...prev.map(c => c.l));

  const atr = calcATR(candles, p.atrPeriod || 14);
  const atrPct = atr / price * 100;

  // 波动率过滤：太安静的市不参与（假突破多）
  if (atrPct < (p.minAtrPct || 0.15)) return { dir: 'WAIT', strength: 0 };

  const buf = (p.buffer ?? 0.15) / 100 * price;
  if (price > hh + buf) return { dir: 'LONG', strength: 1, score: 1 };
  if (price < ll - buf) return { dir: 'SHORT', strength: 1, score: -1 };
  return { dir: 'WAIT', strength: 0 };
}

/**
 * C. 布林带挤压后突破（波动率压缩 → 扩张）
 * 布林带宽度处于历史低位（市场蓄势），价格突破轨道时进场
 */
function strategySqueeze(candles, p = {}) {
  const closes = candles.map(c => c.c);
  if (closes.length < (p.bbPeriod || 20) + 60) return { dir: 'WAIT', strength: 0 };

  const period = p.bbPeriod || 20;
  const bb = calcBB(closes, period, p.bbMult || 2);
  const price = closes[closes.length - 1];

  // 计算历史布林带宽分位数
  const widths = [];
  for (let i = closes.length - 60; i < closes.length; i++) {
    if (i < period) continue;
    widths.push(calcBB(closes.slice(0, i + 1), period, p.bbMult || 2).width);
  }
  if (widths.length < 10) return { dir: 'WAIT', strength: 0 };
  const sorted = [...widths].sort((a, b) => a - b);
  const quantile = sorted[Math.floor(sorted.length * (p.squeezeQ || 0.25))];

  // 挤压条件：当前宽度低于分位数
  if (bb.width > quantile) return { dir: 'WAIT', strength: 0 };

  // 突破方向
  if (price > bb.upper) return { dir: 'LONG', strength: 1, score: 1 };
  if (price < bb.lower) return { dir: 'SHORT', strength: 1, score: -1 };
  return { dir: 'WAIT', strength: 0 };
}

/**
 * D. 动量策略
 * 过去 N 根 K 线的收益率 + 成交量放大确认
 */
function strategyMomentum(candles, p = {}) {
  const closes = candles.map(c => c.c);
  const n = p.momPeriod || 12;
  if (closes.length < n + 30) return { dir: 'WAIT', strength: 0 };

  const price = closes[closes.length - 1];
  const past = closes[closes.length - 1 - n];
  const ret = (price - past) / past * 100;

  // 成交量确认：近期均量 vs 更早均量
  const vols = candles.map(c => (c.vol ?? c.v ?? 0));  // 兼容 vol/v 两种字段名
  const volNow = sma(vols.slice(-n), n);
  const volPrev = sma(vols.slice(-n * 2, -n), n);
  const volRatio = volPrev > 0 ? volNow / volPrev : 1;

  const atr = calcATR(candles, 14);
  const atrPct = atr / price * 100;
  if (atrPct < (p.minAtrPct || 0.15)) return { dir: 'WAIT', strength: 0 };

  const thr = p.momThreshold ?? 0.8; // 百分比
  const volOk = (p.requireVolume === false) || volRatio > (p.volRatio || 1.0);

  if (ret > thr && volOk) return { dir: 'LONG', strength: Math.abs(ret), score: 1 };
  if (ret < -thr && volOk) return { dir: 'SHORT', strength: Math.abs(ret), score: -1 };
  return { dir: 'WAIT', strength: 0 };
}

/**
 * E. 混合：趋势方向 + 回调进场
 * 大周期定方向（MA 排列），小周期找回调位（RSI 回落）
 */
function strategyTrendPullback(candles, p = {}) {
  const closes = candles.map(c => c.c);
  if (closes.length < 60) return { dir: 'WAIT', strength: 0 };
  const price = closes[closes.length - 1];
  const maFast = sma(closes, p.fastMA || 10);
  const maSlow = sma(closes, p.slowMA || 40);
  const rsi = calcRSI(closes, 14);
  const atr = calcATR(candles, 14);
  const atrPct = atr / price * 100;
  if (atrPct < (p.minAtrPct || 0.15)) return { dir: 'WAIT', strength: 0 };

  const upTrend = maFast > maSlow * (1 + (p.trendGap ?? 0.1) / 100);
  const downTrend = maFast < maSlow * (1 - (p.trendGap ?? 0.1) / 100);

  // 上升趋势中回调到超卖附近 → 做多
  if (upTrend && rsi < (p.rsiEntry || 45) && price > maSlow) {
    return { dir: 'LONG', strength: 1, score: 1 };
  }
  // 下降趋势中反弹到超买附近 → 做空
  if (downTrend && rsi > (100 - (p.rsiEntry || 45)) && price < maSlow) {
    return { dir: 'SHORT', strength: 1, score: -1 };
  }
  return { dir: 'WAIT', strength: 0 };
}

/**
 * F. V2 候选策略：趋势跟随 + 波动率门槛
 *
 * 设计理由（针对现行系统的三个实证缺陷）：
 *   1. 周期错配：500 点在 1H 窗口概率仅 15.8%，24H 窗口 41.9%
 *      → 本策略以 24H 为目标窗口，不再用 1H 判定
 *   2. 均值回归在趋势行情中持续亏损（合成数据 24H 期望 -66 点）
 *      → 改为趋势跟随：动量 + 均线排列 + 突破，RSI 只作动量确认不做反转
 *   3. 低波动期推送无意义（此时 500 点不可能达成）
 *      → 加 ATR 门槛，波动率不足直接不发信号
 */
function strategyV2(candles, p = {}) {
  const closes = candles.map(c => c.c);
  if (closes.length < 60) return { dir: 'WAIT', strength: 0, score: 0 };

  const price = closes[closes.length - 1];
  const atr = calcATR(candles, p.atrPeriod || 14);
  const atrPct = atr / price * 100;

  // 波动率门槛：太安静的市不参与（500 点目标不现实）
  if (atrPct < (p.minAtrPct ?? 0.25)) return { dir: 'WAIT', strength: 0, score: 0 };

  // 动量（主权重）：过去 N 根收益率
  const momN = p.momPeriod || 24;
  const past = closes[closes.length - 1 - momN];
  const mom = (price - past) / past * 100;

  // 均线排列（趋势方向）
  const maFast = sma(closes, p.fastMA || 10);
  const maSlow = sma(closes, p.slowMA || 40);
  const trendScore = (maFast - maSlow) / maSlow * 100;

  // 突破：相对最近 N 根（不含当前）的高低点
  const lookback = p.breakLookback || 24;
  const prev = candles.slice(0, -1).slice(-lookback);
  const hh = Math.max(...prev.map(c => c.h));
  const ll = Math.min(...prev.map(c => c.l));
  const breakUp = price > hh;
  const breakDown = price < ll;

  // 成交量确认
  const vols = candles.map(c => (c.vol ?? c.v ?? 0));  // 兼容 vol/v 两种字段名
  const volNow = sma(vols.slice(-12), 12);
  const volPrev = sma(vols.slice(-24, -12), 12);
  const volRatio = volPrev > 0 ? volNow / volPrev : 1;

  // RSI 仅作动量确认（不再做反转信号）
  const rsi = calcRSI(closes, 14);
  const rsiMomentum = (rsi - 50) / 50;   // +1 表示强动量，-1 表示弱

  // 过热衰减：动量绝对值超过 momCap(%) 后线性衰减，到 momKill(%) 归零。
  // 动机 —— 实盘 2026-09-04 的教训：BTC 24H 急涨到 81,300（局部顶），
  // 动量分量早已饱和（±2% 即打满），score 冲到 0.9 发出强 LONG，
  // 结果 6H 后跌到 79,729，单笔亏 1570 点。
  // 动量的信息在趋势中段最有效，到了急涨/急跌末端反而是反转风险最高的位置。
  let momTerm = clamp(mom / (p.momScale ?? 2), -1, 1);
  if (p.momCap) {
    const a = Math.abs(mom);
    const kill = p.momKill ?? p.momCap * 2;
    if (a > p.momCap && kill > p.momCap) {
      momTerm *= Math.max(0, 1 - (a - p.momCap) / (kill - p.momCap));
    }
  }

  let score = 0;
  score += momTerm * (p.wMom ?? 0.35);
  score += clamp(trendScore / (p.trendScale ?? 0.5), -1, 1) * (p.wTrend ?? 0.2);
  score += rsiMomentum * (p.wRsi ?? 0.1);
  if (breakUp) score += (p.wBreak ?? 0.25);
  if (breakDown) score -= (p.wBreak ?? 0.25);
  if (p.requireVolume !== false && volRatio > (p.volRatio ?? 1.1)) {
    score *= (p.volBoost ?? 1.15);   // 放量增强信号
  }

  const thr = p.threshold ?? 0.25;
  const dir = score > thr ? 'LONG' : score < -thr ? 'SHORT' : 'WAIT';
  return { dir, strength: Math.abs(score), score };
}

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/**
 * G. 组合策略：趋势跟随为主，布林挤压突破为辅（捕捉波动率扩张）
 */
function strategyV2Squeeze(candles, p = {}) {
  const r = strategyV2(candles, p);
  if (r.dir !== 'WAIT') return r;
  // 主策略无信号时，尝试挤压突破
  const sq = strategySqueeze(candles, {
    bbPeriod: p.bbPeriod || 20,
    squeezeQ: p.squeezeQ || 0.25,
    bbMult: p.bbMult || 2,
  });
  return sq;
}

const STRATEGIES = {
  meanReversion: { fn: strategyMeanReversion, name: '均值回归(现行策略)' },
  breakout: { fn: strategyBreakout, name: '趋势突破' },
  squeeze: { fn: strategySqueeze, name: '布林挤压突破' },
  momentum: { fn: strategyMomentum, name: '动量' },
  trendPullback: { fn: strategyTrendPullback, name: '趋势回调' },
  v2: { fn: strategyV2, name: 'V2趋势跟随' },
  v2squeeze: { fn: strategyV2Squeeze, name: 'V2+挤压突破' },
};

// ============================================================
// 回测执行
// ============================================================
function runBacktest(candles, strategyName, params = {}, opts = {}) {
  const target = opts.target || 500;          // 目标点数
  const horizons = opts.horizons || [1, 6, 24]; // 验证窗口（单位 = K线根数）
  const maxFwd = Math.max(...horizons);
  const strat = STRATEGIES[strategyName].fn;
  const cooldown = opts.cooldown || 0;        // 信号冷却（根数）

  const trades = [];
  let lastSignalIdx = -999;

  for (let i = 80; i < candles.length - maxFwd; i++) {
    const window = candles.slice(0, i + 1);
    const sig = strat(window, params);
    if (sig.dir === 'WAIT') continue;
    if (i - lastSignalIdx < cooldown) continue;
    lastSignalIdx = i;

    const entry = candles[i].c;
    const rec = { idx: i, t: candles[i].t, dir: sig.dir, entry, strength: sig.strength };

    for (const h of horizons) {
      const fwd = candles[i + h];
      if (!fwd) continue;
      const diff = fwd.c - entry;
      rec[`p_${h}`] = diff;                       // 点数变化（带符号）
      rec[`hit_${h}`] = Math.abs(diff) >= target;
      rec[`ok_${h}`] = sig.dir === 'LONG' ? diff > 0 : diff < 0;
    }

    // 最大有利波动 MFE / 最大不利波动 MAE（取最大窗口内）
    let mfe = 0, mae = 0;
    for (let k = 1; k <= maxFwd && i + k < candles.length; k++) {
      const hi = candles[i + k].h - entry;
      const lo = candles[i + k].l - entry;
      if (sig.dir === 'LONG') {
        mfe = Math.max(mfe, hi);
        mae = Math.min(mae, lo);
      } else {
        mfe = Math.max(mfe, -lo);
        mae = Math.min(mae, -hi);
      }
    }
    rec.mfe = mfe;
    rec.mae = mae;
    trades.push(rec);
  }

  return { trades, summary: summarize(trades, horizons, target) };
}

function summarize(trades, horizons, target) {
  const out = { n: trades.length, horizons: {} };
  if (!trades.length) return out;

  for (const h of horizons) {
    const okKey = `ok_${h}`, pKey = `p_${h}`, hitKey = `hit_${h}`;
    const valid = trades.filter(t => t[pKey] !== undefined);
    if (!valid.length) { out.horizons[h] = { n: 0 }; continue; }
    const okCount = valid.filter(t => t[okKey]).length;
    const hitCount = valid.filter(t => t[hitKey]).length;
    // 方向正确的平均收益 / 方向错误的平均亏损
    const wins = valid.filter(t => t[okKey]).map(t => Math.abs(t[pKey]));
    const losses = valid.filter(t => !t[okKey]).map(t => -Math.abs(t[pKey]));
    out.horizons[h] = {
      n: valid.length,
      dirAcc: +(okCount / valid.length * 100).toFixed(1),
      hitRate: +(hitCount / valid.length * 100).toFixed(1),
      avgWin: wins.length ? Math.round(wins.reduce((a, b) => a + b, 0) / wins.length) : 0,
      avgLoss: losses.length ? Math.round(losses.reduce((a, b) => a + b, 0) / losses.length) : 0,
      avgAbs: Math.round(valid.reduce((a, t) => a + Math.abs(t[pKey]), 0) / valid.length),
      // 盈亏比：平均盈利 / 平均亏损
      pf: losses.length && losses.reduce((a, b) => a + b, 0) !== 0
        ? +(wins.reduce((a, b) => a + b, 0) / Math.abs(losses.reduce((a, b) => a + b, 0))).toFixed(2)
        : null,
      expectancy: Math.round(valid.reduce((a, t) => a + (t[okKey] ? Math.abs(t[pKey]) : -Math.abs(t[pKey])), 0) / valid.length),
    };
  }
  out.avgMFE = Math.round(trades.reduce((a, t) => a + t.mfe, 0) / trades.length);
  out.avgMAE = Math.round(trades.reduce((a, t) => a + t.mae, 0) / trades.length);
  return out;
}

// ============================================================
// 参数网格搜索
// ============================================================
function gridSearch(candles, strategyName, paramGrid, opts = {}) {
  const keys = Object.keys(paramGrid);
  const combos = [];
  const build = (idx, cur) => {
    if (idx === keys.length) { combos.push({ ...cur }); return; }
    for (const v of paramGrid[keys[idx]]) {
      cur[keys[idx]] = v;
      build(idx + 1, cur);
    }
  };
  build(0, {});

  const results = [];
  for (const p of combos) {
    try {
      const r = runBacktest(candles, strategyName, p, opts);
      results.push({ params: p, summary: r.summary, trades: r.trades });
    } catch (e) {
      // 忽略失败组合
    }
  }
  return results;
}

// ============================================================
// 主流程
// ============================================================
async function main() {
  const bar = process.env.BT_BAR || '1H';
  const total = parseInt(process.env.BT_TOTAL || '1500');
  const target = parseInt(process.env.BT_TARGET || '500');

  console.log(`\n${'='.repeat(70)}`);
  console.log(`BTC 策略离线回测 | K线周期 ${bar} | 目标 ${target} 点`);
  console.log(`${'='.repeat(70)}`);

  console.log('\n[1/4] 抓取 OKX 历史 K 线...');
  let candles;
  const localFile = process.env.BT_LOCAL;   // 本地文件模式，用于离线验证引擎
  try {
    if (localFile) {
      const fs = await import('fs');
      candles = JSON.parse(fs.readFileSync(localFile, 'utf8'));
      console.log(`   (本地文件模式: ${localFile})`);
    } else {
      candles = await fetchCandles(bar, total);
    }
  } catch (e) {
    console.error('❌ 抓取失败:', e.message);
    process.exit(1);
  }
  if (candles.length < 200) {
    console.error(`❌ 数据量不足: 仅 ${candles.length} 根`);
    process.exit(1);
  }

  const t0 = new Date(candles[0].t).toISOString();
  const t1 = new Date(candles[candles.length - 1].t).toISOString();
  console.log(`✅ 获取 ${candles.length} 根 K线`);
  console.log(`   区间: ${t0} → ${t1}`);

  const closes = candles.map(c => c.c);
  const price = closes[closes.length - 1];
  console.log(`   最新价: $${price.toLocaleString('en-US')}`);

  // 市场波动特征（关键！用于校准目标是否现实）
  console.log('\n[2/4] 分析市场波动特征...');
  const moves = { 1: [], 6: [], 24: [] };
  for (let i = 0; i + 24 < candles.length; i++) {
    for (const h of [1, 6, 24]) {
      moves[h].push(Math.abs(candles[i + h].c - candles[i].c));
    }
  }
  console.log('   未来N小时 绝对波幅分布（历史所有时点）:');
  for (const h of [1, 6, 24]) {
    const arr = moves[h].sort((a, b) => a - b);
    const q = (p) => Math.round(arr[Math.floor(arr.length * p)]);
    const over500 = arr.filter(x => x >= target).length / arr.length * 100;
    console.log(`     ${String(h).padStart(2)}H: 中位 ${q(0.5)}点 | P75 ${q(0.75)}点 | P90 ${q(0.9)}点 | P99 ${q(0.99)}点 | 超${target}点占比 ${over500.toFixed(1)}%`);
  }
  // 单根K线平均真实波幅
  const atrs = [];
  for (let i = 20; i < candles.length; i++) atrs.push(calcATR(candles.slice(0, i + 1), 14));
  const avgATR = atrs.reduce((a, b) => a + b, 0) / atrs.length;
  console.log(`   平均 ATR(14): ${Math.round(avgATR)} 点 (${(avgATR / price * 100).toFixed(2)}%)`);

  // 各策略基线
  console.log('\n[3/4] 各策略基线表现（默认参数）...');
  const baseline = {};
  const horizons = [1, 6, 24];
  for (const name of Object.keys(STRATEGIES)) {
    const r = runBacktest(candles, name, {}, { target, horizons });
    baseline[name] = r.summary;
    const s = r.summary;
    const h24 = s.horizons[24] || {};
    console.log(`\n   ${STRATEGIES[name].name}`);
    console.log(`     信号数 ${s.n}`);
    if (s.n > 0) {
      for (const h of horizons) {
        const d = s.horizons[h];
        if (!d || !d.n) continue;
        console.log(`     ${String(h).padStart(2)}H: 准确率 ${String(d.dirAcc).padStart(5)}% | ${target}点捕捉 ${String(d.hitRate).padStart(5)}% | 平均波幅 ${String(d.avgAbs).padStart(4)}点 | 期望 ${String(d.expectancy).padStart(5)}点 | 盈亏比 ${d.pf ?? '-'}`);
      }
      console.log(`     MFE(最大有利) ${s.avgMFE}点 / MAE(最大不利) ${s.avgMAE}点`);
    }
  }

  // 网格搜索（对最有希望的策略）
  console.log('\n[4/4] 参数网格搜索...');
  const grids = {
    breakout: { lookback: [12, 24, 48, 72], buffer: [0, 0.1, 0.2, 0.3], minAtrPct: [0.1, 0.15, 0.25, 0.4] },
    momentum: { momPeriod: [6, 12, 24, 48], momThreshold: [0.5, 0.8, 1.2, 2.0], minAtrPct: [0.1, 0.15, 0.25, 0.4] },
    squeeze: { bbPeriod: [20], squeezeQ: [0.15, 0.25, 0.4], bbMult: [1.5, 2, 2.5] },
    trendPullback: { fastMA: [5, 10, 20], slowMA: [30, 40, 60], rsiEntry: [35, 45, 55] },
    meanReversion: { rsiPeriod: [14], threshold: [0.18, 0.3, 0.45] },
    v2: {
      minAtrPct: [0.15, 0.25, 0.4],
      momPeriod: [12, 24, 48],
      threshold: [0.2, 0.3, 0.45],
      wBreak: [0.15, 0.25],
    },
    v2squeeze: {
      minAtrPct: [0.15, 0.25],
      momPeriod: [12, 24],
      threshold: [0.25, 0.35],
      squeezeQ: [0.2, 0.3],
    },
  };

  const best = {};
  for (const [name, grid] of Object.entries(grids)) {
    const results = gridSearch(candles, name, grid, { target, horizons });
    // 排序：24H 期望收益优先（这是"捕捉大盈利"的直接指标）
    const valid = results.filter(r => r.summary.n >= 10);
    valid.sort((a, b) => {
      const a24 = a.summary.horizons[24];
      const b24 = b.summary.horizons[24];
      if (!a24 || !b24) return 0;
      return b24.expectancy - a24.expectancy;
    });
    best[name] = valid.slice(0, 3);
    console.log(`\n   ${STRATEGIES[name].name} — 按24H期望收益排序 Top3（共 ${results.length} 组合）:`);
    for (const r of valid.slice(0, 3)) {
      const d24 = r.summary.horizons[24] || {};
      const d6 = r.summary.horizons[6] || {};
      console.log(`     ${JSON.stringify(r.params)}`);
      console.log(`       信号 ${String(r.summary.n).padStart(3)} | 24H: 准确率 ${d24.dirAcc}% 捕捉 ${d24.hitRate}% 期望 ${d24.expectancy}点 盈亏比 ${d24.pf} | 6H: 准确率 ${d6.dirAcc}% 期望 ${d6.expectancy}点`);
    }
  }

  // 输出 JSON 报告
  const report = {
    meta: {
      bar, target, candles: candles.length,
      from: t0, to: t1, price, avgATR: Math.round(avgATR),
      generatedAt: new Date().toISOString(),
    },
    moveDistribution: Object.fromEntries([1, 6, 24].map(h => {
      const arr = moves[h].sort((a, b) => a - b);
      const q = (p) => Math.round(arr[Math.floor(arr.length * p)]);
      return [h, { median: q(0.5), p75: q(0.75), p90: q(0.9), p99: q(0.99),
        overTarget: +(arr.filter(x => x >= target).length / arr.length * 100).toFixed(1) }];
    })),
    baseline,
    best: Object.fromEntries(Object.entries(best).map(([k, v]) => [k, v.map(r => ({
      params: r.params, summary: r.summary,
    }))])),
  };

  const fs = await import('fs');
  fs.writeFileSync('backtest_report.json', JSON.stringify(report, null, 2));
  console.log(`\n${'='.repeat(70)}`);
  console.log('✅ 报告已写入 backtest_report.json');
  console.log(`${'='.repeat(70)}\n`);
}

// BT_LIB=1 时只当库用，不执行 main（供 validate.mjs 复用）
if (process.env.BT_LIB !== '1') {
  main().catch(e => { console.error('❌ 回测失败:', e); process.exit(1); });
}

export {
  runBacktest, gridSearch, summarize, STRATEGIES,
  calcRSI, calcEMA, calcMACD, calcBB, calcATR, sma,
  strategyMeanReversion, strategyBreakout, strategySqueeze,
  strategyMomentum, strategyTrendPullback, strategyV2, strategyV2Squeeze,
  fetchCandles,
};
