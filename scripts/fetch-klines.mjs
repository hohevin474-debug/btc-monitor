#!/usr/bin/env node
/**
 * 抓取 OKX 历史 K 线，输出 JSON 到本地文件。
 *
 * 用途：沙箱环境的 DNS 把交易所域名黑洞掉了（alidns 返回 169.254.0.2），
 * 但 GitHub Actions 的 runner 在美国机房，网络不受限。
 * 所以把抓取逻辑放进 workflow，产物用 artifact 带回本地再跑回测。
 *
 * 用法：node scripts/fetch-klines.mjs [bar] [total] [outfile]
 *   bar: 1m/5m/15m/1H/4H/1D，默认 1H
 *   total: 总根数，默认 3000（1H ≈ 125 天）
 */
import { writeFileSync } from 'node:fs';

const bar = process.argv[2] || '1H';
const total = parseInt(process.argv[3] || '3000', 10);
const out = process.argv[4] || `/tmp/klines_${bar}.json`;

// market/candles 的最新数据只回溯约 1440 根（1H ≈ 60 天），
// 要更早的历史得切到 history-candles（单页上限 100，但能一直往前翻）。
const ENDPOINTS = [
  { url: 'https://www.okx.com/api/v5/market/candles', max: 300, tag: 'candles' },
  { url: 'https://www.okx.com/api/v5/market/history-candles', max: 100, tag: 'history' },
];

async function fetchFrom(ep, after) {
  const url = `${ep.url}?instId=BTC-USDT&bar=${bar}&limit=${ep.max}` +
    (after ? `&after=${after}` : '');
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} @ ${ep.tag}`);
  const json = await res.json();
  if (json.code !== '0') throw new Error(`OKX ${ep.tag} error ${json.code}: ${json.msg}`);
  return json.data || [];
}

let epIdx = 0;
async function fetchPage(after) {
  return fetchFrom(ENDPOINTS[epIdx], after);
}

const seen = new Map(); // ts -> candle

let after = '';
let page = 0;
while (seen.size < total) {
  const rows = await fetchPage(after);
  page += 1;
  if (!rows.length) break;

  let oldest = Infinity;
  for (const r of rows) {
    const ts = Number(r[0]);
    // OKX 返回 [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]
    seen.set(ts, {
      ts,
      open: parseFloat(r[1]),
      high: parseFloat(r[2]),
      low: parseFloat(r[3]),
      close: parseFloat(r[4]),
      volume: parseFloat(r[5]),
    });
    if (ts < oldest) oldest = ts;
  }
  process.stderr.write(`  第 ${page} 页: +${rows.length} 根，累计 ${seen.size}，最老 ${new Date(oldest).toISOString()}\n`);

  const cur = ENDPOINTS[epIdx];
  if (rows.length < cur.max) {
    // 当前端点翻到头了：换下一个端点（candles → history）继续往前挖
    if (epIdx < ENDPOINTS.length - 1) {
      epIdx += 1;
      process.stderr.write(`  ↳ 切到 ${ENDPOINTS[epIdx].tag} 端点继续回溯\n`);
      after = String(oldest);
      await new Promise((r) => setTimeout(r, 300));
      continue;
    }
    break;
  }
  if (oldest === Infinity) break;
  after = String(oldest);
  await new Promise((r) => setTimeout(r, 250)); // 温柔一点，别触发限流
}

// 按时间升序，且丢弃最后一根未收盘的 K 线（confirm=0 会导致回测失真）
const sorted = [...seen.values()].sort((a, b) => a.ts - b.ts);
while (sorted.length && sorted[sorted.length - 1].ts > Date.now() - 60_000) sorted.pop();

const meta = {
  source: 'okx',
  instId: 'BTC-USDT',
  bar,
  count: sorted.length,
  from: new Date(sorted[0]?.ts || 0).toISOString(),
  to: new Date(sorted[sorted.length - 1]?.ts || 0).toISOString(),
  fetchedAt: new Date().toISOString(),
};

writeFileSync(out, JSON.stringify({ meta, candles: sorted }, null, 0));
console.log(JSON.stringify(meta, null, 2));
