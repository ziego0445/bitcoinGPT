// Thin REST client for OKX's v5 API (USDT-margined perpetual swaps) — only the calls
// scripts/live-trade-ict.js actually needs, not a general-purpose SDK. Mirrors the shape
// of scripts/lib/bitget-client.js (same function names/roles where they overlap) so the
// two live-trade scripts read the same way, even though the wire formats differ.
//
// Auth: HMAC-SHA256 per https://www.okx.com/docs-v5/en/#overview-rest-authentication —
//   OK-ACCESS-SIGN = base64(HMAC_SHA256(secret, timestamp + method + requestPath(+query) + body))
//   timestamp is ISO-8601 (new Date().toISOString()), not epoch ms like Bitget's.
//
// This account is confirmed in hedge mode (posMode: "long_short_mode", checked against
// GET /api/v5/account/config on setup) — every order/position/leverage call below passes
// posSide: "long" explicitly. This script only ever trades LONG (see ict-signals.js
// backtest notes on why), so "short" is simply never used, not because hedge mode
// requires picking one.
//
// No dependency needed: Node's global fetch + built-in crypto cover HMAC signing.

const crypto = require("crypto");

const BASE_URL = "https://www.okx.com";
const INST_TYPE = "SWAP";
const POS_SIDE = "long";

class OkxApiError extends Error {
  constructor(code, okxMsg, path) {
    super(`OKX API error ${code} on ${path}: ${okxMsg}`);
    this.name = "OkxApiError";
    this.code = code;
    this.okxMsg = okxMsg;
  }
}

function loadConfig() {
  const apiKey = process.env.OKX_API_KEY;
  const apiSecret = process.env.OKX_API_SECRET;
  const apiPassphrase = process.env.OKX_API_PASSPHRASE;
  const symbol = process.env.OKX_SYMBOL ?? "BTC-USDT-SWAP";

  // Same convention as Bitget's BITGET_MARGIN_USDT: unset/"full" commits (~95% of)
  // whatever the account currently has: a number caps it regardless of balance.
  const rawMargin = process.env.OKX_MARGIN_USDT;
  const marginUsdt = rawMargin && rawMargin !== "full" ? Number(rawMargin) : null;

  if (!apiKey || !apiSecret || !apiPassphrase) {
    throw new Error("OKX_API_KEY / OKX_API_SECRET / OKX_API_PASSPHRASE environment variables are missing");
  }
  if (marginUsdt != null && (!Number.isFinite(marginUsdt) || marginUsdt <= 0)) {
    throw new Error('OKX_MARGIN_USDT must be a positive number, or unset/"full" to use the whole balance');
  }

  return { apiKey, apiSecret, apiPassphrase, marginUsdt, symbol };
}

function sign(secret, timestamp, method, requestPath, bodyString) {
  const prehash = `${timestamp}${method.toUpperCase()}${requestPath}${bodyString}`;
  return crypto.createHmac("sha256", secret).update(prehash).digest("base64");
}

function toQueryString(query) {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

async function request(config, method, path, { query, body } = {}) {
  const requestPath = `${path}${toQueryString(query)}`;
  const bodyString = body ? JSON.stringify(body) : "";
  const timestamp = new Date().toISOString();
  const signature = sign(config.apiSecret, timestamp, method, requestPath, bodyString);

  const response = await fetch(`${BASE_URL}${requestPath}`, {
    method,
    headers: {
      "OK-ACCESS-KEY": config.apiKey,
      "OK-ACCESS-SIGN": signature,
      "OK-ACCESS-TIMESTAMP": timestamp,
      "OK-ACCESS-PASSPHRASE": config.apiPassphrase,
      "Content-Type": "application/json",
    },
    body: bodyString || undefined,
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || payload.code !== "0") {
    throw new OkxApiError(payload?.code ?? String(response.status), payload?.msg ?? response.statusText, path);
  }
  return payload.data;
}

function toCandle(row) {
  // OKX candle rows: [ts, o, h, l, c, vol, volCcy, volCcyQuote, confirm]
  return { time: Number(row[0]), open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]) };
}

// Bar tokens: lowercase for sub-hour ("15m"), uppercase hour+ ("1H", "4H", "1D") per
// https://www.okx.com/docs-v5/en/#order-book-trading-market-data-get-candlesticks —
// verify against a real response before relying on anything other than "15m".
async function getCandles(config, { bar = "15m", limit = 200, after } = {}) {
  // `after` (ms) pages backwards past the endpoint's cap — pass the previous page's
  // earliest candle time to walk further into the past. Unused by live-trade-ict.js
  // itself (always wants "now"), useful for ad-hoc backtesting against OKX's own feed.
  const data = await request(config, "GET", "/api/v5/market/candles", {
    query: { instId: config.symbol, bar, limit: String(limit), after: after != null ? String(after) : undefined },
  });
  return data.map(toCandle).sort((a, b) => a.time - b.time);
}

// Contract spec needed to convert a BTC amount into the "sz" (contracts) an order wants.
async function getContractConfig(config) {
  const data = await request(config, "GET", "/api/v5/public/instruments", {
    query: { instType: INST_TYPE, instId: config.symbol },
  });
  const inst = Array.isArray(data) ? data[0] : data;
  if (!inst) throw new Error(`No instrument config returned for ${config.symbol}`);
  return { ctVal: Number(inst.ctVal), lotSz: Number(inst.lotSz), minSz: Number(inst.minSz) };
}

// `btcAmount` in the underlying asset (BTC) — divides by ctVal to get contracts, then
// rounds down to the lot step and up to the minimum, same shape as Bitget's roundSize().
function roundSize(btcAmount, contract) {
  const contracts = btcAmount / contract.ctVal;
  const stepped = Math.floor(contracts / contract.lotSz) * contract.lotSz;
  const bounded = Math.max(stepped, contract.minSz);
  const decimals = (String(contract.lotSz).split(".")[1] || "").length;
  return bounded.toFixed(decimals);
}

async function getPosition(config) {
  const data = await request(config, "GET", "/api/v5/account/positions", { query: { instId: config.symbol } });
  const position = (data || []).find((p) => p.posSide === POS_SIDE && Number(p.pos) !== 0);
  if (!position) return null;

  return {
    contracts: Number(position.pos),
    avgPrice: Number(position.avgPx),
    unrealizedPL: Number(position.upl),
    margin: Number(position.margin || position.imr || 0),
    leverage: Number(position.lever),
  };
}

async function getAccount(config) {
  const data = await request(config, "GET", "/api/v5/account/balance", { query: { ccy: "USDT" } });
  const acct = Array.isArray(data) ? data[0] : data;
  const usdt = (acct?.details ?? []).find((d) => d.ccy === "USDT");
  return {
    available: Number(usdt?.availBal ?? 0),
    equity: Number(usdt?.eq ?? acct?.totalEq ?? 0),
  };
}

// TP/SL are attached to the entry order itself (attachAlgoOrds), same idea as Bitget's
// presetStopSurplusPrice/presetStopLossPrice — OKX's matching engine manages the exit
// even if this process is offline when it triggers. ordPx "-1" means "execute at market
// once the trigger price is touched" rather than a limit price.
async function placeOrder(config, { side, size, tpTriggerPrice, slTriggerPrice, clientOrderId, reduceOnly }) {
  const attachAlgoOrds = [];
  if (tpTriggerPrice != null || slTriggerPrice != null) {
    attachAlgoOrds.push({
      attachAlgoClOrdId: clientOrderId ? `${clientOrderId}a` : undefined,
      tpTriggerPx: tpTriggerPrice != null ? String(tpTriggerPrice) : undefined,
      tpOrdPx: tpTriggerPrice != null ? "-1" : undefined,
      slTriggerPx: slTriggerPrice != null ? String(slTriggerPrice) : undefined,
      slOrdPx: slTriggerPrice != null ? "-1" : undefined,
    });
  }

  const body = {
    instId: config.symbol,
    tdMode: "isolated",
    side, // "buy" | "sell"
    posSide: POS_SIDE,
    ordType: "market",
    sz: size,
    clOrdId: clientOrderId,
    reduceOnly: reduceOnly ? true : undefined,
    attachAlgoOrds: attachAlgoOrds.length ? attachAlgoOrds : undefined,
  };

  const data = await request(config, "POST", "/api/v5/trade/order", { body });
  const result = Array.isArray(data) ? data[0] : data;
  // The outer call can succeed (code "0") while the individual order inside `data` still
  // failed — OKX reports that per-order, not at the top level.
  if (result?.sCode && result.sCode !== "0") {
    throw new OkxApiError(result.sCode, result.sMsg, "/api/v5/trade/order");
  }
  return result; // { ordId, clOrdId, ... }
}

async function getOrderDetail(config, { orderId }) {
  const data = await request(config, "GET", "/api/v5/trade/order", { query: { instId: config.symbol, ordId: orderId } });
  return Array.isArray(data) ? data[0] : data;
}

async function getHistoryOrders(config, { startTime, endTime }) {
  const data = await request(config, "GET", "/api/v5/trade/orders-history", {
    query: { instType: INST_TYPE, instId: config.symbol, begin: String(startTime), end: String(endTime ?? Date.now()) },
  });
  return data ?? [];
}

// Leverage is per-side in hedge mode. Non-fatal if it fails (e.g. a position is already
// open) — caller should log and continue, same convention as Bitget's ensureAccountSetup.
async function ensureAccountSetup(config, { leverage }) {
  const results = { leverage: null };
  try {
    await request(config, "POST", "/api/v5/account/set-leverage", {
      body: { instId: config.symbol, lever: String(leverage), mgnMode: "isolated", posSide: POS_SIDE },
    });
    results.leverage = "ok";
  } catch (error) {
    results.leverage = error.message;
  }
  return results;
}

module.exports = {
  OkxApiError,
  loadConfig,
  getCandles,
  getContractConfig,
  roundSize,
  getPosition,
  getAccount,
  placeOrder,
  getOrderDetail,
  getHistoryOrders,
  ensureAccountSetup,
};
