/**
 * BTC 实时监控 - Cloudflare Worker
 * 
 * 功能：
 * - 每分钟通过 Cron Trigger 拉取 BTC 价格
 * - 技术分析（RSI/MACD/布林带/均线）
 * - 存储价格历史到 KV
 * - 强信号触发 Bark 推送
 * - HTTP 接口提供实时面板数据
 */

// ============================================================
// 配置
// ============================================================
const BARK_KEY = 'jNVNkxWwVd88vNYoq7RxMa';
const BARK_URL = `https://api.day.app/${BARK_KEY}`;
const BARK_COOLDOWN = 180; // 同一方向信号最小间隔（秒）

// CoinLore API 获取 BTC 价格
const COINLORE_URL = 'https://api.coinlore.net/api/ticker/?id=90';

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

  // 宏观
  score -= 0.22; reasons.push('🌍 美伊冲突持续，地缘政治风险');
  score += 0.13; reasons.push('📰 CPI/PPI降温，降息预期利好');

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
// Bark 推送
// ============================================================
async function sendBark(title, body, urgency = 'active') {
  try {
    const resp = await fetch(BARK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        title, body, level: urgency,
        sound: 'alarm.caf', badge: 1,
        group: 'BTC-Signal', isArchive: 1,
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
// 主逻辑：拉取价格 + 分析
// ============================================================
async function fetchAndAnalyze(env) {
  const state = await getState(env);

  // 拉取 CoinLore 价格
  let newPrice = state.price;
  let newHigh24h = state.high_24h;
  let newLow24h = state.low_24h;
  let newChange = state.change_24h;
  let newVol = state.vol;
  let newMcap = state.mcap;

  try {
    const resp = await fetch(COINLORE_URL, {
      headers: { 'User-Agent': 'BTC-Monitor/1.0' }
    });
    const data = await resp.json();
    if (data && data[0]) {
      const d = data[0];
      newPrice = parseFloat(d.price_usd);
      newChange = parseFloat(d.percent_change_24h);
      newVol = parseFloat(d.volume24);
      newMcap = parseFloat(d.market_cap_usd);

      // 根据24h变化推算 open
      const open = +(newPrice / (1 + newChange / 100)).toFixed(2);
      // 追踪24H高低
      if (newPrice > newHigh24h) newHigh24h = newPrice;
      if (newPrice < newLow24h) newLow24h = newPrice;
    }
  } catch (e) {
    console.error('CoinLore 拉取失败:', e);
  }

  // 更新价格历史（最多300条）
  const prices = state.prices || [];
  if (prices.length === 0 || newPrice !== prices[prices.length - 1]) {
    prices.push(newPrice);
  }
  if (prices.length > 300) prices.splice(0, prices.length - 300);

  // 技术分析
  const signal = analyze(newPrice, prices);

  // 更新状态
  state.price = newPrice;
  state.high_24h = newHigh24h;
  state.low_24h = newLow24h;
  state.change_24h = newChange;
  state.vol = newVol;
  state.mcap = newMcap;
  state.prices = prices;
  state.signal = signal;
  state.last_update = Date.now();
  state.update_count = (state.update_count || 0) + 1;

  // 强信号记录 + Bark推送
  const now = Date.now();
  if (signal.direction !== 'WAIT' && signal.probability >= 0.5) {
    if (!state.history) state.history = [];
    const lastHist = state.history[state.history.length - 1];
    if (!lastHist || lastHist.direction !== signal.direction || (now / 1000 - lastHist.time) > 300) {
      state.history.push({
        time: now / 1000,
        price: newPrice,
        direction: signal.direction,
        probability: signal.probability,
        predicted_move: signal.predicted_move,
        confidence: signal.confidence,
      });
      if (state.history.length > 100) state.history.shift();

      // Bark推送
      const cooldownOk = (now / 1000 - (state.last_signal_time || 0)) >= BARK_COOLDOWN;
      const dirChanged = state.last_signal_dir !== signal.direction;
      if (cooldownOk || dirChanged) {
        const dirCN = signal.direction === 'LONG' ? '做多 LONG 📈' : '做空 SHORT 📉';
        const emoji = signal.direction === 'LONG' ? '🟢' : '🔴';
        const probPct = (signal.probability * 100).toFixed(0);
        const title = `${emoji} ${dirCN}`;
        const body = [
          `价格: $${newPrice.toLocaleString('en-US')}`,
          `超500点概率: ${probPct}%`,
          `预判波动: ${signal.predicted_move.toLocaleString('en-US')} 点`,
          `置信度: ${(signal.confidence * 100).toFixed(0)}%`,
          `RSI: ${signal.rsi}`,
        ].join('\n');
        const urgency = probPct >= 70 ? 'timeSensitive' : 'active';
        // 不 await，异步发送
        sendBark(title, body, urgency);
        state.last_signal_time = now / 1000;
        state.last_signal_dir = signal.direction;
      }
    }
  }

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

    // API: 获取完整状态
    if (path === '/api/state') {
      // 每次请求时也拉取最新价格（实时性更好）
      const state = await fetchAndAnalyze(env);
      return new Response(JSON.stringify({
        price: state.price,
        high_24h: state.high_24h,
        low_24h: state.low_24h,
        change_24h: state.change_24h,
        volume_24h: state.vol,
        market_cap: state.mcap,
        signal: state.signal,
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
