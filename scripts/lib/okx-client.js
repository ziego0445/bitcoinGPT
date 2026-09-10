// Thin REST client for OKX's v5 API (USDT-margined perpetual swaps) — only the calls
// scripts/live-trade-ict.js actually needs, not a general-purpose SDK. Mirrors the shape
// of scripts/lib/bitget-client.js (same function names/roles where they overlap) so the
// two live-trade scripts read the same way, even though the wire formats differ.
//
// Auth: HMAC-SHA256 per https://www.okx.com/docs-v5/en/#overview-rest-authentication —
//   OK-ACCESS-SIGN = base64(HMAC_SHA256(secret, timestamp + method + requestPath(+query) + body))
//   timestamp is ISO-8601 (new Date().toISOString()), not epoch ms like Bitget's.
//
// This account is in hedge mode (posMode: "long_short_mode", checked against
// GET /api/v5/account/config on setup), so every order/position call names its side
// explicitly. The bot trades BOTH directions now — it follows whichever way recent ICT
// signals have been leaning — so posSide is a parameter, defaulting to "long".
//
// No dependency needed: Node's global fetch + built-in crypto cover HMAC signing.

const crypto = require("crypto");

const BASE_URL = "https://www.okx.com";
const INST_TYPE = "SWAP";
const POS_SIDE = "long";
// Node's fetch has no default timeout — a hung TCP connection (a network blip, OKX-side
// stall, whatever) leaves the `await fetch()` below pending forever. That single stuck
// call keeps runTick()'s `tickInFlight` guard true permanently, silently freezing the
// whole bot (still alive as a process, zero further ticks) — this is exactly what
// happened to the real ICT bot for ~48h after its first live trade closed. Every request
// gets a hard ceiling so a stall surfaces as a normal rejected promise (caught by
// runTick's try/catch, retried next tick) instead of hanging the process forever.
const REQUEST_TIMEOUT_MS = 15_000;

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

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(`${BASE_URL}${requestPath}`, {
      method,
      headers: {
        "OK-ACCESS-KEY": config.apiKey,
        "OK-ACCESS-SIGN": signature,
        "OK-ACCESS-TIMESTAMP": timestamp,
        "OK-ACCESS-PASSPHRASE": config.apiPassphrase,
        "Content-Type": "application/json",
      },
      body: bodyString || undefined,
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new OkxApiError("timeout", `request timed out after ${REQUEST_TIMEOUT_MS}ms`, path);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

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
  // The epsilon absorbs float error: 0.06 / 0.01 evaluates to 5.999999999999999, so a
  // bare floor lands one step short on a value that is exactly on a step.
  const stepped = Math.floor(contracts / contract.lotSz + 1e-9) * contract.lotSz;
  const bounded = Math.max(stepped, contract.minSz);
  const decimals = (String(contract.lotSz).split(".")[1] || "").length;
  return bounded.toFixed(decimals);
}

// Returns whichever side currently holds size, not just "long" — the ICT bot follows the
// dominant recent signal direction, so it can be short. `posSide` comes back on the result
// so callers know which way the open position is facing.
async function getPosition(config) {
  const data = await request(config, "GET", "/api/v5/account/positions", { query: { instId: config.symbol } });
  const position = (data || []).find((p) => Number(p.pos) !== 0);
  if (!position) return null;

  return {
    posSide: position.posSide, // "long" | "short"
    contracts: Math.abs(Number(position.pos)),
    avgPrice: Number(position.avgPx),
    unrealizedPL: Number(position.upl),
    margin: Number(position.margin || position.imr || 0),
    leverage: Number(position.lever),
  };
}

// Resting orders on this instrument — the ladder needs these both to notice tranche fills
// and to clear leftovers once a position is flat.
async function getPendingOrders(config) {
  const data = await request(config, "GET", "/api/v5/trade/orders-pending", { query: { instId: config.symbol } });
  return data ?? [];
}

// Cancels only the still-unfilled ENTRY tranches, leaving the reduce-only exits alone —
// see the Bitget client's copy for why this matters.
async function cancelEntryOrders(config) {
  const pending = await getPendingOrders(config);
  const entries = pending.filter((o) => o.reduceOnly !== "true" && o.reduceOnly !== true);
  if (!entries.length) return 0;
  const body = entries.map((o) => ({ instId: config.symbol, ordId: o.ordId }));
  await request(config, "POST", "/api/v5/trade/cancel-batch-orders", { body });
  return entries.length;
}

// OKX has no single "cancel everything" call, so this reads the open orders and cancels
// them in one batch. Called whenever the position is flat, so a half-filled ladder can
// never linger and open a position on its own later.
async function cancelAllOrders(config) {
  const pending = await getPendingOrders(config);
  if (!pending.length) return null;
  const body = pending.map((o) => ({ instId: config.symbol, ordId: o.ordId }));
  return request(config, "POST", "/api/v5/trade/cancel-batch-orders", { body });
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
async function placeOrder(config, { side, size, price, posSide = POS_SIDE, tpTriggerPrice, slTriggerPrice, clientOrderId, reduceOnly }) {
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
    // Hedge mode needs the side spelled out. A LONG ladder buys to open and sells to
    // close (posSide "long"); a SHORT ladder sells to open and buys to close ("short").
    posSide,
    // `price` makes it a resting limit order — the ladder needs fills at an exact level
    // even between 30s polls, which a market-on-detect order cannot give.
    ordType: price != null ? "limit" : "market",
    px: price != null ? String(price) : undefined,
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
    // Hedge mode keeps leverage per side, and this bot can open either one.
    for (const posSide of ["long", "short"]) {
      await request(config, "POST", "/api/v5/account/set-leverage", {
        body: { instId: config.symbol, lever: String(leverage), mgnMode: "isolated", posSide },
      });
    }
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
  getPendingOrders,
  cancelAllOrders,
  cancelEntryOrders,
  getAccount,
  placeOrder,
  getOrderDetail,
  getHistoryOrders,
  ensureAccountSetup,
};
