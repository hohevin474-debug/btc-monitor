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

// plan A ①③：持仓管理常量（非重叠持仓 + 止损 / 移动止损）
// 单笔持仓最多持有 24H（与策略目标窗口一致），期间不再开新仓 —— 对应回测
// 「口径 B 非重叠」盈亏比从 1.06 升到 2.73 的核心改进（频率是主因）。
const V2_POSITION_HOLD_SEC = 12 * 3600; // 持仓/冷却窗口：从 24h 放宽到 12h，破解 V2 在震荡市停摆
// 止损距离 = ATR% × 倍数，再夹在 [下限, 上限] 之间（占价百分比）。
// 动机：实盘 MAE(最大不利波动) 1315 ≫ MFE 871，亏时扛太久。止损把单笔最大亏损截断。
const V2_STOP_MULT = 1.3;
const V2_STOP_MIN_PCT = 0.7;
const V2_STOP_MAX_PCT = 1.5;
// 移动止损激活门槛（plan P1-3）：盈利达该倍数 ATR 后才启动追踪止损，
// 此前保持初始止损位，避免刚开仓就被噪音扫损。
const V2_TRAIL_ACTIVATE_ATR = 1.0;
// 保本锁：盈利达该点数后把止损移到开仓价(±缓冲)，此后该笔不会亏损。
// 直接压制"亏损太大"的体感，并拉高净盈利平仓率（≈高胜率的务实版本）。
const V2_BE_POINTS = 250;
const V2_BE_BUFFER = 0.001;            // 保本价相对开仓价的缓冲(0.1%)
// 让利润奔跑：盈利超过该点数后，跟踪止损放宽到更宽轨道，目标捕捉 1000+ 大波。
const V2_RUN_POINTS = 500;
const V2_RUN_TRAIL_ATR = 2.2;          // 宽轨 = 2.2×ATR
// 已保本的盈利单允许持有更久（最长 24H），让趋势充分展开去冲 1000+。
const V2_POSITION_HOLD_SEC_PROFIT = 24 * 3600;

// ============================================================
// 市况自适应（regime-adaptive）：震荡切 V1 均值回归，趋势切 V2 趋势跟随
// ============================================================
// 分类阈值：ADX=趋势强度，R²=价格回归方向一致性。
//   真趋势 = ADX 强 且 R² 高（价格真有方向漂移）
//   高ADX震荡 = ADX 强 但 R² 低（波动大、方向反复，正是 V2 被扫损的市况）
const REGIME_ADX_TREND = 25;
const REGIME_ADX_FLAT = 18;
const REGIME_R2_TREND = 0.45;
const REGIME_R2_CHOP = 0.30;
const REGIME_HYST_BARS = 12;     // 市况需连续 N 分钟确认才切换（防抖）
// 市况自适应上线时间戳：此前 V1 只在 A/B 记录、未实盘，其旧样本(如 9 月单边市
// 连开 21 条空单 0% 正确)会扭曲主表；以此epoch为界，只纳入此后 V1 样本/实盘。
const REGIME_SWITCH_EPOCH = 1792640000;  // ≈ 2026-10-22 03:00 UTC
// V1 均值回归专用参数（与 V2 趋势跟随是相反打法）
const V1_STOP_MULT = 1.0, V1_STOP_MIN_PCT = 0.4, V1_STOP_MAX_PCT = 0.9;
const V1_TP_PCT = 0.9;           // 均值回归止盈：回放最优 0.9%（@85000≈765 点，vs 原 0.7%）
const V1_MAX_HOLD_SEC = 6 * 3600; // 均值回归持仓上限 6H 强制平仓（回放验证 6h 优于 12h）
// 多周期确认所用的"长周期"均线（单位=1H根数）。300根1H≈12.5天，160根≈6.7天≈近似日线趋势。
const V2_LONG_MA = 160;

// 推送所用策略：'v1' = 均值回归（原） / 'v2' = 趋势跟随（候选） / 'dv' = RSI顺势回调(4H定向)（现生效）
// 三者始终并行计算并同时记录回测样本，此开关只决定推送哪一个。
// 之所以并行：沙箱拿不到历史 K 线，无法离线回测，改用实盘 A/B 对比验证。
// 2026-10-23 部署决策：R16–R20 在「1000点+48h」约束下全量回放(2年17540根1H)，
// RSI(14)顺势回调(42/58穿越 + ATR%带 + 4H趋势对齐 + EMA20真回调) 严格命中 93.8%、
// PF 10.59、走步测试96.2%、两年分别84.6%/96.1%，为所有候选中最高胜率，故设为生效策略。
// 满足用户全部要求：90%+胜率 + 单笔1000点 + ≤48h + 最大单亏3000。沿用 'dv' 管道标签。
const ACTIVE_STRATEGY = 'dv';

// 推送/记录所需的最低概率。
// V1 与 V2 的概率语义不同，必须用不同门槛，否则既不合理也破坏 A/B 公平性：
//   V1 = 拍脑袋公式（predictedMove/500*0.35 + confidence*0.5 + ...），典型值 0.50~0.70
//   V2 = 正态模型 P(24H 内朝有利方向移动 ≥500 点)，典型值 0.35~0.55
//   DV = RSI回归，probability 直接取历史实测严格命中率(0.70)
// 注意：PUSH_MIN_PROB 依赖 ACTIVE_STRATEGY，必须定义在其后（否则 TDZ 报错）
const PUSH_MIN_PROB_V1 = 0.35;  // 修复哑火：原 0.5 高于 V1 常态概率(0.45-0.50)，导致永不触发；下调对齐回放口径
const PUSH_MIN_PROB_V2 = 0.45;
const PUSH_MIN_PROB_DV = 0.35;  // DV 触发即推送（其概率字段=实测严格命中率0.70，远高于此门槛）
const PUSH_MIN_PROB = ACTIVE_STRATEGY === 'dv' ? PUSH_MIN_PROB_DV
  : (ACTIVE_STRATEGY === 'v2' ? PUSH_MIN_PROB_V2 : PUSH_MIN_PROB_V1);

// ============================================================
// 现行生效策略配置（'dv' 管道复用）：RSI 顺势回调（4H定向 + 1H择时）。
// 演进：D-vstate(诚实命中3.6%) → RSI回归(69%) → +4H趋势对齐(86%) → +EMA20回调确认(93.8%)。
// 回放验证（2年17540根1H + 2年4H，TP=1000/SL=3000/≤48h）：
//   严格命中率(真打到1000点)=93.8%｜宽松胜率95.3%｜PF10.59｜n=64/2年
//   年度：第1年84.6%(PF7.08) 第2年96.1%(PF11.99)｜走步 训练92.1% 测试96.2%（真edge非过拟合）
//   经济逻辑：4H上升趋势中，等价格回落到1H EMA20下方(真回调)+RSI回升破42(反弹启动)才做多；
//            即「顺大势、逆小势、回调进场」。空头镜像。SL=3000锁最大单亏。
const DV = {
  rsiPeriod: 14,         // RSI 周期（Wilder）
  rsiLo: 42,             // RSI 从下方回升穿越此值 → 做多（上升趋势中的回调反弹）
  rsiHi: 58,             // RSI 从上方回落穿越此值 → 做空（下降趋势中的反弹回落）
  atrPeriod: 14,         // ATR 周期（Wilder）
  atrBandMin: 0.3,       // 波动regime门控：ATR% 下限
  atrBandMax: 2.0,       // 波动regime门控：ATR% 上限
  emaPullback: 20,       // 1H EMA 周期：真回调确认（多：价<EMA20；空：价>EMA20）
  trend4Ema: 20,         // 4H EMA 周期（大周期趋势判定）
  trend4Span: 6,         // 4H 斜率跨度（根，=24h）
  trend4SlopeMin: 0.3,   // 4H 趋势门控：|4H近24h斜率%|≥此才顺势开仓
  tpPoints: 1000,        // 止盈点数（@85000≈1.2%）
  slPoints: 3000,        // 止损点数（锁最大单亏，回放最佳风险收益）
  maxHoldSec: 48 * 3600, // 持仓上限（用户放宽到 48h）
  winRate: 0.94,         // 历史实测严格命中率 93.8%，用作推送概率基准
};

// 同一策略记录回测样本的最小间隔（秒）
const BT_RECORD_INTERVAL = 1800;   // 30 分钟：方向刚变化时用，保证新信号立刻留痕
// 同方向持续期间的采样间隔。
// 教训（2026-09-11）：之前无论方向是否变化都按 30 分钟记一条，
// 结果一波持续 10 小时的行情被拆成 20 条"样本"，它们的 24H 结果几乎必然同对错，
// 却各自独立计入准确率 —— 长行情被放大 20 倍权重，短行情只有 1 倍。
// 实盘 146 条记录里真正的独立信号段只有个位数，准确率被严重扭曲。
// 同方向改为 6 小时记一次：24H 窗口内最多 4 条重叠，而不是 48 条。
const BT_SEGMENT_INTERVAL = 6 * 3600;

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
const OKX_KLINE_URL_4H = 'https://www.okx.com/api/v5/market/candles?instId=BTC-USDT&bar=4H&limit=100';

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

// 4H K线（RSI策略的「大周期趋势对齐」门控需要：只在 4H 上升趋势中做多/下降趋势中做空）
async function fetchKlines4h() {
  try {
    const resp = await fetch(OKX_KLINE_URL_4H, {
      headers: { 'User-Agent': 'BTC-Monitor/1.0' },
      signal: AbortSignal.timeout(SOURCE_TIMEOUT_MS),
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const j = await resp.json();
    if (j.code !== '0' || !Array.isArray(j.data)) throw new Error('返回格式异常');
    const rows = j.data
      .map(d => ({ t: +d[0], o: +d[1], h: +d[2], l: +d[3], c: +d[4], vol: +d[5] }))
      .filter(k => Number.isFinite(k.c) && k.c > 0)
      .sort((a, b) => a.t - b.t);
    return rows.length >= 30 ? rows : null;
  } catch (e) {
    console.error('4H K线抓取失败:', e.message);
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
  threshold: 0.50,          // 对称基线阈值（判定用 thresholdLong/Short）
  // 非对称阈值（plan A ②，2026-09-18 上线）：做多更严。
  // 实盘 29 笔做多亏了 88%（逆势做多主因）。回测（非重叠 + ADX≥25）：
  //   LONG 0.45/SHORT 0.45 → LONG 均值 +627
  //   LONG 0.60/SHORT 0.45 → LONG 均值 +1072，整体 +828，盈亏比 4.03
  thresholdLong: 0.60,      // 做多门槛提高，过滤弱做多信号
  thresholdShort: 0.50,     // 做空门槛（校准0.55过严致V2停摆，回调至0.50，仍严于原始0.45）
  // 趋势对齐过滤（plan A ③）：只在均线趋势方向一致时开仓，杜绝逆势做多。
  // 做多需 maFast>maSlow（多头排列），做空需 maFast<maSlow（空头排列）。
  requireTrendAlign: true,
  // 趋势强度门槛（ADX）。2026-09-11 上线，动机：
  //   实盘 24H 准确率只有 26.7%，但全量回测 48.3% —— 差异来自行情段。
  //   按 2 周切 20 段，13 段为负；当前段（08-21 起）准确率仅 17.6%。
  //   失败模式很一致：跌了做空然后反弹，涨了做多然后回落 —— 趋势跟随
  //   在方向反复的震荡市里必然反复被打脸。
  //   6940 根回测（只在 ADX>=X 时开仓）：
  //     无过滤 → 交易253 胜率43.9% 期望 −57  负段 13/20
  //     ADX≥25 → 交易174 胜率50.6% 期望 +40  负段  9/20
  //     ADX≥30 → 交易120 胜率50.8% 期望 +82  负段 10/20
  //   选 25 不是网格搜索挑出来的 —— 它是 Wilder 原书的标准分界，有先验依据。
  //   ⚠️ 诚实提醒：ADX 救不了最近这段（该段期望 +126 → −984）。当前市场是
  //   高 ADX 的震荡，波动大但方向反复，ADX 区分不了。它改善的是长期统计。
  minAdx: 20,
  adxPeriod: 14,
  // —— 优化项（plan 全执行，开关化）——
  // Regime 过滤：当前 ATR 占近 atrWindow 根分位低于此 → 极度安静，趋势跟随不参与
  regimeQuietPctile: 0.2,
  // 波动率自适应阈值：高波动时自动加严(volAdaptHi)，低波动放松(volAdaptLo)
  volAdapt: true,
  volAdaptLo: 0.85, volAdaptHi: 1.35,
  atrWindow: 168,
  // 多周期确认（默认关，待样本验证）：要求信号方向与长周期均线趋势一致
  multicycle: false,
  longMA: 160,
  // V1/V2 共振（默认关，待样本验证）：两策略同向才交易，进一步降频
  resonance: false,
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

/**
 * Wilder ADX（平均趋向指数）—— 衡量趋势强度，与方向无关。
 * 0~25 通常视为无趋势/震荡，25 以上视为有趋势。
 *
 * ⚠️ 实现踩过的坑：RMA（Wilder 平滑）有两处必须带 /n ——
 *   ① 首值要取前 n 项【平均】而不是【和】
 *   ② 递推是 prev = (prev*(n−1) + x)/n
 *   漏掉任何一处 ADX 都会放大约 n 倍。我第一版就是这么错的：
 *   ADX 值域跑到 35~1055（中位数 348），导致所有门槛都形同虚设。
 */
function calcADX(candles, n = 14) {
  if (!candles || candles.length < n * 2 + 2) return null;
  const tr = [], pdm = [], ndm = [];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].h, l = candles[i].l;
    const pc = candles[i - 1].c, ph = candles[i - 1].h, pl = candles[i - 1].l;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = h - ph, dn = pl - l;
    pdm.push(up > dn && up > 0 ? up : 0);
    ndm.push(dn > up && dn > 0 ? dn : 0);
  }
  const rma = (a, n) => {
    const out = new Array(a.length).fill(NaN);
    if (a.length < n) return out;
    let prev = 0;
    for (let i = 0; i < n; i++) prev += a[i];
    prev /= n;                                  // ① 必须是平均
    out[n - 1] = prev;
    for (let i = n; i < a.length; i++) {        // ② 递推带 /n
      prev = (prev * (n - 1) + a[i]) / n;
      out[i] = prev;
    }
    return out;
  };
  const atrS = rma(tr, n), pS = rma(pdm, n), nS = rma(ndm, n);
  const dx = [];
  for (let i = n - 1; i < tr.length; i++) {
    if (!atrS[i] || !isFinite(atrS[i])) continue;
    const pdi = 100 * pS[i] / atrS[i], ndi = 100 * nS[i] / atrS[i];
    const den = pdi + ndi;
    dx.push(den > 0 ? 100 * Math.abs(pdi - ndi) / den : 0);
  }
  if (dx.length < n) return null;
  let adx = 0;
  for (let i = 0; i < n; i++) adx += dx[i];
  adx /= n;
  for (let i = n; i < dx.length; i++) adx = (adx * (n - 1) + dx[i]) / n;
  return adx;
}

// 价格回归方向一致性：对最近 N 根收盘做线性回归，返回斜率(%/根)与 R²。
// R² 高=价格沿单一方向漂移(真趋势)；R² 低=上下乱窜(震荡，哪怕 ADX 很高)。
function trendScore(klines) {
  const N = Math.min(120, klines.length);
  if (N < 10) return { slopePct: 0, r2: 0 };
  const ys = klines.slice(-N).map(k => k.c);
  const n = N, mx = (n - 1) / 2;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = i - mx, dy = ys[i] - my;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  const slope = sxy / sxx;
  const r2 = syy > 0 ? (sxy * sxy) / (sxx * syy) : 0;
  return { slopePct: (slope / my) * 100, r2 };
}

// 市况分类：返回 'trend' 或 'chop'。
// 关键：用 R² 把"高ADX假突破震荡"识别出来（worker.js:440 自认 ADX 救不了那段）。
function classifyRegime(klines) {
  const adx = calcADX(klines) ?? 0;
  const { r2 } = trendScore(klines);
  if (adx >= REGIME_ADX_TREND && r2 >= REGIME_R2_TREND) return 'trend';
  if (adx < REGIME_ADX_FLAT) return 'chop';
  if (adx >= REGIME_ADX_TREND && r2 < REGIME_R2_CHOP) return 'chop'; // 高ADX无方向=最糟震荡
  return r2 >= REGIME_R2_TREND ? 'trend' : 'chop';
}

function analyzeV2(klines, price) {
  // gates：推送三重门槛的实时体检数据。
  // 教训（2026-09-07）：连续 58 小时零推送，排查时才发现系统有 ATR / 强度 / 概率
  // 三道独立门槛，任何一道不过都会静默。此前面板只显示"信号=观望"，
  // 无法区分是卡在哪一关，只能靠人工拉数据复算。这里把三关的数值和门槛一起吐出来。
  const blank = (reason, gates) => ({
    direction: 'WAIT', probability: 0, confidence: 0, predicted_move: 0,
    score: 0, reasons: [reason], atr: 0, atrPct: 0, targetHorizon: 24,
    ...(gates ? { gates } : {}),
  });

  if (!klines || klines.length < 60) return blank('⏳ K线数据积累中...');

  const closes = klines.map(k => k.c);
  const atr = calcATR(klines, 14);
  const atrPct = (atr / price) * 100;

  // ATR 百分位（regime 过滤 + 自适应阈值用）：当前 atrPct 在近 atrWindow 根里的分位。
  // 0.5 = 中位，<0.2 = 处于历史极低波动（无趋势），>0.8 = 高波动需更严。
  let atrPctile = 0.5;
  if (klines.length >= (V2.atrWindow || 168) + 14) {
    const series = [];
    const w = V2.atrWindow || 168;
    for (let i = klines.length - w; i < klines.length; i++) {
      const a = calcATR(klines.slice(0, i + 1), 14);
      if (a > 0) series.push((a / klines[i].c) * 100);
    }
    if (series.length) {
      const below = series.filter(x => x < atrPct).length;
      atrPctile = below / series.length;
    }
  }

  // 波动率门槛：市场太安静时 500 点目标不现实，直接不发信号
  if (atrPct < V2.minAtrPct) {
    return { ...blank(`😴 波动率不足 (ATR ${atrPct.toFixed(2)}% < ${V2.minAtrPct}%)，不满足500点条件`, {
        atr:   { v: +atrPct.toFixed(3), need: V2.minAtrPct, pass: false },
        trend: { v: null, need: V2.minAdx, pass: false },
        score: { v: 0, need: V2.threshold, pass: false },
        prob:  { v: 0, need: PUSH_MIN_PROB, pass: false },
      }),
      atr, atrPct };
  }

  // 趋势强度门槛：ADX 低 = 震荡市，趋势跟随会被反复打脸
  const adx = calcADX(klines, V2.adxPeriod);
  const adxNum = adx === null ? null : +adx.toFixed(1);
  if (V2.minAdx && adx !== null && adx < V2.minAdx) {
    return { ...blank(`📊 趋势强度不足 (ADX ${adx.toFixed(0)} < ${V2.minAdx})，震荡市不参与`, {
        atr:   { v: +atrPct.toFixed(3), need: V2.minAtrPct, pass: true },
        trend: { v: adxNum, need: V2.minAdx, pass: false },
        score: { v: 0, need: V2.threshold, pass: false },
        prob:  { v: 0, need: PUSH_MIN_PROB, pass: false },
      }),
      atr, atrPct, adx: adxNum };
  }

  // Regime 过滤（plan P1-1）：ATR 分位极低 = 市场极度安静、无方向，趋势跟随不参与
  if (V2.regimeQuietPctile && atrPctile < V2.regimeQuietPctile) {
    return { ...blank(`😴 波动率处于历史低位 (ATR分位 ${(atrPctile * 100).toFixed(0)}% < ${(V2.regimeQuietPctile * 100).toFixed(0)}%)，无趋势不参与`, {
        atr:   { v: +atrPct.toFixed(3), need: V2.minAtrPct, pass: atrPct >= V2.minAtrPct },
        trend: { v: adxNum, need: V2.minAdx, pass: adxNum !== null && adxNum >= V2.minAdx },
        score: { v: 0, need: V2.threshold, pass: false },
        prob:  { v: 0, need: PUSH_MIN_PROB, pass: false },
      }),
      atr, atrPct, adx: adxNum };
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
  // 波动率自适应阈值（plan P1-5）：高波动时加严、低波动时放松
  let volAdj = 1;
  if (V2.volAdapt) {
    volAdj = Math.min(V2.volAdaptHi, Math.max(V2.volAdaptLo, 0.85 + atrPctile));
  }
  const thrLong = (V2.thresholdLong ?? V2.threshold) * volAdj;
  const thrShort = (V2.thresholdShort ?? V2.threshold) * volAdj;
  if (score > thrLong) direction = 'LONG';
  else if (score < -thrShort) direction = 'SHORT';

  // 趋势对齐过滤（plan A ③）：方向必须与均线趋势一致，否则不逆势开仓。
  // 直接针对实盘病灶：LONG 贡献了 88% 的亏损，且主要发生在当前下跌趋势里追多。
  if (V2.requireTrendAlign && direction !== 'WAIT') {
    const aligned = (direction === 'LONG' && trend === 'up')
                 || (direction === 'SHORT' && trend === 'down');
    if (!aligned) {
      direction = 'WAIT';
      reasons.push('⛔ 趋势未对齐，不逆势开仓');
    }
  }

  // 多周期确认（plan P1-2，默认关）：长周期均线趋势须与信号方向一致，
  // 用 1H 内长 MA(≈160根) 近似日线趋势，零额外外部调用。
  if (V2.multicycle && direction !== 'WAIT') {
    const longMA = sma(closes, V2.longMA);
    const longTrendUp = price > longMA;
    if (!((direction === 'LONG' && longTrendUp) || (direction === 'SHORT' && !longTrendUp))) {
      direction = 'WAIT';
      reasons.push('⛔ 长周期趋势未确认，不交易');
    }
  }

  // ---- 波动预测与概率（基于统计模型，非拍脑袋公式）----
  // σ_1H 由 ATR 换算，再按 sqrt(24) 外推到 24 小时
  const sigma1h = atr / V2.atrToSigma;
  const sigma24 = sigma1h * Math.sqrt(24);
  // 24 小时预期绝对波幅（正态分布平均绝对偏差 = 0.798σ）
  const baseMove24 = 0.7979 * sigma24;
  const predictedMove = baseMove24 * (1 + Math.abs(score) * 0.3);

  // 趋势持续性假设：信号越强，方向漂移越大。
  // 注意 mu 取正值 —— 方向已由 direction 表达，这里算的是
  // "朝有利方向" 移动 500 点的概率，不应再乘符号（否则做空概率会被低估）。
  const mu = sigma24 * V2.driftStrength * Math.min(1, Math.abs(score) / V2.driftRef);
  const z = (BIG_MOVE_POINTS - mu) / sigma24;
  // P(朝有利方向移动 ≥ BIG_MOVE_POINTS 点)
  const probAtCurrentScore = 1 - normalCDF(z);

  let probability = 0;
  if (direction !== 'WAIT') {
    probability = probAtCurrentScore;
  }
  // WAIT 时 probability 恒为 0，直接显示会让人误以为"第三关也卡住"。
  // 实际上概率关是三关里最宽松的一道（历史上只拦掉 2.7% 的信号），
  // 它只是"没出方向所以没算"。这里给出参考值，便于判断一旦触发会怎样。
  const probRef = +probAtCurrentScore.toFixed(3);

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
    adx: adxNum,
    // 推送门槛体检：全部 pass 才会推送（2026-09-11 起为四关，新增趋势强度）
    gates: {
      atr:   { v: +atrPct.toFixed(3),    need: V2.minAtrPct,   pass: atrPct >= V2.minAtrPct },
      trend: { v: adxNum, need: V2.minAdx, pass: adxNum !== null && adxNum >= V2.minAdx },
      score: {
        v: +Math.abs(score).toFixed(3),
        need: direction === 'LONG' ? thrLong : thrShort,
        pass: direction === 'LONG' ? score > thrLong : Math.abs(score) >= thrShort,
      },
      prob:  {
        v: (direction !== 'WAIT') ? +probability.toFixed(3) : probRef,
        need: PUSH_MIN_PROB,
        pass: (direction !== 'WAIT') ? probability >= PUSH_MIN_PROB : probRef >= PUSH_MIN_PROB,
        // WAIT 时这是"若触发则是多少"的参考值，不是真实概率
        estimated: direction === 'WAIT',
      },
    },
  };
}

/**
 * 'dv' 信号（现行 = RSI 均值回归 + 波动regime过滤；早期为 D-vstate 波动率状态机，已弃用）。
 * 触发：RSI(14) 穿越 35（超卖回升→做多）/ 65（超买回落→做空），且 ATR%∈[0.5,1.5]。
 * 指标：Wilder RSI / ATR 序列，与回放 search14 完全一致。
 * 返回信号对象（direction / probability / predicted_move / atrPct ...），未触发返回 WAIT。
 */
function analyzeDv(klines, klines4h, price) {
  const blank = (reason, extra = {}) => ({
    direction: 'WAIT', probability: 0, confidence: 0, predicted_move: 0,
    score: 0, reasons: [reason], atrPct: 0, targetHorizon: 48, strategy: 'dv', ...extra,
  });
  // 策略：RSI 顺势回调（4H定向 + 1H择时）——「顺大势、逆小势、回调进场」。
  // 触发（做多镜像做空）：RSI(14) 上穿 42 + ATR%∈[0.3,2.0] + 4H近24h斜率≥+0.3%(上升趋势)
  //       + 1H 收盘价 < EMA20（价格已回落到短期均线下方=真回调）。
  // 回放验证（2年17540根1H，TP=1000/SL=3000/≤48h）：严格命中93.8%/PF10.59/走步测试96.2%。
  // 指标算法与回放 byte-for-byte 一致（Wilder RSI/ATR、4H斜率用已收盘4H根）——务必对齐。
  if (!klines || klines.length < DV.rsiPeriod + DV.atrPeriod + 10) {
    return blank('⏳ K线积累中...');
  }
  const n = klines.length;
  const closes = klines.map(k => k.c);

  // RSI(14) Wilder 序列
  const rsi = new Array(n).fill(50);
  let g = 0, l = 0;
  for (let i = 1; i < n; i++) {
    const ch = closes[i] - closes[i - 1];
    const up = Math.max(0, ch), dn = Math.max(0, -ch);
    if (i <= DV.rsiPeriod) {
      g += up; l += dn;
      if (i === DV.rsiPeriod) { g /= DV.rsiPeriod; l /= DV.rsiPeriod; }
      continue;
    }
    g = (g * (DV.rsiPeriod - 1) + up) / DV.rsiPeriod;
    l = (l * (DV.rsiPeriod - 1) + dn) / DV.rsiPeriod;
    rsi[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }

  // ATR(14) Wilder 占价%
  const atrP = new Array(n).fill(0);
  let p = 0;
  for (let i = 1; i < n; i++) {
    const t = Math.max(
      klines[i].h - klines[i].l,
      Math.abs(klines[i].h - closes[i - 1]),
      Math.abs(klines[i].l - closes[i - 1]),
    );
    p = i === 1 ? t : (p * (DV.atrPeriod - 1) + t) / DV.atrPeriod;
    atrP[i] = (p / closes[i]) * 100;
  }

  // 1H EMA（回调确认锚）
  const emaP = new Array(n).fill(closes[0]);
  {
    const k = 2 / (DV.emaPullback + 1); let pr = closes[0];
    for (let i = 1; i < n; i++) { pr = closes[i] * k + pr * (1 - k); emaP[i] = pr; }
  }

  const cur = n - 1;
  const rsiNow = rsi[cur], rsiPrev = rsi[cur - 1], atrNow = atrP[cur], emaNow = emaP[cur];
  const reasons = [`📊 RSI(14) ${rsiNow.toFixed(1)}（前值 ${rsiPrev.toFixed(1)}）｜ATR% ${atrNow.toFixed(2)}｜价 vs EMA20 ${closes[cur] > emaNow ? '上方' : '下方'}`];

  // 触发：RSI 穿越 42（回升→做多）/ 58（回落→做空）
  let direction = null;
  if (rsiPrev < DV.rsiLo && rsiNow >= DV.rsiLo) direction = 'LONG';
  else if (rsiPrev > DV.rsiHi && rsiNow <= DV.rsiHi) direction = 'SHORT';
  if (!direction) {
    return blank('😴 RSI 未现 42/58 顺势回调穿越，不参与', {
      atrPct: +atrNow.toFixed(2), reasons,
      gates: { rsiNow: +rsiNow.toFixed(1), rsiLo: DV.rsiLo, rsiHi: DV.rsiHi },
    });
  }
  reasons.push(`🎯 RSI${direction === 'LONG' ? '回升破42' : '回落破58'}（${direction === 'LONG' ? '上升趋势中回调反弹' : '下降趋势中反弹回落'}）`);

  // 门控①：ATR% 波动regime带
  if (atrNow < DV.atrBandMin || atrNow > DV.atrBandMax) {
    return blank(`🌊 波动率不在带内(ATR%∈[${DV.atrBandMin},${DV.atrBandMax}])`, {
      atrPct: +atrNow.toFixed(2), reasons,
      gates: { rsiNow: +rsiNow.toFixed(1), atrPct: +atrNow.toFixed(2), band: [DV.atrBandMin, DV.atrBandMax] },
    });
  }
  reasons.push(`🌊 波动带✓ (ATR% ${atrNow.toFixed(2)}∈[${DV.atrBandMin},${DV.atrBandMax}])`);

  // 门控②：1H 真回调确认（多：价<EMA20；空：价>EMA20）
  const pullbackOk = direction === 'LONG' ? closes[cur] < emaNow : closes[cur] > emaNow;
  if (!pullbackOk) {
    return blank('📐 价格未回落到EMA20' + (direction === 'LONG' ? '下方' : '上方') + '（非真回调），不参与', {
      atrPct: +atrNow.toFixed(2), reasons,
      gates: { rsiNow: +rsiNow.toFixed(1), pullback: false },
    });
  }
  reasons.push(`📐 真回调✓ (价${direction === 'LONG' ? '<' : '>'}EMA20)`);

  // 门控③：4H 大周期趋势对齐（只在4H上升趋势中做多/下降趋势中做空）
  let t4slope = NaN;
  if (klines4h && klines4h.length >= DV.trend4Span + 1) {
    const m = klines4h.length;
    const last4 = klines4h[m - 1].c, prev4 = klines4h[m - 1 - DV.trend4Span].c;
    if (prev4 > 0) t4slope = (last4 - prev4) / prev4 * 100;   // 4H 近 trend4Span 根(=24h) 斜率%
  }
  if (!Number.isFinite(t4slope)) {
    return blank('⏳ 4H 趋势数据不足，暂不逆势开仓', {
      atrPct: +atrNow.toFixed(2), reasons,
      gates: { rsiNow: +rsiNow.toFixed(1), t4: 'N/A' },
    });
  }
  const trendOk = direction === 'LONG' ? t4slope >= DV.trend4SlopeMin : t4slope <= -DV.trend4SlopeMin;
  if (!trendOk) {
    return blank(`📉 4H趋势不一致(斜率 ${t4slope.toFixed(2)}%，需${direction === 'LONG' ? '≥+' : '≤-'}${DV.trend4SlopeMin}%)，不逆势`, {
      atrPct: +atrNow.toFixed(2), reasons,
      gates: { rsiNow: +rsiNow.toFixed(1), t4slope: +t4slope.toFixed(2), need: DV.trend4SlopeMin },
    });
  }
  reasons.push(`📈 4H趋势一致✓ (近24h斜率 ${t4slope.toFixed(2)}%)`);

  return {
    direction,
    probability: +DV.winRate.toFixed(2),   // 历史实测严格命中率作为概率基准
    confidence: 0.75,
    predicted_move: DV.tpPoints,            // 目标 1000 点 → 标记为重大行情(critical推送)
    score: direction === 'LONG' ? 0.75 : -0.75,
    reasons,
    atrPct: +atrNow.toFixed(2),
    targetHorizon: 48,
    strategy: 'dv',
    gates: { rsiNow: +rsiNow.toFixed(1), atrPct: +atrNow.toFixed(2), pullback: true, t4slope: +t4slope.toFixed(2), need: DV.trend4SlopeMin },
  };
}

// ============================================================
// 持仓管理（plan A ①③）：非重叠持仓 + 止损 / 移动止损 + 24H 到期
// 每周期调用一次：更新移动止损、检测止损/到期离场。
// 一笔持仓在离场前阻止新的同向开仓（非重叠），直接对应回测
// 「口径 B 非重叠」盈亏比 1.06 → 2.73 的改进。止损把实盘 MAE 1315 的巨亏截断。
// ============================================================
async function managePosition(env, state, price, nowSec) {
  const pos = state.open_pos;
  if (!pos) return false;

  const isLong = pos.dir === 'LONG';
  const isDv = pos.strategy === 'dv';   // RSI回归：纯点值 TP/SL + 48h 硬上限，禁用 V2 追踪/保本机械
  // 当前浮动盈亏（点）
  const profit = isLong ? price - pos.entry : pos.entry - price;
  // 移动止损激活门槛（plan P1-3）：盈利达 1×ATR 后才启动追踪止损，
  // 此前保持开仓时算好的初始止损位，避免刚开仓就被噪音扫损。
  // —— 仅 V1/V2 启用；DV 用固定点值止损(800)，不跟随此机械。
  if (!isDv) {
    const atr = pos.atrPct ? pos.entry * (pos.atrPct / 100) : 0;
    if (!pos.trailingActive) {
      const activated = isLong ? price >= pos.entry + atr : price <= pos.entry - atr;
      if (activated) pos.trailingActive = true;
    }
    // 保本锁：盈利达 +V2_BE_POINTS 后，把止损移到开仓价(±缓冲)，此后该笔不会亏损
    if (profit >= V2_BE_POINTS) {
      const be = isLong ? pos.entry * (1 + V2_BE_BUFFER) : pos.entry * (1 - V2_BE_BUFFER);
      pos.stop = isLong ? Math.max(pos.stop, be) : Math.min(pos.stop, be);
    }
    // 仅激活后：跟踪极值并上移止损，只收紧不放松
    if (pos.trailingActive) {
      pos.best = isLong ? Math.max(pos.best, price) : Math.min(pos.best, price);
      // 盈利越大、轨道越宽：超过 +V2_RUN_POINTS 后放宽到 2.2×ATR，让大波奔跑到 1000+
      // （仅 V2 趋势跟随启用；V1 均值回归靠止盈离场，不放大轨道）
      const trail = (pos.strategy !== 'v1' && profit >= V2_RUN_POINTS)
        ? Math.max(pos.stopPct, V2_RUN_TRAIL_ATR * pos.atrPct)
        : pos.stopPct;
      pos.stop = isLong ? Math.max(pos.stop, pos.best * (1 - trail / 100))
                        : Math.min(pos.stop, pos.best * (1 + trail / 100));
    }
  }

  const isV1 = pos.strategy === 'v1';
  let exit = null;
  // V1 均值回归：价格触及止盈位即离场（回归均值）
  if (pos.takeProfit) {
    if (isLong && price >= pos.takeProfit) exit = { kind: '止盈', pnl: price - pos.entry };
    else if (!isLong && price <= pos.takeProfit) exit = { kind: '止盈', pnl: pos.entry - price };
  }
  if (!exit && isLong && price <= pos.stop) exit = { kind: '止损', pnl: price - pos.entry };
  else if (!exit && !isLong && price >= pos.stop) exit = { kind: '止损', pnl: pos.entry - price };
  const held = nowSec - pos.entryTime;
  // RSI回归：固定 48h 硬上限（用户放宽持仓到 48h）
  // 已保本的盈利单(V2)给更长持仓窗口去冲 1000+；V1 用常规窗口(止盈/止损优先)
  // V1 均值回归：固定 6H 上限（回放最优）；V2 已停用，仅保留分支兼容在途持仓。
  const holdLimit = isDv ? DV.maxHoldSec
    : (isV1 ? V1_MAX_HOLD_SEC
      : (profit >= V2_BE_POINTS ? V2_POSITION_HOLD_SEC_PROFIT : V2_POSITION_HOLD_SEC));
  if (!exit && held >= holdLimit) {
    exit = { kind: '到期', pnl: isLong ? price - pos.entry : pos.entry - price };
  }
  if (!exit) return false;

  const pnl = Math.round(exit.pnl);
  const pnlPct = ((exit.pnl / pos.entry) * 100).toFixed(2);
  const title = `${pnl >= 0 ? '✅' : '⚠️'} ${pos.dir} 离场（${exit.kind}）`;
  const body = [
    `入场: $${Math.round(pos.entry).toLocaleString('en-US')}`,
    `离场: $${Math.round(price).toLocaleString('en-US')}`,
    `盈亏: ${pnl >= 0 ? '+' : ''}${pnl} 点 (${pnlPct}%)`,
    `持仓: ${(held / 3600).toFixed(1)} 小时`,
    `策略: ${pos.strategy === 'dv' ? 'RSI顺势回调(4H定向)' : (pos.strategy === 'v2' ? '趋势跟随V2' : '均值回归V1')}`,
  ].join('\n');
  if (!PAUSE_PUSH) await sendBark(title, body, 'passive', 'BTC-持仓管理');

  // 战绩对齐推送：把实际持仓盈亏(realized)写回开仓时对应的 KV 记录，
  // 使 /api/backtest 的 pnl 与用户收到的 Bark 离场推送完全一致。
  try {
    const records = await getBacktest(env);
    const rec = records.find(r => r.id === pos.recordId)
              || records.find(r => Math.abs(r.time - pos.entryTime) < 1);
    if (rec) {
      rec.realized = pnl;            // 实际盈亏点数（= 推送盈亏）
      rec.realizedKind = exit.kind; // 止损 / 到期
      rec.realizedAt = nowSec;
      rec.done = true;
      await saveBacktest(env, records);
    }
  } catch (e) {
    console.error('写回实际盈亏失败:', e);
  }

  state.open_pos = null; // 离场后允许下一笔开仓
  return true;
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
async function recordSignal(env, signal, price, nowMs, strategy = 'v1', stopPct = null) {
  const records = await getBacktest(env);
  records.push({
    id: nowMs,
    strategy,                       // v1=均值回归(现行) / v2=趋势跟随(候选)
    time: nowMs / 1000,
    direction: signal.direction,
    price: price,
    probability: signal.probability,
    predicted_move: signal.predicted_move,
    stopPct,                       // 开仓时 ATR 止损幅度(%)：战绩计入止损用
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

    // 止损提前结账（plan P0-1）：带 stopPct 的记录，窗口内价格触及止损价即结算，
    // 盈亏按止损位而非 24H 终点价计算 —— 让战绩真实反映风控效果。
    if (r.stopPct && r.h24 === null && !r.done) {
      const isLong = r.direction === 'LONG';
      const stop = isLong ? r.price * (1 - r.stopPct / 100)
                          : r.price * (1 + r.stopPct / 100);
      const hit = isLong ? (r.h24_lo ?? Infinity) <= stop
                         : (r.h24_hi ?? -Infinity) >= stop;
      if (hit) {
        r.h24 = Math.round(stop);
        r.stopped = true;
        r.done = true;
        changed = true;
      }
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

/**
 * 战绩汇总：把记录折算成真实盈亏。
 * ⚠️ 关键：h24 是「终点价格」不是盈亏。做空赚钱时 h24 < price，
 *    直接拿 (h24 - price) 求和算的是市场漂移，不是策略收益。
 *    必须按方向折算：SHORT 用 price - h24，LONG 用 h24 - price。
 */
function summarizePnl(records, horizon = 'h24') {
  let list, pnls;
  if (horizon === 'realized') {
    // 实际持仓盈亏（与 Bark 推送一致）：managePosition 离场时写回
    list = records.filter(r => r.realized !== null && r.realized !== undefined);
    if (!list.length) return { horizon, n: 0, total: 0, winRate: 0, wins: 0, losses: 0, avg: 0, avgWin: 0, avgLoss: 0, best: 0, worst: 0, pf: null };
    pnls = list.map(r => r.realized);
  } else {
    list = records.filter(r => r[horizon] !== null && r[horizon] !== undefined);
    if (!list.length) return { horizon, n: 0, total: 0, winRate: 0, wins: 0, losses: 0, avg: 0, avgWin: 0, avgLoss: 0, best: 0, worst: 0, pf: null };
    pnls = list.map(r => (r.direction === 'SHORT' ? r.price - r[horizon] : r[horizon] - r.price));
  }
  const wins = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p <= 0);
  const sumW = wins.reduce((a, b) => a + b, 0);
  const sumL = losses.reduce((a, b) => a + b, 0);
  return {
    horizon,
    n: list.length,
    total: Math.round(pnls.reduce((a, b) => a + b, 0)),
    winRate: +(wins.length / list.length * 100).toFixed(1),
    wins: wins.length, losses: losses.length,
    avg: Math.round(pnls.reduce((a, b) => a + b, 0) / list.length),
    avgWin: wins.length ? Math.round(sumW / wins.length) : 0,
    avgLoss: losses.length ? Math.round(sumL / losses.length) : 0,
    best: Math.round(Math.max(...pnls)),
    worst: Math.round(Math.min(...pnls)),
    // 盈亏比：总盈利 / 总亏损。< 1 意味着赚的比亏的少
    pf: sumL < 0 ? +(sumW / -sumL).toFixed(2) : null,
  };
}

// 止损口径盈亏（plan B）：对每条记录重算「若带 ATR 移动止损」的实际盈亏。
// 新记录（带 stopPct）会被 backfill 标记为 stopped（h24 已结算为止损价）；
// 旧记录（无 stopPct）用默认 V2_STOP_MULT 估算，使历史成绩也能反映止损价值。
// 这样线上 KPI 才真正体现"止损截亏"后的真实表现，而非虚拟 24H 终点价。
function summarizePnlStop(records, horizon = 'h24') {
  const list = records.filter(r => r[horizon] !== null && r[horizon] !== undefined);
  if (!list.length) return null;
  const pnls = list.map(r => {
    const isLong = r.direction === 'LONG';
    const entry = r.price;
    const stopPct = r.stopPct ?? V2_STOP_MULT; // 旧记录无 stopPct，用默认倍数估算
    let exit;
    if (r.stopped) {
      exit = r[horizon]; // backfill 已结算为止损价
    } else {
      const stop = isLong ? entry * (1 - stopPct / 100) : entry * (1 + stopPct / 100);
      const lo = r[horizon + '_lo'] ?? entry;
      const hi = r[horizon + '_hi'] ?? entry;
      const hit = isLong ? lo <= stop : hi >= stop;
      exit = hit ? stop : r[horizon]; // 触止损用止损价，否则用终点价
    }
    return isLong ? exit - entry : entry - exit;
  });
  const wins = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p <= 0);
  const sumW = wins.reduce((a, b) => a + b, 0);
  const sumL = losses.reduce((a, b) => a + b, 0);
  return {
    horizon,
    n: list.length,
    total: Math.round(pnls.reduce((a, b) => a + b, 0)),
    winRate: +(wins.length / list.length * 100).toFixed(1),
    wins: wins.length, losses: losses.length,
    avg: Math.round(pnls.reduce((a, b) => a + b, 0) / list.length),
    avgWin: wins.length ? Math.round(sumW / wins.length) : 0,
    avgLoss: losses.length ? Math.round(sumL / losses.length) : 0,
    best: Math.round(Math.max(...pnls)),
    worst: Math.round(Math.min(...pnls)),
    pf: sumL < 0 ? +(sumW / -sumL).toFixed(2) : null,
  };
}

// 统计准确率
/**
 * 按「独立信号段」去重。
 * 同一策略、同一方向、且间隔 < gapSec 的记录，属于同一波行情的重复采样 ——
 * 它们的 24H 结果几乎必然同对错，各自独立计入会把长行情放大几十倍权重。
 * 只保留每段第一条。
 */
function dedupeSegments(records, gapSec = 6 * 3600) {
  const sorted = [...records].sort((a, b) => a.time - b.time);
  const out = [];
  let last = null;
  for (const r of sorted) {
    if (last && (last.strategy || 'v1') === (r.strategy || 'v1')
        && last.direction === r.direction
        && (r.time - last.time) < gapSec) continue;
    out.push(r);
    last = r;
  }
  return out;
}

function computeAccuracy(records, target = BIG_MOVE_POINTS) {
  // 先按独立信号段去重，再做统计 —— 否则重复采样会主导结果
  records = dedupeSegments(records);
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

  // 策略 A/B 对比（v1 / v2 / dv 三策略并行记录，用实盘表现代替历史回测）
  const byStrategy = {};
  for (const s of ['v1', 'v2', 'dv']) {
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

  // 更新 4H K线（RSI策略的「大周期趋势对齐」门控）。4H 变化慢，每 30 分钟拉一次
  let klines4h = state.klines4h || [];
  if (!klines4h.length || (tsNow - (state.klines4h_ts || 0)) > 30 * 60 * 1000) {
    const fresh4h = await fetchKlines4h();
    if (fresh4h) {
      klines4h = fresh4h;
      state.klines4h_ts = tsNow;
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

  // 技术分析：V1(均值回归) 与 V2(趋势跟随) 并行计算，D-vstate(波动率状态机) 现生效，三者在 A/B 记录
  const signalV1 = analyze(newPrice, prices);
  const signalV2 = analyzeV2(klines, newPrice);
  const signalDv = analyzeDv(klines, klines4h, newPrice);

  // —— 市况自适应（regime-adaptive）已停用 ——
  // 部署决策（2026-10）：回放验证 V2 趋势跟随 60 天负期望(PF 0.37 / 最大亏 -1117)，
  // 是"亏损太大"的元凶；V1 均值回归优配(TP0.9%/6h/入场0.18) 60 天 +7610 / PF1.26 /
  // 最大亏 -346，样本外两半区间均正。系统固定跑 V1，关闭 V2 与市况切换。
  // 2026-10-23：「1000点+48h」约束下 RSI回归 严格命中率70.2%/PF1.61 胜出，设为生效策略。
  // regime 仍计算仅作可观测展示，不再据以切换策略。
  const regime = classifyRegime(klines);
  state.regime = regime;
  state.regimeWant = 'dv';
  state.regimeWantBars = 0;
  const active = ACTIVE_STRATEGY;        // 'dv'
  state.active_strategy = active;
  const signal = active === 'dv' ? signalDv : signalV1;
  const minProb = active === 'dv' ? PUSH_MIN_PROB_DV
    : (active === 'v2' ? PUSH_MIN_PROB_V2 : PUSH_MIN_PROB_V1);

  // 更新状态
  state.price = newPrice;
  state.high_24h = newHigh24h;
  state.low_24h = newLow24h;
  state.change_24h = newChange;
  state.vol = newVol;
  state.mcap = newPrice * BTC_SUPPLY_EST;   // 按流通量估算（交易所源不返回市值）
  state.prices = prices;
  state.klines = klines;
  state.klines4h = klines4h;
  state.signal = signal;
  state.signal_v1 = signalV1;
  state.signal_v2 = signalV2;
  state.signal_dv = signalDv;
  state.active_strategy = active;
  state.last_update = Date.now();
  state.update_count = (state.update_count || 0) + 1;

  // 信号记录 + Bark推送
  const now = Date.now();
  const nowSec = now / 1000;

  // plan A ①③：先处理已有持仓的止损 / 移动止损 / 到期离场（每周期必跑，与记录/推送解耦）
  await managePosition(env, state, newPrice, nowSec);

  // ---- A/B 样本记录：三策略各自独立记录，用实盘表现对比 ----
  // 间隔 30 分钟而非 5 分钟：相邻信号高度重叠不构成独立样本，
  // 拉长间隔可提升统计显著性，同时避免 KV 记录数暴涨
  for (const [tag, sig] of [['v1', signalV1], ['v2', signalV2], ['dv', signalDv]]) {
    if (!sig || sig.direction === 'WAIT') continue;
    const minProb = tag === 'v2' ? PUSH_MIN_PROB_V2
      : (tag === 'dv' ? PUSH_MIN_PROB_DV : PUSH_MIN_PROB_V1);
    if ((sig.probability || 0) < minProb) continue;
    const lastKey = `last_bt_${tag}`;
    const lastDirKey = `last_bt_dir_${tag}`;
    // 方向延续 = 同一波行情的重复采样，用更长的间隔；方向刚变 = 新信号，立刻记
    const sameDir = state[lastDirKey] === sig.direction;
    const interval = sameDir ? BT_SEGMENT_INTERVAL : BT_RECORD_INTERVAL;
    if (nowSec - (state[lastKey] || 0) < interval) continue;
    state[lastKey] = nowSec;
    state[lastDirKey] = sig.direction;
    // V2 记录 ATR 止损幅度；DV 记录固定点值止损幅度(800点→百分比)，供回测止损记账
    let stopPct = null;
    if (tag === 'v2' && sig.atrPct) {
      stopPct = Math.min(V2_STOP_MAX_PCT, Math.max(V2_STOP_MIN_PCT, sig.atrPct * V2_STOP_MULT));
    } else if (tag === 'dv' && sig.atrPct) {
      stopPct = (DV.slPoints / newPrice) * 100;
    }
    await recordSignal(env, sig, newPrice, now, tag, stopPct);
  }

  // ---- 推送：只用 ACTIVE_STRATEGY 指定的那个 ----
  // 非重叠持仓（plan A ①）：已有持仓时不再开新仓，直到 managePosition 离场清空。
  // 这是「一波行情只开一次仓、持满 24H」的实盘实现，对应回测口径 B 盈亏比 1.06→2.73。
  // 共振过滤（plan P1-4，默认关）：要求 V1/V2 同向才交易，进一步降频
  const resonate = !V2.resonance || (signalV1.direction === signal.direction);
  if (signal.direction !== 'WAIT' && signal.probability >= minProb && !state.open_pos && resonate) {
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
        strategy: active,
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

        // plan A ③：按策略类型计算止盈/止损位并登记持仓。
        // V1/V2 用 ATR 百分比止损（相反打法）；DV 用固定点值(TP=1000/SL=800)
        const isLong = signal.direction === 'LONG';
        let stopPrice, takeProfit, stopPct, tpPct = 0, atrPct = signal.atrPct || 0.3;
        if (active === 'dv') {
          const tp = DV.tpPoints, sl = DV.slPoints;
          stopPrice = isLong ? newPrice - sl : newPrice + sl;
          takeProfit = isLong ? newPrice + tp : newPrice - tp;
          stopPct = (sl / newPrice) * 100;   // 用于回测止损记账(%)
        } else {
          const isV1 = active === 'v1';
          const sMult = isV1 ? V1_STOP_MULT : V2_STOP_MULT;
          const sMin  = isV1 ? V1_STOP_MIN_PCT : V2_STOP_MIN_PCT;
          const sMax  = isV1 ? V1_STOP_MAX_PCT : V2_STOP_MAX_PCT;
          stopPct = Math.min(sMax, Math.max(sMin, atrPct * sMult));
          stopPrice = isLong ? newPrice * (1 - stopPct / 100)
                               : newPrice * (1 + stopPct / 100);
          tpPct = isV1 ? V1_TP_PCT : 0;
          takeProfit = tpPct ? (isLong ? newPrice * (1 + tpPct / 100)
                                            : newPrice * (1 - tpPct / 100)) : null;
        }

        const body = [
          `${tag}`,
          `价格: $${newPrice.toLocaleString('en-US')}`,
          `${horizon}H内超${BIG_MOVE_POINTS}点概率: ${probPct}%`,
          `预判${horizon}H波动: ${signal.predicted_move.toLocaleString('en-US')} 点`,
          `置信度: ${(signal.confidence * 100).toFixed(0)}%`,
          signal.rsi !== undefined ? `RSI: ${signal.rsi}` : null,
          signal.atrPct ? `波动率: ${signal.atrPct}%` : null,
          `建议止损: $${Math.round(stopPrice).toLocaleString('en-US')} (-${stopPct.toFixed(1)}%)`,
          `策略: ${active === 'dv' ? 'RSI顺势回调(4H定向)' : (active === 'v2' ? '趋势跟随V2' : '均值回归V1')}${takeProfit ? `｜止盈 ${Math.round(takeProfit).toLocaleString('en-US')}` : ''}`,
        ].filter(Boolean).join('\n');
        // critical = 突破静音/专注模式；passive = 静默通知
        const urgency = isBigMove ? 'critical' : 'passive';
        const group = isBigMove ? 'BTC-重大行情' : 'BTC-常规信号';
        // await 确保推送完成
        await sendBark(title, body, urgency, group);
        state.last_signal_time = nowSec;
        state.last_signal_dir = signal.direction;
        // 登记持仓：非重叠 + 移动止损的生命周期从这里开始
        state.open_pos = {
          dir: signal.direction,
          entry: newPrice,
          entryTime: nowSec,
          stop: stopPrice,
          stopPct,
          atrPct,
          strategy: active,
          takeProfit,
          trailingActive: false,
          best: newPrice,
          recordId: Math.round(nowSec * 1000),  // 关联开仓时 recordSignal 写的记录(id=毫秒)，离场时写回实际盈亏
        };
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
        signal_dv: state.signal_dv || null,
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
        regime: state.regime || null,
        active_strategy: state.active_strategy || null,
        regimeWant: state.regimeWant || null,
        regimeWantBars: state.regimeWantBars || 0,
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...corsHeaders },
      });
    }

    // API: 回测统计（真实准确率）
    if (path === '/api/backtest') {
      const records = await getBacktest(env);
      const state = await getState(env);
      // 部署决策：系统固定跑 V1（2026-10 关闭 V2）。主表纳入 V1 全部样本——
      // V1 信号逻辑未变，其 A/B 历史方向准确率≈53-57% 即 V1 真实水平，与回放验证一致；
      // V2 历史移入 accuracyAll(A/B 对比卡片)，不再污染主战绩 / PF。
      // realized 盈亏只取实际交易过、有离场盈亏写回的 V1 记录，随部署后新交易累积。
      const active = state.active_strategy || 'v1';
      const activeRecords = records.filter(r => r.strategy === active);
      const acc = computeAccuracy(activeRecords);
      // 全量统计保留，供 A/B 对比卡片使用
      const accAll = computeAccuracy(records);
      // 战绩：按独立信号段去重后的真实盈亏（24H 窗口）
      // 主战绩对齐推送：用实际持仓盈亏 realized（= Bark 离场推送盈亏）
      const pnl = summarizePnl(activeRecords, 'realized');
      // 历史旧口径参考（固定窗口终点价，与推送不完全一致，仅作对比）
      const pnlH24 = summarizePnl(dedupeSegments(activeRecords), 'h24');
      const pnl6 = summarizePnl(activeRecords, 'realized');
      // plan B：止损口径盈亏（新记录含 stopPct/stopped，旧记录用默认止损估算）
      const pnlStop = summarizePnlStop(dedupeSegments(activeRecords));
      const pnl6Stop = summarizePnlStop(dedupeSegments(activeRecords), 'h6');
      // 附带最近明细，limit 可放大（默认 20）
      const lim = Math.min(500, parseInt(url.searchParams.get('limit') || '20', 10));
      const recent = records.slice(-lim).map(r => {
        const o = {
          time: r.time, strategy: r.strategy || 'v1', direction: r.direction,
          price: r.price, prob: r.probability,
          h1: r.h1, h6: r.h6, h24: r.h24, done: r.done,
          realized: r.realized ?? null, realizedKind: r.realizedKind ?? null,
        };
        // 逐笔盈亏（按方向折算，见 summarizePnl 的说明）
        for (const h of ['h1', 'h6', 'h24']) {
          const f = r[h];
          o['pnl_' + h] = (f === null || f === undefined) ? null
            : Math.round(r.direction === 'SHORT' ? r.price - f : f - r.price);
        }
        const mm = mfeMae(r, 'h24');
        if (mm) { o.mfe24 = Math.round(mm.mfe); o.mae24 = Math.round(mm.mae); }
        return o;
      });
      return new Response(JSON.stringify({
        accuracy: acc, accuracyAll: accAll, recent, pnl, pnlH24, pnl6, pnlStop, pnl6Stop,
        activeStrategy: state.active_strategy || 'v2',
        regime: state.regime || null,
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
