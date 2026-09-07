/**
 * BTC 实时监控 - Cloudflare Worker
 *
 * 功能：
 * - 每分钟通过 Cron Trigger 拉取 BTC 价格（OKX/Binance/Coinbase/CoinLore 多源故障转移）
 * - 技术分析（RSI/MACD/布林带/均线）
 * - 存储价格历史到 KV
 * - 分级 Bark 推送（≥500点 critical 响铃 / 其余 passive 静默）
 * - HTTP 接口提供实时面板数据
 * - 根路径直接托管监控面板（不依赖 Pages）
 */
import { DASHBOARD_HTML } from './dashboard.js';

// ============================================================
// 配置
// ============================================================
const BARK_KEY = 'jNVNkxWwVd88vNYoq7RxMa';
const BARK_URL = `https://api.day.app/${BARK_KEY}`;
const BARK_COOLDOWN = 180; // 同一方向信号最小间隔（秒）

// 分级推送阈值：预判波幅达到该点数视为"重大行情"，用最高优先级推送并忽略冷却
const BIG_MOVE_POINTS = 500;

// 推送所用策略：'v1' = 均值回归（原） / 'v2' = 趋势跟随（新）
// 两者始终并行计算并同时记录回测样本，此开关只决定推送哪一个。
// 之所以并行：沙箱拿不到历史 K 线，无法离线回测，改用实盘 A/B 对比验证。
const ACTIVE_STRATEGY = 'v2';

// 推送/记录所需的最低概率。
// V1 与 V2 的概率语义不同，必须用不同门槛，否则既不合理也破坏 A/B 公平性：
//   V1 = 拍脑袋公式（predictedMove/500*0.35 + confidence*0.5 + ...），典型值 0.50~0.70
//   V2 = 正态模型 P(24H 内朝有利方向移动 ≥500 点)，典型值 0.35~0.55
// 两者各取自身分布中较强的一部分，样本量才可比。
// 注意：PUSH_MIN_PROB 依赖 ACTIVE_STRATEGY，必须定义在其后（否则 TDZ 报错）
const PUSH_MIN_PROB_V1 = 0.5;
const PUSH_MIN_PROB_V2 = 0.35;
const PUSH_MIN_PROB = ACTIVE_STRATEGY === 'v2' ? PUSH_MIN_PROB_V2 : PUSH_MIN_PROB_V1;

// 同一策略记录回测样本的最小间隔（秒）
const BT_RECORD_INTERVAL = 1800;   // 30 分钟

// 暂停开关：true = 暂停推送（系统继续记录价格，但不发 Bark）
// 恢复推送时改为 false 并重新部署
const PAUSE_PUSH = false;

// 24H 滚动窗口采样间隔（毫秒）：每 5 分钟一个采样点，保留 24 小时 = 288 点
const H24_SAMPLE_MS = 5 * 60 * 1000;
const H24_WINDOW_MS = 24 * 60 * 60 * 1000;
const H24_MAX_POINTS = 2000;

// BTC 流通量估算（用于推算市值，交易所接口不返回）
const BTC_SUPPLY_EST = 19970000;

// CoinLore API（兜底源）
const COINLORE_URL = 'https://api.coinlore.net/api/ticker/?id=90';

// ============================================================
// 多数据源故障转移
// 优先使用交易所官方 24H 高低价（OKX 欧易 → Binance → Coinbase → CoinLore 兜底）
// 注意：Worker 运行在 Cloudflare 边缘，不受沙箱防火墙限制，可直连交易所
// ============================================================
const SOURCES = [
  {
    name: 'OKX',
    url: 'https://www.okx.com/api/v5/market/tickers?instType=SPOT',
    async parse(r) {
      const j = await r.json();
      const d = (j.data || []).find(x => x.instId === 'BTC-USDT');
      if (!d || !d.last) return null;
      const last = parseFloat(d.last);
      const open = parseFloat(d.open24h);
      return {
        price: last,
        high: parseFloat(d.high24h) || null,
        low: parseFloat(d.low24h) || null,
        change: open ? ((last - open) / open) * 100 : 0,
        vol: parseFloat(d.volCcy24h) || 0,
        ts: parseInt(d.ts) || Date.now(),
      };
    },
  },
  {
    name: 'Binance',
    url: 'https://api.binance.com/api/v3/ticker/24hr?symbol=BTCUSDT',
    async parse(r) {
      const d = await r.json();
      if (!d || !d.lastPrice) return null;
      return {
        price: parseFloat(d.lastPrice),
        high: parseFloat(d.highPrice) || null,
        low: parseFloat(d.lowPrice) || null,
        change: parseFloat(d.priceChangePercent) || 0,
        vol: parseFloat(d.quoteVolume) || 0,
        ts: d.closeTime || Date.now(),
      };
    },
  },
  {
    name: 'Coinbase',
    url: 'https://api.exchange.coinbase.com/products/BTC-USD/stats',
    async parse(r) {
      const d = await r.json();
      const last = parseFloat(d.last);
      if (!last) return null;
      const open = parseFloat(d.open);
      return {
        price: last,
        high: parseFloat(d.high) || null,
        low: parseFloat(d.low) || null,
        change: open ? ((last - open) / open) * 100 : 0,
        vol: parseFloat(d.volume) * last || 0,
        ts: Date.now(),
      };
    },
  },
  {
    name: 'CoinLore',
    url: COINLORE_URL,
    async parse(r) {
      const j = await r.json();
      const d = j && j[0];
      if (!d || !d.price_usd) return null;
      return {
        price: parseFloat(d.price_usd),
        high: null,   // CoinLore 不提供 24H 高低，交给本地滚动窗口兜底
        low: null,
        change: parseFloat(d.percent_change_24h) || 0,
        vol: parseFloat(d.volume24) || 0,
        ts: Date.now(),
      };
    },
  },
];

// 单个数据源超时（毫秒）
// 必要性：不可达的源若只是挂起而非快速失败，会串行拖垮整个请求，
// 导致每分钟的 cron 卡死、API 超时。正常源实测响应 <200ms，3 秒已很宽裕。
const SOURCE_TIMEOUT_MS = 3000;

// OKX 1小时 K线（V2 策略依赖，数据质量远高于分钟级采样拼接）
const OKX_KLINE_URL = 'https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=1H&limit=300';

async function fetchKlines() {
  try {
    const resp = await fetch(OKX_KLINE_URL, {
      headers: { 'User-Agent': 'BTC-Monitor/1.0' },
      signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const j = await resp.json();
    if (j.code !== '0' || !Array.isArray(j.data)) throw new Error('返回格式异常');
    // OKX 返回 [ts,o,h,l,c,vol,...]，最新在前 → 转成升序
    const rows = j.data
      .map(d => ({ t: +d[0], o: +d[1], h: +d[2], l: +d[3], c: +d[4], vol: +d[5] }))
      .filter(k => Number.isFinite(k.c) && k.c > 0)
      .sort((a, b) => a.t - b.t);
    return rows.length >= 60 ? rows : null;
  } catch (e) {
    console.error('K线抓取失败:', e.message);
    return null;
  }
}

// 依次尝试各数据源，返回首个可用结果 + 各源探测状态
async function fetchQuote() {
  const probe = [];
  for (const s of SOURCES) {
    const t0 = Date.now();
    try {
      const resp = await fetch(s.url, {
        headers: { 'User-Agent': 'BTC-Monitor/1.0' },
        cf: { cacheTtl: 0 },
        signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      const q = await s.parse(resp);
      if (!q || !Number.isFinite(q.price) || q.price <= 0) throw new Error('解析失败');
      probe.push({ name: s.name, ok: true, ms: Date.now() - t0 });
      return { quote: q, source: s.name, probe };
    } catch (e) {
      probe.push({ name: s.name, ok: false, err: String(e.message || e), ms: Date.now() - t0 });
    }
  }
  return { quote: null, source: null, probe };
}

// ============================================================
// 技术分析
// ============================================================
function calcRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;
  const deltas = [];
  for (let i = 1; i < prices.length; i++) deltas.push(prices[i] - prices[i - 1]);
  const recent = deltas.slice(-period);
  let gains = 0, losses = 0;
  for (const d of recent) {
    if (d > 0) gains += d; else losses += Math.abs(d);
  }
  gains /= period;
  losses /= period;
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
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdLine = ema12 - ema26;
  const signal = calcEMA([macdLine], 9); // simplified
  return { line: macdLine, signal: signal, hist: macdLine - signal };
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
  const upper = avg + 2 * std;
  const lower = avg - 2 * std;
  const width = ((upper - lower) / avg) * 100;
  return { upper, middle: avg, lower, width };
}

// 通用工具
function sma(arr, n) {
  if (!arr.length) return 0;
  if (arr.length < n) return arr.reduce((a, b) => a + b, 0) / arr.length;
  return arr.slice(-n).reduce((a, b) => a + b, 0) / n;
}
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

// 平均真实波幅（衡量真实波动大小，比收盘价差更准确）
function calcATR(candles, period = 14) {
  if (!candles || candles.length < period + 1) return 0;
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

// 标准正态累积分布 Φ(x)，Abramowitz-Stegun 近似
function normalCDF(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-x * x / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937
    + t * (-1.821255978 + t * 1.330274429))));
  return x > 0 ? 1 - p : p;
}

function analyze(price, prices) {
  if (prices.length < 10) {
    return {
      direction: 'WAIT', probability: 0, confidence: 0, predicted_move: 0,
      rsi: 50, macd_hist: 0, bb_upper: 0, bb_middle: 0, bb_lower: 0,
      bb_width: 0, reasons: ['⏳ 数据积累中...'], score: 0, trend: 'neutral'
    };
  }

  const reasons = [];
  let score = 0;

  // RSI
  const rsi = calcRSI(prices);
  if (rsi > 75) { score -= 0.35; reasons.push(`🔴 RSI严重超买(${rsi.toFixed(0)})，回调压力大`); }
  else if (rsi > 65) { score -= 0.15; reasons.push(`🟠 RSI偏超买(${rsi.toFixed(0)})`); }
  else if (rsi < 25) { score += 0.35; reasons.push(`🟢 RSI严重超卖(${rsi.toFixed(0)})，反弹需求强`); }
  else if (rsi < 35) { score += 0.15; reasons.push(`🟢 RSI偏超卖(${rsi.toFixed(0)})`); }

  // MACD
  const macd = calcMACD(prices);
  if (macd.hist > 0 && macd.line > macd.signal) score += 0.12;
  else if (macd.hist < 0 && macd.line < macd.signal) score -= 0.12;

  // 布林带
  const bb = calcBB(prices);
  const bbPos = (price - bb.lower) / (bb.upper - bb.lower) || 0.5;
  if (bbPos > 0.9) { score -= 0.2; reasons.push('📊 价格触及布林带上轨'); }
  else if (bbPos < 0.1) { score += 0.2; reasons.push('📊 价格触及布林带下轨'); }

  // 均线
  const ma5 = prices.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const ma10 = prices.slice(-10).reduce((a, b) => a + b, 0) / 10;
  const ma20 = prices.length >= 20
    ? prices.slice(-20).reduce((a, b) => a + b, 0) / 20
    : ma10;
  let trend = 'neutral';
  if (price > ma5 && ma5 > ma10) { trend = 'up'; score += 0.1; }
  else if (price < ma5 && ma5 < ma10) { trend = 'down'; score -= 0.1; }
  if (price > ma20) score += 0.05;
  else score -= 0.05;

  // 宏观：仅作为参考信息展示，不参与打分
  // （此前写死的 -0.22 / +0.13 净偏空 -0.09，导致信号 85% 偏向 SHORT）
  reasons.push('🌍 宏观参考：美伊冲突风险 / CPI降温降息预期（不计入评分）');

  // 价格位置
  if (prices.length >= 30) {
    const h30 = Math.max(...prices.slice(-30));
    const l30 = Math.min(...prices.slice(-30));
    const pos30 = (price - l30) / (h30 - l30) || 0.5;
    if (pos30 > 0.85) { score -= 0.1; reasons.push('📍 接近30周期高位'); }
    else if (pos30 < 0.15) { score += 0.1; reasons.push('📍 接近30周期低位'); }
  }

  let direction = 'WAIT';
  if (score > 0.18) direction = 'LONG';
  else if (score < -0.18) direction = 'SHORT';

  const confidence = Math.abs(score);

  // 波动预估
  let histVol = 1500;
  if (prices.length >= 20) {
    const rets = [];
    for (let i = Math.max(1, prices.length - 20); i < prices.length; i++) {
      rets.push(Math.abs(prices[i] - prices[i - 1]) / prices[i - 1]);
    }
    histVol = (rets.reduce((a, b) => a + b, 0) / rets.length) * prices[prices.length - 1] * 5;
  }
  const predictedMove = histVol * (1 + Math.abs(score) * 0.5);

  let prob500 = Math.min(0.95, predictedMove / 500 * 0.35 + confidence * 0.5 + (bb.width > 8 ? 1 : 0.6) * 0.15);
  if (direction === 'WAIT') prob500 = 0;

  return {
    direction, probability: +prob500.toFixed(3), confidence: +confidence.toFixed(3),
    predicted_move: Math.round(predictedMove), rsi: +rsi.toFixed(1),
    macd_hist: +macd.hist.toFixed(2), bb_upper: +bb.upper.toFixed(2),
    bb_middle: +bb.middle.toFixed(2), bb_lower: +bb.lower.toFixed(2),
    bb_width: +bb.width.toFixed(2), reasons, score: +score.toFixed(3),
    trend, ma5: +ma5.toFixed(2), ma10: +ma10.toFixed(2), ma20: +ma20.toFixed(2)
  };
}

// ============================================================
// V2 策略：趋势跟随（候选，与 V1 并行 A/B 测试）
//
// 针对 V1 的三个实证缺陷设计：
//   1. 周期错配 —— 500 点在 1H 窗口概率仅 15.8%，24H 窗口 41.9%
//      V2 以 24H 为目标窗口做预测与评估
//   2. 均值回归逆势 —— 大行情本质是趋势，V1 超买即做空会持续亏损
//      V2 改为趋势跟随：动量 + 均线排列 + 突破，RSI 仅作动量确认不做反转
//   3. 低波动期推送无意义 —— 此时 500 点不可能达成
//      V2 加 ATR 门槛，波动率不足直接不发信号
// ============================================================
const V2 = {
  // 最低 ATR 占比，低于此不发信号。原 0.25，实测下调到 0.15：
  //   2026-09-05~07 连续 57 小时零推送，主因之一正是 ATR 长期卡在
  //   0.17~0.25%，被这道门槛挡在门外。
  //   6540 根 K 线扫描显示降门槛代价几乎为零：
  //     0.25 → 24H期望 129 盈亏比1.22 覆盖40.7% 同期信号 0
  //     0.15 → 24H期望 130 盈亏比1.22 覆盖41.2% 同期信号 4
  //   低波动市里 500 点并非不可能（ATR 0.2% 时 24H σ≈596 点），不该一刀切。
  minAtrPct: 0.15,
  momPeriod: 24,        // 动量周期（1H K线根数）
  momScale: 2,          // 动量归一化尺度（百分比）
  fastMA: 10, slowMA: 40,
  trendScale: 0.5,      // 均线排列归一化尺度
  wMom: 0.35, wTrend: 0.2, wRsi: 0.1, wBreak: 0.25,
  volRatio: 1.1, volBoost: 1.15,
  // 信号阈值。0.3 → 0.50 → 0.45，第二次下调是纠错：
  //   0.50 是拿 6040 根数据的「全量期望最高」选出来的，但那是过度优化。
  //   用 6540 根（含 09-03~09-07 新增数据）重做分段稳健性检验：
  //     0.50 → 各段期望 256 211 −245 490  −5 121  正段 4/6
  //     0.45 → 各段期望 233 133 −259 430 +26  75  正段 5/6 ✅
  //     0.40 → 各段期望 202 122 −256 363 +56  30  正段 5/6 ✅
  //   0.50 全量期望最高（+130）却有 2 段为负；0.45 期望 +98 但只有 1 段为负。
  //   跟「趋势突破 +1141」是同一个坑：追全量峰值 = 过拟合。改取 0.45。
  //   另注：准确率几乎不随阈值变化（49.1%~49.5%），变的是赔率结构。
  threshold: 0.45,
  // 概率模型的归一化基准，与信号阈值解耦。
  // 若直接用 threshold 归一化：任何通过门槛的信号都有 |score| >= threshold，
  // 于是 min(1, |score|/threshold) 恒等于 1，趋势项不再提供任何区分度，
  // 概率高低完全由 σ(波动率) 决定 —— 强弱信号长得一样。
  // 改用 0.75（略高于 P75 的 |score|≈0.59）后，趋势项能参与区分：
  // 实测概率区分度 0.287 → 0.309，强信号概率确实更高。
  driftRef: 0.75,
  driftStrength: 0.3,   // 趋势持续性假设（用于概率模型，保守取值）
  atrToSigma: 1.3,      // ATR → σ 的经验换算系数
};

function analyzeV2(klines, price) {
  const blank = (reason) => ({
    direction: 'WAIT', probability: 0, confidence: 0, predicted_move: 0,
    score: 0, reasons: [reason], atr: 0, atrPct: 0, targetHorizon: 24,
  });

  if (!klines || klines.length < 60) return blank('⏳ K线数据积累中...');

  const closes = klines.map(k => k.c);
  const atr = calcATR(klines, 14);
  const atrPct = (atr / price) * 100;

  // 波动率门槛：市场太安静时 500 点目标不现实，直接不发信号
  if (atrPct < V2.minAtrPct) {
    return { ...blank(`😴 波动率不足 (ATR ${atrPct.toFixed(2)}% < ${V2.minAtrPct}%)，不满足500点条件`),
      atr, atrPct };
  }

  const reasons = [];

  // 动量（主权重）
  const momN = V2.momPeriod;
  const past = closes[closes.length - 1 - momN];
  const mom = (price - past) / past * 100;
  reasons.push(`🚀 ${momN}小时动量 ${mom >= 0 ? '+' : ''}${mom.toFixed(2)}%`);

  // 均线排列
  const maFast = sma(closes, V2.fastMA);
  const maSlow = sma(closes, V2.slowMA);
  const trendScore = (maFast - maSlow) / maSlow * 100;
  const trend = maFast > maSlow ? 'up' : 'down';
  reasons.push(`📊 均线${trend === 'up' ? '多头' : '空头'}排列 (${trendScore >= 0 ? '+' : ''}${trendScore.toFixed(2)}%)`);

  // 突破：相对最近 24 根（不含当前）
  const prev = klines.slice(0, -1).slice(-24);
  const hh = Math.max(...prev.map(k => k.h));
  const ll = Math.min(...prev.map(k => k.l));
  const breakUp = price > hh;
  const breakDown = price < ll;

  // RSI 仅作动量确认
  const rsi = calcRSI(closes, 14);
  const rsiMom = (rsi - 50) / 50;
  reasons.push(`📈 RSI ${rsi.toFixed(0)}（动量确认）`);

  // 成交量
  const vols = klines.map(k => k.vol);
  const volNow = sma(vols.slice(-12), 12);
  const volPrev = sma(vols.slice(-24, -12), 12);
  const volRatio = volPrev > 0 ? volNow / volPrev : 1;

  let score = 0;
  score += clamp(mom / V2.momScale, -1, 1) * V2.wMom;
  score += clamp(trendScore / V2.trendScale, -1, 1) * V2.wTrend;
  score += rsiMom * V2.wRsi;
  if (breakUp) { score += V2.wBreak; reasons.push('🔥 突破24小时高点'); }
  if (breakDown) { score -= V2.wBreak; reasons.push('🧊 跌破24小时低点'); }
  if (volRatio > V2.volRatio) {
    score *= V2.volBoost;
    reasons.push(`🔊 放量 ${volRatio.toFixed(2)}×`);
  }

  let direction = 'WAIT';
  if (score > V2.threshold) direction = 'LONG';
  else if (score < -V2.threshold) direction = 'SHORT';

  // ---- 波动预测与概率（基于统计模型，非拍脑袋公式）----
  // σ_1H 由 ATR 换算，再按 sqrt(24) 外推到 24 小时
  const sigma1h = atr / V2.atrToSigma;
  const sigma24 = sigma1h * Math.sqrt(24);
  // 24 小时预期绝对波幅（正态分布平均绝对偏差 = 0.798σ）
  const baseMove24 = 0.7979 * sigma24;
  const predictedMove = baseMove24 * (1 + Math.abs(score) * 0.3);

  let probability = 0;
  if (direction !== 'WAIT') {
    // 趋势持续性假设：信号越强，方向漂移越大。
    // 注意 mu 取正值 —— 方向已由 direction 表达，这里算的是
    // "朝有利方向" 移动 500 点的概率，不应再乘符号（否则做空概率会被低估）。
    const mu = sigma24 * V2.driftStrength * Math.min(1, Math.abs(score) / V2.driftRef);
    const z = (BIG_MOVE_POINTS - mu) / sigma24;
    // P(朝有利方向移动 ≥ BIG_MOVE_POINTS 点)
    probability = 1 - normalCDF(z);
  }

  return {
    direction,
    probability: +probability.toFixed(3),
    confidence: +Math.abs(score).toFixed(3),
    predicted_move: Math.round(predictedMove),
    score: +score.toFixed(3),
    reasons,
    atr: Math.round(atr),
    atrPct: +atrPct.toFixed(3),
    rsi: +rsi.toFixed(1),
    mom: +mom.toFixed(2),
    trend,
    maFast: Math.round(maFast),
    maSlow: Math.round(maSlow),
    volRatio: +volRatio.toFixed(2),
    sigma24: Math.round(sigma24),
    targetHorizon: 24,        // 明确标注目标窗口是 24 小时
    strategy: 'v2',
  };
}

// ============================================================
// Bark 推送
// ============================================================
async function sendBark(title, body, urgency = 'active', group = 'BTC-Signal') {
  try {
    // passive（静默）时不响铃，避免常规小信号频繁打扰
    const sound = (urgency === 'passive') ? 'silence.caf' : 'alarm.caf';
    const resp = await fetch(BARK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        title, body, level: urgency, group,
        sound, badge: 1, isArchive: 1,
      }),
    });
    const result = await resp.json();
    return result.code === 200;
  } catch (e) {
    console.error('Bark推送失败:', e);
    return false;
  }
}

// ============================================================
// 数据存储（KV）
// ============================================================
async function getState(env) {
  const raw = await env.BTC_STATE.get('current', 'json');
  if (!raw) {
    return {
      price: 64600,
      high_24h: 64910,
      low_24h: 63901,
      change_24h: 1.0,
      vol: 14e9,
      mcap: 1.29e12,
      prices: [],
      h24: [],
      signal: { direction: 'WAIT', probability: 0, reasons: ['初始化中...'] },
      history: [],
      last_update: Date.now(),
      update_count: 0,
      last_signal_time: 0,
      last_signal_dir: '',
    };
  }
  return raw;
}

async function saveState(env, state) {
  await env.BTC_STATE.put('current', JSON.stringify(state));
}

// ============================================================
// 回测记录：信号发出后，追踪未来 1/6/24 小时实际价格
// 用于事后计算真实方向准确率与 500 点达标率
// 独立存储于 KV key 'backtest'，不受 prices(300点) 轮转影响
// ============================================================

const BT_KEY = 'backtest';
const BT_MAX = 500;              // 最多保留记录数
const H1 = 3600, H6 = 21600, H24 = 86400;

async function getBacktest(env) {
  const raw = await env.BTC_STATE.get(BT_KEY, 'json');
  return (raw && Array.isArray(raw.records)) ? raw.records : [];
}

async function saveBacktest(env, records) {
  await env.BTC_STATE.put(BT_KEY, JSON.stringify({ records }));
}

// 新增一条待验证信号
// 除终点价格外，同步记录窗口内的最高/最低价，用于计算 MFE/MAE
async function recordSignal(env, signal, price, nowMs, strategy = 'v1') {
  const records = await getBacktest(env);
  records.push({
    id: nowMs,
    strategy,                       // v1=均值回归(现行) / v2=趋势跟随(候选)
    time: nowMs / 1000,
    direction: signal.direction,
    price: price,
    probability: signal.probability,
    predicted_move: signal.predicted_move,
    // 终点价格
    h1: null, h6: null, h24: null,
    // 窗口内极值（用于算 MFE/MAE，衡量真实可捕捉的盈利空间）
    h1_hi: price, h1_lo: price,
    h6_hi: price, h6_lo: price,
    h24_hi: price, h24_lo: price,
    done: false,
  });
  if (records.length > BT_MAX) records.splice(0, records.length - BT_MAX);
  await saveBacktest(env, records);
}

// 每次运行时更新：窗口内持续刷新增量极值，窗口到期时锁定终点价格
//
// 为什么记录极值：只看终点价格会系统性低估策略价值。
// 例：SHORT @78000，24H 内最低 77000（1000 点浮盈机会），收盘反弹至 78500。
// 按终点价判为"方向错误"，但实际出现过 1000 点可捕捉的盈利。
async function backfillBacktest(env, price, nowMs) {
  const records = await getBacktest(env);
  if (!records.length) return;
  let changed = false;
  const nowSec = nowMs / 1000;

  for (const r of records) {
    if (r.done) continue;
    const age = nowSec - r.time;

    // 窗口未关闭 → 持续更新极值（cron 每分钟一次，采样足够密）
    if (age <= H1) {
      if (price > (r.h1_hi ?? -Infinity)) { r.h1_hi = price; changed = true; }
      if (price < (r.h1_lo ?? Infinity)) { r.h1_lo = price; changed = true; }
    }
    if (age <= H6) {
      if (price > (r.h6_hi ?? -Infinity)) { r.h6_hi = price; changed = true; }
      if (price < (r.h6_lo ?? Infinity)) { r.h6_lo = price; changed = true; }
    }
    if (age <= H24) {
      if (price > (r.h24_hi ?? -Infinity)) { r.h24_hi = price; changed = true; }
      if (price < (r.h24_lo ?? Infinity)) { r.h24_lo = price; changed = true; }
    }

    // 窗口关闭 → 锁定终点价格
    if (r.h1 === null && age >= H1) { r.h1 = price; changed = true; }
    if (r.h6 === null && age >= H6) { r.h6 = price; changed = true; }
    if (r.h24 === null && age >= H24) { r.h24 = price; r.done = true; changed = true; }
  }
  if (changed) await saveBacktest(env, records);
}

// 计算某条记录在某窗口的最大有利波动(MFE)与最大不利波动(MAE)
function mfeMae(rec, horizon) {
  const hi = rec[`${horizon}_hi`], lo = rec[`${horizon}_lo`];
  if (hi === null || hi === undefined || lo === null || lo === undefined) return null;
  const p = rec.price;
  if (rec.direction === 'LONG') {
    return { mfe: hi - p, mae: lo - p };   // 做多：涨为有利
  }
  return { mfe: p - lo, mae: p - hi };     // 做空：跌为有利
}

// 统计准确率
function computeAccuracy(records, target = BIG_MOVE_POINTS) {
  const stat = (field, label, pool = records) => {
    const list = pool.filter(r => r[field] !== null);
    if (!list.length) {
      return { label, n: 0, dirAcc: null, hit500: null, avgMove: null, avgPredicted: null,
        avgMFE: null, avgMAE: null, opportunityRate: null };
    }
    let dirOk = 0, hit = 0, sumMove = 0, sumPred = 0;
    let sumMFE = 0, sumMAE = 0, opportunity = 0, mfeCount = 0;
    for (const r of list) {
      const future = r[field];
      const diff = future - r.price;
      const correct = r.direction === 'SHORT' ? diff < 0 : diff > 0;
      if (correct) dirOk++;
      if (Math.abs(diff) >= target) hit++;
      sumMove += Math.abs(diff);
      sumPred += (r.predicted_move || 0);

      // MFE/MAE：窗口内真实出现过的最大盈利/亏损空间
      const mm = mfeMae(r, field);
      if (mm) {
        sumMFE += mm.mfe;
        sumMAE += mm.mae;
        mfeCount++;
        // 机会率：窗口内是否曾经出现过 target 点的有利波动
        // 这是"能否捕捉到大盈利"的真实指标，终点价格会严重低估
        if (mm.mfe >= target) opportunity++;
      }
    }
    return {
      label,
      n: list.length,
      dirAcc: +((dirOk / list.length) * 100).toFixed(1),
      hit500: +((hit / list.length) * 100).toFixed(1),      // 终点价达标
      opportunityRate: mfeCount ? +((opportunity / mfeCount) * 100).toFixed(1) : null, // 过程达标
      avgMove: Math.round(sumMove / list.length),
      avgPredicted: Math.round(sumPred / list.length),
      avgMFE: mfeCount ? Math.round(sumMFE / mfeCount) : null,
      avgMAE: mfeCount ? Math.round(sumMAE / mfeCount) : null,
    };
  };

  // 分级统计：验证"重大行情"分级是否真的更有效
  const big = records.filter(r => (r.predicted_move || 0) >= BIG_MOVE_POINTS);
  const normal = records.filter(r => (r.predicted_move || 0) < BIG_MOVE_POINTS);

  // 策略 A/B 对比（v1 现行 / v2 候选），用实盘表现代替历史回测
  const byStrategy = {};
  for (const s of ['v1', 'v2']) {
    const pool = records.filter(r => (r.strategy || 'v1') === s);
    if (!pool.length) continue;
    byStrategy[s] = {
      n: pool.length,
      windows: [stat('h1', '1小时', pool), stat('h6', '6小时', pool), stat('h24', '24小时', pool)],
    };
  }

  return {
    total: records.length,
    completed: records.filter(r => r.done).length,
    windows: [stat('h1', '1小时'), stat('h6', '6小时'), stat('h24', '24小时')],
    tier: {
      big: {
        n: big.length,
        label: `重大行情(预判≥${BIG_MOVE_POINTS}点)`,
        windows: [stat('h1', '1小时', big), stat('h6', '6小时', big), stat('h24', '24小时', big)],
      },
      normal: {
        n: normal.length,
        label: `常规信号(预判<${BIG_MOVE_POINTS}点)`,
        windows: [stat('h1', '1小时', normal), stat('h6', '6小时', normal), stat('h24', '24小时', normal)],
      },
    },
    byStrategy,
    dirSplit: {
      LONG: records.filter(r => r.direction === 'LONG').length,
      SHORT: records.filter(r => r.direction === 'SHORT').length,
    },
  };
}

// ============================================================
// 主逻辑：拉取价格 + 分析
// ============================================================
async function fetchAndAnalyze(env) {
  const state = await getState(env);

  // 拉取 CoinLore 价格
  let newPrice = state.price;
  // 旧数据里 low_24h 曾被写成 0、high_24h 被写成"历史最高"，这里做一次自愈
  const validHigh = Number.isFinite(state.high_24h) && state.high_24h > 0 ? state.high_24h : null;
  const validLow = Number.isFinite(state.low_24h) && state.low_24h > 0 ? state.low_24h : null;
  let newHigh24h = validHigh;
  let newLow24h = validLow;
  let newChange = state.change_24h;
  let newVol = state.vol;

  let quoteSource = state.source_name || null;
  let exchangeHigh = null;   // 交易所官方 24H 最高
  let exchangeLow = null;    // 交易所官方 24H 最低

  try {
    const { quote, source, probe } = await fetchQuote();
    state.probe = probe;                 // 各数据源可用性，供排查使用
    if (quote) {
      quoteSource = source;
      newPrice = quote.price;
      newChange = quote.change;
      newVol = quote.vol;
      exchangeHigh = quote.high;
      exchangeLow = quote.low;
      state.quote_ts = quote.ts;
    }
  } catch (e) {
    console.error('行情拉取失败:', e);
  }
  state.source_name = quoteSource;

  // 更新价格历史（最多300条，用于 V1 的 RSI/MACD/布林带）
  const prices = state.prices || [];
  if (prices.length === 0 || newPrice !== prices[prices.length - 1]) {
    prices.push(newPrice);
  }
  if (prices.length > 300) prices.splice(0, prices.length - 300);

  // 更新 1H K线（V2 策略依赖）。每 10 分钟拉一次，避免无谓请求
  const tsNow = Date.now();
  let klines = state.klines || [];
  if (!klines.length || (tsNow - (state.klines_ts || 0)) > 10 * 60 * 1000) {
    const fresh = await fetchKlines();
    if (fresh) {
      klines = fresh;
      state.klines_ts = tsNow;
    }
  }

  // ============================================================
  // 真实 24H 滚动高低价窗口
  // 旧逻辑 bug：high_24h 只增不重置（变成"历史最高"），low_24h 跌到 0
  // 新逻辑：维护 {t,p} 采样数组，超出 24 小时的点自动淘汰
  // ============================================================
  const ts = Date.now();
  let h24 = Array.isArray(state.h24) ? state.h24 : [];

  if (Number.isFinite(newPrice) && newPrice > 0) {
    const lastSample = h24.length ? h24[h24.length - 1] : null;
    let needPush = false;

    // 定时采样：每 5 分钟记一点
    if (!lastSample || (ts - lastSample.t) >= H24_SAMPLE_MS) needPush = true;

    // 极值插桩：突破窗口极值时立即记录，避免 5 分钟采样漏掉真正的高低点
    if (!needPush && h24.length) {
      let curMax = -Infinity, curMin = Infinity;
      for (const s of h24) { if (s.p > curMax) curMax = s.p; if (s.p < curMin) curMin = s.p; }
      if (newPrice > curMax || newPrice < curMin) needPush = true;
    }

    if (needPush) h24.push({ t: ts, p: newPrice });
  }

  // 淘汰超过 24 小时的采样点
  // 用 filter 而非 shift：时间戳一旦乱序（时钟回拨 / KV 回滚旧数据），
  // shift 只检查头部会导致过期点永久残留，把 low_24h 钉死在错误值上
  const cutoff = ts - H24_WINDOW_MS;
  if (h24.some(s => !(s.t > cutoff))) {
    h24 = h24.filter(s => s.t > cutoff);
  }
  // 防御：检测到乱序则按时间升序重排
  let needSort = false;
  for (let i = 1; i < h24.length; i++) {
    if (h24[i].t < h24[i - 1].t) { needSort = true; break; }
  }
  if (needSort) h24.sort((a, b) => a.t - b.t);
  if (h24.length > H24_MAX_POINTS) h24.splice(0, h24.length - H24_MAX_POINTS);
  state.h24 = h24;

  // 本地滚动窗口的高低（兜底 + 交叉校验）
  let localHigh = null, localLow = null;
  if (h24.length >= 1) {
    let hi = -Infinity, lo = Infinity;
    for (const s of h24) { if (s.p > hi) hi = s.p; if (s.p < lo) lo = s.p; }
    localHigh = hi; localLow = lo;
  }

  // 优先采用交易所官方 24H 高低（口径与交易所完全一致）
  // 交易所不可用时回退到本地滚动窗口
  if (Number.isFinite(exchangeHigh) && Number.isFinite(exchangeLow)
      && exchangeHigh > 0 && exchangeLow > 0) {
    newHigh24h = exchangeHigh;
    newLow24h = exchangeLow;
    state.hl_source = 'exchange';
  } else if (localHigh !== null) {
    newHigh24h = localHigh;
    newLow24h = localLow;
    state.hl_source = 'local';
  }
  state.local_high_24h = localHigh;
  state.local_low_24h = localLow;

  // 技术分析：V1(均值回归) 与 V2(趋势跟随) 并行计算，用于 A/B 对比
  const signalV1 = analyze(newPrice, prices);
  const signalV2 = analyzeV2(klines, newPrice);
  const signal = ACTIVE_STRATEGY === 'v2' ? signalV2 : signalV1;

  // 更新状态
  state.price = newPrice;
  state.high_24h = newHigh24h;
  state.low_24h = newLow24h;
  state.change_24h = newChange;
  state.vol = newVol;
  state.mcap = newPrice * BTC_SUPPLY_EST;   // 按流通量估算（交易所源不返回市值）
  state.prices = prices;
  state.klines = klines;
  state.signal = signal;
  state.signal_v1 = signalV1;
  state.signal_v2 = signalV2;
  state.active_strategy = ACTIVE_STRATEGY;
  state.last_update = Date.now();
  state.update_count = (state.update_count || 0) + 1;

  // 信号记录 + Bark推送
  const now = Date.now();
  const nowSec = now / 1000;

  // ---- A/B 样本记录：两个策略各自独立记录，用实盘表现对比 ----
  // 间隔 30 分钟而非 5 分钟：相邻信号高度重叠不构成独立样本，
  // 拉长间隔可提升统计显著性，同时避免 KV 记录数暴涨
  for (const [tag, sig] of [['v1', signalV1], ['v2', signalV2]]) {
    if (!sig || sig.direction === 'WAIT') continue;
    const minProb = tag === 'v2' ? PUSH_MIN_PROB_V2 : PUSH_MIN_PROB_V1;
    if ((sig.probability || 0) < minProb) continue;
    const lastKey = `last_bt_${tag}`;
    if (nowSec - (state[lastKey] || 0) < BT_RECORD_INTERVAL) continue;
    state[lastKey] = nowSec;
    await recordSignal(env, sig, newPrice, now, tag);
  }

  // ---- 推送：只用 ACTIVE_STRATEGY 指定的那个 ----
  if (signal.direction !== 'WAIT' && signal.probability >= PUSH_MIN_PROB) {
    if (!state.history) state.history = [];
    const lastHist = state.history[state.history.length - 1];
    if (!lastHist || lastHist.direction !== signal.direction || (nowSec - lastHist.time) > 300) {
      state.history.push({
        time: nowSec,
        price: newPrice,
        direction: signal.direction,
        probability: signal.probability,
        predicted_move: signal.predicted_move,
        confidence: signal.confidence,
        strategy: ACTIVE_STRATEGY,
      });
      if (state.history.length > 100) state.history.shift();

      // 分级推送：
      //   重大行情（预判波幅 >= 500 点）→ critical，忽略冷却，立刻响
      //   常规信号（概率达标但波幅小）→ passive，静默送达，不打断
      const isBigMove = signal.predicted_move >= BIG_MOVE_POINTS;
      const cooldownOk = (nowSec - (state.last_signal_time || 0)) >= BARK_COOLDOWN;
      const dirChanged = state.last_signal_dir !== signal.direction;
      const shouldPush = isBigMove || cooldownOk || dirChanged;

      if (shouldPush && !PAUSE_PUSH) {
        const dirCN = signal.direction === 'LONG' ? '做多 LONG 📈' : '做空 SHORT 📉';
        const emoji = signal.direction === 'LONG' ? '🟢' : '🔴';
        const probPct = (signal.probability * 100).toFixed(0);
        const tag = isBigMove ? '🚨 重大行情' : '🔔 常规信号';
        const title = `${emoji} ${dirCN}`;
        const horizon = signal.targetHorizon || 1;
        const body = [
          `${tag}`,
          `价格: $${newPrice.toLocaleString('en-US')}`,
          `${horizon}H内超${BIG_MOVE_POINTS}点概率: ${probPct}%`,
          `预判${horizon}H波动: ${signal.predicted_move.toLocaleString('en-US')} 点`,
          `置信度: ${(signal.confidence * 100).toFixed(0)}%`,
          signal.rsi !== undefined ? `RSI: ${signal.rsi}` : null,
          signal.atrPct ? `波动率: ${signal.atrPct}%` : null,
          `策略: ${ACTIVE_STRATEGY === 'v2' ? '趋势跟随V2' : '均值回归V1'}`,
        ].filter(Boolean).join('\n');
        // critical = 突破静音/专注模式；passive = 静默通知
        const urgency = isBigMove ? 'critical' : 'passive';
        const group = isBigMove ? 'BTC-重大行情' : 'BTC-常规信号';
        // await 确保推送完成
        await sendBark(title, body, urgency, group);
        state.last_signal_time = nowSec;
        state.last_signal_dir = signal.direction;
      }
    }
  }

  // 回填回测记录（用最新价格更新已达 1h/6h/24h 的窗口）
  await backfillBacktest(env, newPrice, now);

  await saveState(env, state);
  return state;
}

// ============================================================
// Worker 入口
// ============================================================
export default {
  // Cron 触发器：每分钟自动拉取分析
  async scheduled(event, env, ctx) {
    ctx.waitUntil(fetchAndAnalyze(env));
  },

  // HTTP 请求处理
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // 监控面板：Worker 自身托管，不依赖 Pages
    if (path === '/' || path === '/index.html' || path === '/dashboard') {
      return new Response(DASHBOARD_HTML, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      });
    }

    // API: 获取完整状态
    if (path === '/api/state') {
      // 每次请求时也拉取最新价格（实时性更好）
      const state = await fetchAndAnalyze(env);
      return new Response(JSON.stringify({
        price: state.price,
        high_24h: state.high_24h,
        low_24h: state.low_24h,
        h24_points: (state.h24 || []).length,
        h24_ready: (state.h24 || []).length > 0
          && (Date.now() - state.h24[0].t) >= 23 * 60 * 60 * 1000, // 窗口是否已覆盖近24H
        h24_span_hours: (state.h24 || []).length
          ? +((Date.now() - state.h24[0].t) / 3600000).toFixed(1) : 0,
        hl_source: state.hl_source || null,
        local_high_24h: state.local_high_24h ?? null,
        local_low_24h: state.local_low_24h ?? null,
        source_name: state.source_name || null,
        probe: state.probe || [],
        change_24h: state.change_24h,
        volume_24h: state.vol,
        market_cap: state.mcap,
        signal: state.signal,
        signal_v1: state.signal_v1 || null,
        signal_v2: state.signal_v2 || null,
        active_strategy: state.active_strategy || 'v1',
        klines_count: (state.klines || []).length,
        prices: state.prices,
        history: state.history || [],
        data_points: state.prices.length,
        update_count: state.update_count || 0,
        last_update: state.last_update,
        source: 'Cloudflare Worker',
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders },
      });
    }

    // API: 健康检查
    if (path === '/health') {
      const state = await getState(env);
      return new Response(JSON.stringify({
        status: 'ok',
        price: state.price,
        points: state.prices.length,
        last_update: state.last_update,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders },
      });
    }

    // API: 回测统计（真实准确率）
    if (path === '/api/backtest') {
      const records = await getBacktest(env);
      // 主表只统计当前生效策略。已停用的 V1 样本会严重扭曲数字：
      // 实测 V1（均值回归）在 2026-09 那波单边上涨里连开 21 条 24H 空单、
      // 0% 正确（平均反向波动 3109 点、MAE −4057 点），混进总体统计后
      // 把 24H 准确率压到 4.5%。那描述的是旧策略在单一行情下的失败，
      // 跟当前系统水平无关，不该摆在面板主表。
      const activeRecords = records.filter(r => (r.strategy || 'v1') === ACTIVE_STRATEGY);
      const acc = computeAccuracy(activeRecords);
      // 全量统计保留，供 A/B 对比卡片使用
      const accAll = computeAccuracy(records);
      // 附带最近 20 条明细，便于核查
      const recent = records.slice(-20).map(r => ({
        time: r.time,
        direction: r.direction,
        price: r.price,
        prob: r.probability,
        h1: r.h1, h6: r.h6, h24: r.h24,
        done: r.done,
      }));
      return new Response(JSON.stringify({
        accuracy: acc, accuracyAll: accAll, recent,
        activeStrategy: ACTIVE_STRATEGY,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders },
      });
    }

    // API: 手动触发 Bark 测试
    if (path === '/api/bark' && request.method === 'POST') {
      try {
        const body = await request.json();
        const ok = await sendBark(body.title || 'BTC Monitor', body.body || '测试推送');
        return new Response(JSON.stringify({ status: ok ? 'ok' : 'failed' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders },
        });
      } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), {
          status: 400,
          headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders },
        });
      }
    }

    // 其他请求返回 404
    return new Response(JSON.stringify({ error: 'Not Found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders },
    });
  },
};
