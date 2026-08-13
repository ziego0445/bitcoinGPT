// Thin REST client for Bitget's v2 "mix" API (USDT-margined perpetual futures) —
// only the calls scripts/live-trade.js actually needs, not a general-purpose SDK.
//
// Auth: HMAC-SHA256 per https://www.bitget.com/api-doc/common/signature —
//   ACCESS-SIGN = base64(HMAC_SHA256(secret, timestamp + method.toUpperCase() + requestPath + queryString + body))
// Demo trading (if BITGET_DEMO_TRADING=true) adds a `paptrading: 1` header and hits the
// same endpoints — see https://www.bitget.com/api-doc/classic/demotrading/restapi.
//
// No dependency needed: Node's global fetch + built-in crypto cover HMAC signing.

const crypto = require("crypto");
const { toCandle } = require("./signals");

const BASE_URL = "https://api.bitget.com";
const PRODUCT_TYPE = "USDT-FUTURES";
const MARGIN_COIN = "USDT";

class BitgetApiError extends Error {
  constructor(code, bitgetMsg, path) {
    super(`Bitget API error ${code} on ${path}: ${bitgetMsg}`);
    this.name = "BitgetApiError";
    this.code = code;
    this.bitgetMsg = bitgetMsg;
  }
}

function loadConfig() {
  const apiKey = process.env.BITGET_API_KEY;
  const apiSecret = process.env.BITGET_API_SECRET;
  const apiPassphrase = process.env.BITGET_API_PASSPHRASE;
  const demo = process.env.BITGET_DEMO_TRADING === "true";
  const symbol = process.env.BITGET_SYMBOL ?? "BTCUSDT";

  // Unset / "full" means "commit (almost) the whole account balance as margin each
  // trade" — see resolveMarginUsdt() in live-trade.js. Only set a number here if you
  // want a fixed cap regardless of balance.
  const rawMargin = process.env.BITGET_MARGIN_USDT;
  const marginUsdt = rawMargin && rawMargin !== "full" ? Number(rawMargin) : null;

  if (!apiKey || !apiSecret || !apiPassphrase) {
    throw new Error("BITGET_API_KEY / BITGET_API_SECRET / BITGET_API_PASSPHRASE environment variables are missing");
  }
  if (marginUsdt != null && (!Number.isFinite(marginUsdt) || marginUsdt <= 0)) {
    throw new Error("BITGET_MARGIN_USDT must be a positive number, or unset/\"full\" to use the whole balance");
  }

  return { apiKey, apiSecret, apiPassphrase, demo, marginUsdt, symbol, productType: PRODUCT_TYPE, marginCoin: MARGIN_COIN };
}

function sign(secret, timestamp, method, requestPath, queryString, bodyString) {
  const prehash = `${timestamp}${method.toUpperCase()}${requestPath}${queryString}${bodyString}`;
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
  const queryString = toQueryString(query);
  const bodyString = body ? JSON.stringify(body) : "";
  const timestamp = String(Date.now());
  const signature = sign(config.apiSecret, timestamp, method, path, queryString, bodyString);

  const headers = {
    "ACCESS-KEY": config.apiKey,
    "ACCESS-SIGN": signature,
    "ACCESS-TIMESTAMP": timestamp,
    "ACCESS-PASSPHRASE": config.apiPassphrase,
    "Content-Type": "application/json",
    locale: "en-US",
  };
  // Routes the call into Bitget's simulated-trading environment instead of the real
  // account — same base URL and endpoints, this header alone makes the difference.
  if (config.demo) headers.paptrading = "1";

  const response = await fetch(`${BASE_URL}${path}${queryString}`, {
    method,
    headers,
    body: bodyString || undefined,
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok || !payload || payload.code !== "00000") {
    const code = payload?.code ?? String(response.status);
    const msg = payload?.msg ?? response.statusText;
    throw new BitgetApiError(code, msg, path);
  }

  return payload.data;
}

// Candle granularity tokens are lowercase for sub-hour intervals ("5m"), unlike Binance's
// scheme this doesn't otherwise differ for our use, but don't assume — verify against a
// real response before relying on any interval other than "5m".
async function getCandles(config, { granularity = "5m", limit = 200, endTime } = {}) {
  // endTime (ms) pages backwards past the endpoint's 1000-row cap — pass the previous
  // page's earliest candle time minus 1ms to walk further into the past. Unused by
  // live-trade.js itself (always wants "now"), useful for ad-hoc backtesting.
  const data = await request(config, "GET", "/api/v2/mix/market/candles", {
    query: {
      symbol: config.symbol,
      productType: config.productType,
      granularity,
      limit: String(limit),
      endTime: endTime != null ? String(endTime) : undefined,
    },
  });
  // Don't trust whatever row order the API happens to return — sort ascending by time
  // ourselves so "drop the still-forming last candle" (`.slice(0, -1)`) is always correct
  // regardless of API ordering quirks.
  return data.map(toCandle).sort((a, b) => a.time - b.time);
}

// Contract step/minimum size, needed to round a computed order size to something Bitget
// will actually accept. Cache the result in the caller — this rarely changes.
async function getContractConfig(config) {
  const data = await request(config, "GET", "/api/v2/mix/market/contracts", {
    query: { symbol: config.symbol, productType: config.productType },
  });
  const contract = Array.isArray(data) ? data[0] : data;
  if (!contract) throw new Error(`No contract config returned for ${config.symbol}`);

  const volumePlace = Number(contract.volumePlace ?? 3);
  return {
    minTradeNum: Number(contract.minTradeNum),
    volumePlace,
    step: Number(contract.sizeMultiplier) || Math.pow(10, -volumePlace),
  };
}

function roundSize(size, contract) {
  const stepped = Math.floor(size / contract.step) * contract.step;
  const bounded = Math.max(stepped, contract.minTradeNum);
  return bounded.toFixed(contract.volumePlace);
}

async function getSinglePosition(config) {
  const data = await request(config, "GET", "/api/v2/mix/position/single-position", {
    query: { symbol: config.symbol, productType: config.productType, marginCoin: config.marginCoin },
  });
  const position = Array.isArray(data) ? data[0] : data;
  // An account with no open position returns an empty list/zero-size row, not an error.
  if (!position || Number(position.total) === 0) return null;

  return {
    holdSide: position.holdSide, // "long" | "short"
    total: Number(position.total),
    openPriceAvg: Number(position.openPriceAvg),
    unrealizedPL: Number(position.unrealizedPL),
    marginSize: Number(position.marginSize),
    leverage: Number(position.leverage),
  };
}

async function getAccount(config) {
  const data = await request(config, "GET", "/api/v2/mix/account/account", {
    query: { symbol: config.symbol, productType: config.productType, marginCoin: config.marginCoin },
  });
  return {
    available: Number(data.available),
    equity: Number(data.usdtEquity ?? data.accountEquity),
  };
}

async function placeOrder(config, { side, size, presetStopSurplusPrice, presetStopLossPrice, clientOid, reduceOnly }) {
  const body = {
    symbol: config.symbol,
    productType: config.productType,
    marginMode: "isolated",
    marginCoin: config.marginCoin,
    size,
    side, // "buy" | "sell"
    orderType: "market",
    presetStopSurplusPrice,
    presetStopLossPrice,
    clientOid,
    // "YES" when explicitly closing a position (e.g. the manual test-order flow) — keeps
    // a same-size sell from ever flipping into a new short if size/timing is slightly off.
    reduceOnly: reduceOnly ? "YES" : undefined,
  };
  // tradeSide is intentionally omitted — this account is set to one-way position mode
  // (see ensureAccountSetup below), and Bitget rejects orders that include tradeSide
  // while in one-way mode.
  return request(config, "POST", "/api/v2/mix/order/place-order", { body });
}

async function getOrderDetail(config, { orderId }) {
  return request(config, "GET", "/api/v2/mix/order/detail", {
    query: { symbol: config.symbol, productType: config.productType, orderId },
  });
}

async function getHistoryOrders(config, { startTime, endTime }) {
  const data = await request(config, "GET", "/api/v2/mix/order/orders-history", {
    query: {
      symbol: config.symbol,
      productType: config.productType,
      startTime: String(startTime),
      endTime: String(endTime ?? Date.now()),
    },
  });
  return data?.entrustedList ?? data ?? [];
}

// Best-effort account setup, run once at startup. Each call is independent and
// non-fatal: if a position is already open, Bitget will reject leverage/margin-mode
// changes (expected — you can't change those mid-position), so callers should log and
// continue rather than treat this as a startup-blocking failure.
async function ensureAccountSetup(config, { leverage }) {
  const results = { positionMode: null, marginMode: null, leverage: null };

  try {
    await request(config, "POST", "/api/v2/mix/account/set-position-mode", {
      body: { productType: config.productType, posMode: "one_way_mode" },
    });
    results.positionMode = "ok";
  } catch (error) {
    results.positionMode = error.message;
  }

  try {
    await request(config, "POST", "/api/v2/mix/account/set-margin-mode", {
      body: { symbol: config.symbol, productType: config.productType, marginCoin: config.marginCoin, marginMode: "isolated" },
    });
    results.marginMode = "ok";
  } catch (error) {
    results.marginMode = error.message;
  }

  try {
    await request(config, "POST", "/api/v2/mix/account/set-leverage", {
      body: { symbol: config.symbol, productType: config.productType, marginCoin: config.marginCoin, leverage: String(leverage) },
    });
    results.leverage = "ok";
  } catch (error) {
    results.leverage = error.message;
  }

  return results;
}

module.exports = {
  BitgetApiError,
  loadConfig,
  getCandles,
  getContractConfig,
  roundSize,
  getSinglePosition,
  getAccount,
  placeOrder,
  getOrderDetail,
  getHistoryOrders,
  ensureAccountSetup,
};
