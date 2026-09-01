// Runs continuously on the user's own always-on PC (NOT GitHub Actions — same reasoning
// as scripts/live-trade.js). Places real OKX orders for the ICT (Liquidity Sweep -> MSS ->
// FVG) strategy — scripts/lib/ict-signals.js. This is a SEPARATE exchange/account from the
// Bitget double-bottom bot on purpose: Bitget's one-way position mode would merge both
// bots' positions into one if they ever traded the same symbol on the same account,
// breaking independent $-amount allocation. OKX is a clean second account for this.
//
// Rules (from the 150-day/15m BTC backtest — see scripts/paper-trade-ict.js / docs/ict-strategy.md):
//   - LONG only. SHORT did not show a robust edge in backtesting.
//   - Stop-loss at the signal's own sweepPrice (the liquidity sweep's extreme).
//   - Take-profit at a fixed 2R (R_MULTIPLE below).
//   - Position size is a FIXED margin amount (OKX_MARGIN_USDT) per trade, same convention
//     as live-trade.js — real capital, not compounding simulation.
//
// Exits are detected, not decided, by this script: TP/SL are attached to the entry order
// itself (attachAlgoOrds -> tpTriggerPx/slTriggerPx), so OKX's engine guarantees the exit
// even if this process is offline when it happens. Each tick just polls the real
// position/order state and reconciles the local file — the exchange is always the source
// of truth, never the local JSON. See scripts/lib/okx-client.js for the exact API calls.
//
// This account is in hedge mode (posMode: "long_short_mode", confirmed on setup) — every
// order/position call passes posSide: "long" (see okx-client.js). Since this bot never
// trades SHORT, that's the only side it ever touches.
//
// Run it locally: run-live-trade-ict.bat (needs OKX_API_KEY / OKX_API_SECRET /
// OKX_API_PASSPHRASE / OKX_SYMBOL in .env — see the OKX section already there).

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { detectICTSignals } = require("./lib/ict-signals");
const okx = require("./lib/okx-client");
const { sendTelegram } = require("./lib/telegram");

async function notify(text) {
  try {
    await sendTelegram(text);
  } catch (error) {
    log("WARN: Telegram notification failed (trading continues):", error.message);
  }
}

const LEVERAGE = 10;
const R_MULTIPLE = 2;
const CANDLE_GRANULARITY = "15m";
const CANDLE_LIMIT = 200;
const POLL_INTERVAL_MS = 30_000;
const REPO_ROOT = path.join(__dirname, "..");
const STATE_PATH = path.join(REPO_ROOT, "data", "live-trades-ict.json");
const GIT_OPTS = { cwd: REPO_ROOT, stdio: "pipe" };

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {
      mode: "live",
      strategy: "ict-fvg",
      startingBalance: null, // filled in from the real account on the first tick
      currentBalance: null,
      startedAt: Date.now(),
      openPosition: null,
      trades: [],
    };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
}

// See live-trade.js's identical field for why this stays out of the persisted state.
let pushRetryNeeded = false;

function persistState(state, changed) {
  if (changed) saveState(state);
  if (!changed && !pushRetryNeeded) return;

  try {
    if (changed) {
      execFileSync("git", ["add", "data/live-trades-ict.json"], GIT_OPTS);
      execFileSync("git", ["commit", "-m", "Update ICT live-trade state [skip ci]"], GIT_OPTS);
    }
    execFileSync("git", ["pull", "--rebase", "origin", "main"], GIT_OPTS);
    execFileSync("git", ["push", "origin", "HEAD:main"], GIT_OPTS);
    log(pushRetryNeeded ? "Retried a previously failed push — succeeded." : "Committed and pushed ICT live-trade state.");
    pushRetryNeeded = false;
    purgeJsDelivrCache();
  } catch (error) {
    pushRetryNeeded = true;
    log("WARN: git commit/push failed, will retry next tick. Data is safe on disk either way.", error.message);
  }
}

const JSDELIVR_PURGE_URL = "https://purge.jsdelivr.net/gh/ziego0445/bitcoinGPT@main/data/live-trades-ict.json";

async function purgeJsDelivrCache() {
  try {
    const response = await fetch(JSDELIVR_PURGE_URL);
    if (!response.ok) throw new Error(`purge.jsdelivr.net ${response.status}`);
  } catch (error) {
    log("WARN: jsDelivr cache purge failed (dashboard may show stale state briefly):", error.message);
  }
}

function resumeWatermark(state) {
  if (state.openPosition) return state.openPosition.entryTime;
  if (state.trades.length) return state.trades[state.trades.length - 1].exitTime;
  return state.startedAt ?? null;
}

// Adopts an exchange position local state doesn't know about — same recovery scenario as
// live-trade.js's version (a lost response after a successful placeOrder()). Unlike the
// Bitget bot's fixed +-8%, this strategy's stop/target come from the signal that triggered
// entry (sweepPrice, 2R) — info this recovery path doesn't have, so TP/SL are left null.
// The exchange-side attachAlgoOrds still manage the actual exit regardless; this only
// affects how the eventual close gets labeled in trade history (see the balance-based
// fallback in reconcilePosition below).
function adoptUntrackedPosition(state, position) {
  log("Exchange reports an open position local state didn't know about — adopting it (entry time is a best-effort 'now').");
  state.openPosition = {
    pattern: "recovered",
    mssType: null,
    leverage: position.leverage || LEVERAGE,
    size: position.margin,
    entryTime: Date.now(),
    entryPrice: position.avgPrice,
    takeProfit: null,
    stopLoss: null,
    orderId: null,
  };
}

// Called every tick before looking for a new entry. Exchange state always wins.
//
// NOTE: field names for the closing-order lookup (side/reduceOnly/avgPx/uTime) are best
// guesses from OKX's documented order-history schema — this has NOT yet been verified
// against a real filled close on this account (no live order has been placed yet). Verify
// on the first real close and adjust if needed, same caveat live-trade.js's Bitget version
// carried until its own first live close confirmed the field names.
async function reconcilePosition(config, state) {
  const position = await okx.getPosition(config);

  if (position && !state.openPosition) {
    adoptUntrackedPosition(state, position);
    return;
  }
  if (position) return; // still open and already tracked — nothing to reconcile
  if (!state.openPosition) return; // idle tick, no position on either side

  const opened = state.openPosition;
  const history = await okx.getHistoryOrders(config, { startTime: opened.entryTime - 60_000 }).catch(() => []);
  const closingOrder = history.find(
    (order) => order.state === "filled" && order.side === "sell" && (order.reduceOnly === true || order.reduceOnly === "true"),
  );

  const account = await okx.getAccount(config);
  let exitPrice;
  let exitReason;

  if (closingOrder) {
    exitPrice = Number(closingOrder.avgPx ?? closingOrder.fillPx ?? closingOrder.px);
    const nearTakeProfit = opened.takeProfit != null && Math.abs(exitPrice - opened.takeProfit) / opened.takeProfit < 0.001;
    const nearStopLoss = opened.stopLoss != null && Math.abs(exitPrice - opened.stopLoss) / opened.stopLoss < 0.001;
    if (nearTakeProfit && !nearStopLoss) exitReason = "take-profit";
    else if (nearStopLoss && !nearTakeProfit) exitReason = "stop-loss";
    else exitReason = exitPrice >= opened.entryPrice ? "take-profit" : "stop-loss";
  } else {
    const balanceWentUp = state.currentBalance != null ? account.equity > state.currentBalance : true;
    exitReason = balanceWentUp ? "take-profit" : "stop-loss";
    exitPrice = (exitReason === "take-profit" ? opened.takeProfit : opened.stopLoss) ?? opened.entryPrice;
    log("WARN: couldn't find the closing order in history — estimated exit price/reason from balance change instead.");
  }
  const exitTime = closingOrder ? Number(closingOrder.uTime ?? closingOrder.cTime) || Date.now() : Date.now();

  const priceMovePct = (exitPrice - opened.entryPrice) / opened.entryPrice;
  const pnlPct = priceMovePct * opened.leverage * 100;

  state.trades.push({
    pattern: opened.pattern,
    mssType: opened.mssType,
    leverage: opened.leverage,
    entryTime: opened.entryTime,
    entryPrice: opened.entryPrice,
    exitTime,
    exitPrice,
    exitReason,
    pnlPct,
    balanceBefore: state.currentBalance,
    balanceAfter: account.equity,
    orderId: opened.orderId,
    exitOrderId: closingOrder?.ordId,
  });

  state.currentBalance = account.equity;
  state.openPosition = null;
  log(`Position closed: ${exitReason} @ ${exitPrice} (pnl ${pnlPct.toFixed(2)}%)`);
}

// See live-trade.js's identical helper for the "full"/fixed rationale.
async function resolveMarginUsdt(config) {
  const account = await okx.getAccount(config);
  if (config.marginUsdt != null) return Math.min(config.marginUsdt, account.available);
  return Math.max(account.available * 0.95, 0);
}

async function maybeEnter(config, contract, state, closedCandles, signals) {
  if (state.openPosition) return;

  const latestCandle = closedCandles[closedCandles.length - 1];
  const latest = signals.find((s) => s.index === closedCandles.length - 1);
  if (!latest || !latestCandle) return; // no LONG signal on the freshest closed candle

  const watermark = resumeWatermark(state);
  if (watermark != null && latestCandle.time <= watermark) return; // already acted on this candle (or an earlier one)

  const price = latestCandle.close;
  const stopLoss = latest.sweepPrice;
  const risk = price - stopLoss;
  if (!(risk > 0)) {
    log("WARN: signal's sweep price is not below entry — skipping (shouldn't happen for a real LONG signal).");
    return;
  }
  const takeProfit = price + risk * R_MULTIPLE;

  const marginUsdt = await resolveMarginUsdt(config);
  if (marginUsdt <= 0) {
    log("WARN: no available balance to open a position with — skipping this signal.");
    return;
  }

  const btcAmount = (marginUsdt * LEVERAGE) / price;
  const size = okx.roundSize(btcAmount, contract);
  const impliedMargin = (Number(size) * contract.ctVal * price) / LEVERAGE;
  if (impliedMargin > marginUsdt * 1.05) {
    log(
      `WARN: skipping entry — exchange minimum order size needs ~$${impliedMargin.toFixed(2)} margin, ` +
        `only $${marginUsdt.toFixed(2)} available.`,
    );
    return;
  }

  log(
    `Signal: ICT ${latest.mssType} LONG price=${price} stop=${stopLoss} target=${takeProfit.toFixed(1)} ` +
      `margin=${marginUsdt.toFixed(2)} size=${size} — placing order...`,
  );

  // clOrdId must be plain alphanumeric per OKX's rules (no hyphens, unlike Bitget's
  // clientOid) — see okx-client.js's placeOrder for how attachAlgoClOrdId derives from it.
  const order = await okx.placeOrder(config, {
    side: "buy",
    size,
    tpTriggerPrice: takeProfit.toFixed(1),
    slTriggerPrice: stopLoss.toFixed(1),
    clientOrderId: `ict${latestCandle.time}`,
  });

  await new Promise((resolve) => setTimeout(resolve, 2000));
  const detail = await okx.getOrderDetail(config, { orderId: order.ordId }).catch(() => null);
  const entryPrice = (detail && Number(detail.avgPx || detail.px)) || price;
  const entryTime = (detail && Number(detail.cTime)) || Date.now();

  state.openPosition = {
    pattern: "ict-fvg",
    mssType: latest.mssType,
    leverage: LEVERAGE,
    size: marginUsdt,
    entryTime,
    entryPrice,
    takeProfit,
    stopLoss,
    orderId: order.ordId,
  };

  log(`Entered LONG @ ${entryPrice} (orderId ${order.ordId}), TP ${takeProfit.toFixed(1)} / SL ${stopLoss.toFixed(1)}`);

  await notify(
    [
      "ICT 실전 포지션 진입 (OKX)",
      `구조: ${latest.mssType} 유동성 스윕 → FVG 진입`,
      `진입가: $${entryPrice.toLocaleString()}`,
      `증거금: $${marginUsdt.toFixed(2)} · ${LEVERAGE}x`,
      `TP: $${takeProfit.toFixed(1)} · SL: $${stopLoss.toFixed(1)} (R=${R_MULTIPLE})`,
      `시간: ${new Date(entryTime).toLocaleString("ko-KR")}`,
    ].join("\n"),
  );
}

let contractConfigCache = null;

async function tick(config, state) {
  const before = JSON.stringify(state);

  if (state.startingBalance == null) {
    const account = await okx.getAccount(config);
    state.startingBalance = account.equity;
    state.currentBalance = account.equity;
  }

  const candles = await okx.getCandles(config, { bar: CANDLE_GRANULARITY, limit: CANDLE_LIMIT });
  const closedCandles = candles.slice(0, -1); // last candle is still forming
  const signals = detectICTSignals(closedCandles).filter((s) => s.direction === "LONG");

  await reconcilePosition(config, state);

  if (!contractConfigCache) {
    contractConfigCache = await okx.getContractConfig(config);
  }

  if (!state.openPosition) {
    await maybeEnter(config, contractConfigCache, state, closedCandles, signals);
  }

  persistState(state, JSON.stringify(state) !== before);
}

async function reconcileOnStartup(config, state) {
  const before = JSON.stringify(state);
  await reconcilePosition(config, state);
  if (JSON.stringify(state) !== before) persistState(state, true);
}

async function main() {
  const config = okx.loadConfig();
  const marginDesc = config.marginUsdt != null ? `${config.marginUsdt} USDT (fixed)` : "~95% of available balance each trade";
  log(`Starting ICT live-trade loop for ${config.symbol} on OKX (LIVE — real funds). Margin per trade: ${marginDesc} @ ${LEVERAGE}x.`);

  const setup = await okx.ensureAccountSetup(config, { leverage: LEVERAGE });
  log("Account setup (non-fatal if a position is already open):", setup);

  const state = loadState();
  await reconcileOnStartup(config, state);

  let tickInFlight = false;
  async function runTick() {
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      await tick(config, state);
    } catch (error) {
      log("ERROR during tick (loop continues):", error.message);
    } finally {
      tickInFlight = false;
    }
  }

  await runTick();
  setInterval(runTick, POLL_INTERVAL_MS);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
