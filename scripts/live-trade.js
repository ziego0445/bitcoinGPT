// Runs continuously on the user's own always-on PC (NOT GitHub Actions — see the note
// below). Places real Bitget orders. Same signal/strategy logic as scripts/paper-trade.js
// (10x leverage, single LONG-only position, score>=85, +8%/-8% account-equity TP/SL), but:
//   - position size is a FIXED margin amount (BITGET_MARGIN_USDT) per trade, not
//     paper-trade.js's full-balance compounding — real capital, not a simulation.
//   - candles come from Bitget itself, not Binance, so the signal source matches the
//     venue we actually trade on.
//   - exits are detected, not decided, by this script: TP/SL are placed as exchange-native
//     trigger prices on the entry order (presetStopSurplusPrice/presetStopLossPrice), so
//     Bitget's engine guarantees the exit even if this process is offline when it happens.
//     Each tick just polls the real position/order state and reconciles the local file —
//     the exchange is always the source of truth, never the local JSON.
//
// This script is intentionally NOT wired into .github/workflows/*.yml. It needs a real
// API key with trade permission, and CI runner IPs are unpredictable (can't be
// allow-listed on the Bitget key) — this must only ever run from a machine you control.
// Run it locally: `pnpm live-trade` (see .env.example for required vars).

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { detectSignals } = require("./lib/signals");
const bitget = require("./lib/bitget-client");

const LEVERAGE = 10;
const TAKE_PROFIT_PCT = 0.08; // +8% on account equity (= +0.8% price move at 10x)
const STOP_LOSS_PCT = 0.08;
const ALERT_MIN_SCORE = 85;
const CANDLE_GRANULARITY = "5m";
const CANDLE_LIMIT = 200;
const POLL_INTERVAL_MS = 30_000;
const REPO_ROOT = path.join(__dirname, "..");
const STATE_PATH = path.join(REPO_ROOT, "data", "live-trades.json");
const GIT_OPTS = { cwd: REPO_ROOT, stdio: "pipe" };

function log(...args) {
  console.log(`[${new Date().toISOString()}]`, ...args);
}

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    const state = JSON.parse(raw);
    delete state.needsPush; // dropped field — see note on pushRetryNeeded below
    return state;
  } catch {
    return {
      mode: "live",
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

// Whether the last git push attempt failed and needs a retry. Deliberately NOT part of
// the persisted `state` object: writing that flag into data/live-trades.json used to
// leave the file locally modified-but-uncommitted after a failed push (the flag flip
// itself was never committed), which then made every subsequent `git pull --rebase`
// fail with "you have unstaged changes" — a permanent lockout. Keeping it in memory only
// means a failed push leaves the working tree exactly as clean as the last real commit.
let pushRetryNeeded = false;

// Only touches git when the state actually changed (or a previous push failed and needs
// a retry) — mirrors paper-trade.js's "don't spam commits on idle ticks" principle.
function persistState(state, changed) {
  if (changed) saveState(state);
  if (!changed && !pushRetryNeeded) return;

  try {
    if (changed) {
      execFileSync("git", ["add", "data/live-trades.json"], GIT_OPTS);
      execFileSync("git", ["commit", "-m", "Update live-trade state [skip ci]"], GIT_OPTS);
    }
    execFileSync("git", ["pull", "--rebase", "origin", "main"], GIT_OPTS);
    execFileSync("git", ["push", "origin", "HEAD:main"], GIT_OPTS);
    log(pushRetryNeeded ? "Retried a previously failed push — succeeded." : "Committed and pushed live-trade state.");
    pushRetryNeeded = false;
  } catch (error) {
    pushRetryNeeded = true;
    log("WARN: git commit/push failed, will retry next tick. Data is safe on disk either way.", error.message);
  }
}

function resumeWatermark(state) {
  if (state.openPosition) return state.openPosition.entryTime;
  if (state.trades.length) return state.trades[state.trades.length - 1].exitTime;
  return state.startedAt ?? null;
}

// Called every tick before looking for a new entry. If the exchange no longer has a
// position that the local state thinks is open, the attached TP/SL trigger fired — find
// the closing fill in order history and record it. Exchange state always wins.
//
// Field names (priceAvg / cTime / uTime / side / reduceOnly) were confirmed against a
// real filled order — see the manual round-trip test run during setup. One thing that
// test *did* reveal: in one-way mode, `tradeSide` on an order is "buy_single"/
// "sell_single", not "open"/"close" — so the `tradeSide === "close"` check below never
// actually matches on this account. Left in as a harmless no-op in case Bitget ever
// returns that value for a different order type; `reduceOnly === "YES"` and
// `side === "sell"` are the fallbacks that actually do the work here.
async function reconcilePosition(config, state) {
  const position = await bitget.getSinglePosition(config);
  if (position) return; // still open, or nothing was open — nothing to reconcile
  if (!state.openPosition) return; // idle tick, no position on either side

  const opened = state.openPosition;
  // A small negative buffer covers clock skew between this process and Bitget's server —
  // the entry order itself should always be inside [entryTime - buffer, now].
  const history = await bitget.getHistoryOrders(config, { startTime: opened.entryTime - 60_000 }).catch(() => []);
  const closingOrder = history.find(
    (order) => order.tradeSide === "close" || order.reduceOnly === "YES" || order.side === "sell",
  );

  const account = await bitget.getAccount(config);
  let exitPrice;
  let exitReason;

  if (closingOrder) {
    exitPrice = Number(closingOrder.priceAvg ?? closingOrder.price);
    exitReason =
      Math.abs(exitPrice - opened.takeProfit) <= Math.abs(exitPrice - opened.stopLoss) ? "take-profit" : "stop-loss";
  } else {
    // Couldn't find the closing fill in order history (the exact response field names
    // are a best guess — see the NOTE above, verify on first real close and adjust if
    // needed). Fall back to inferring from the balance change, which is at least
    // directionally reliable even when we can't pin down the exact fill price.
    const balanceWentUp = state.currentBalance != null ? account.equity > state.currentBalance : true;
    exitReason = balanceWentUp ? "take-profit" : "stop-loss";
    exitPrice = exitReason === "take-profit" ? opened.takeProfit : opened.stopLoss;
    log("WARN: couldn't find the closing order in history — estimated exit price/reason from balance change instead.");
  }
  const exitTime = closingOrder ? Number(closingOrder.uTime ?? closingOrder.cTime) || Date.now() : Date.now();

  const priceMovePct = (exitPrice - opened.entryPrice) / opened.entryPrice;
  const pnlPct = priceMovePct * opened.leverage * 100;

  state.trades.push({
    pattern: opened.pattern,
    score: opened.score,
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
    exitOrderId: closingOrder?.orderId,
  });

  state.currentBalance = account.equity;
  state.openPosition = null;
  log(`Position closed: ${exitReason} @ ${exitPrice} (pnl ${pnlPct.toFixed(2)}%)`);
}

// BITGET_MARGIN_USDT unset/"full" (config.marginUsdt === null) means "use whatever the
// account currently has" — appropriate for a small account where a separate fixed
// allocation doesn't make sense. A 5% haircut avoids order rejection from fees/rounding
// eating into the last few cents of available margin. A configured fixed amount is still
// capped at the real available balance so a stale/optimistic env value can't over-commit.
async function resolveMarginUsdt(config) {
  const account = await bitget.getAccount(config);
  if (config.marginUsdt != null) return Math.min(config.marginUsdt, account.available);
  return Math.max(account.available * 0.95, 0);
}

async function maybeEnter(config, contract, state, closedCandles, events) {
  if (state.openPosition) return;

  const latest = events.at(-1);
  const latestCandle = closedCandles[closedCandles.length - 1];
  if (!latest || !latestCandle || latest.index !== closedCandles.length - 1) return; // no signal on the freshest closed candle
  if (latest.direction !== "LONG" || latest.score < ALERT_MIN_SCORE) return;

  const watermark = resumeWatermark(state);
  if (watermark != null && latestCandle.time <= watermark) return; // already acted on this candle (or an earlier one)

  const marginUsdt = await resolveMarginUsdt(config);
  if (marginUsdt <= 0) {
    log("WARN: no available balance to open a position with — skipping this signal.");
    return;
  }

  const price = latestCandle.close;
  const takeProfit = price * (1 + TAKE_PROFIT_PCT / LEVERAGE);
  const stopLoss = price * (1 - STOP_LOSS_PCT / LEVERAGE);
  const size = bitget.roundSize((marginUsdt * LEVERAGE) / price, contract);

  log(`Signal: ${latest.pattern} score=${latest.score} price=${price} margin=${marginUsdt.toFixed(2)} size=${size} — placing order...`);

  const order = await bitget.placeOrder(config, {
    side: "buy",
    size,
    presetStopSurplusPrice: takeProfit.toFixed(1),
    presetStopLossPrice: stopLoss.toFixed(1),
    clientOid: `live-${latestCandle.time}`,
  });

  // Give the market order a moment to fill before reading back the real entry price.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const detail = await bitget.getOrderDetail(config, { orderId: order.orderId }).catch(() => null);
  const entryPrice = (detail && Number(detail.priceAvg || detail.price)) || price;
  const entryTime = (detail && Number(detail.cTime)) || Date.now();

  state.openPosition = {
    pattern: latest.pattern,
    score: latest.score,
    leverage: LEVERAGE,
    size: marginUsdt,
    entryTime,
    entryPrice,
    takeProfit,
    stopLoss,
    orderId: order.orderId,
  };

  log(`Entered LONG @ ${entryPrice} (orderId ${order.orderId}), TP ${takeProfit.toFixed(1)} / SL ${stopLoss.toFixed(1)}`);
}

let contractConfigCache = null;

async function tick(config, state) {
  const before = JSON.stringify(state);

  if (state.startingBalance == null) {
    const account = await bitget.getAccount(config);
    state.startingBalance = account.equity;
    state.currentBalance = account.equity;
  }

  const candles = await bitget.getCandles(config, { granularity: CANDLE_GRANULARITY, limit: CANDLE_LIMIT });
  const closedCandles = candles.slice(0, -1); // last candle is still forming
  const events = detectSignals(closedCandles);

  await reconcilePosition(config, state);

  if (!contractConfigCache) {
    contractConfigCache = await bitget.getContractConfig(config);
  }

  if (!state.openPosition) {
    await maybeEnter(config, contractConfigCache, state, closedCandles, events);
  }

  persistState(state, JSON.stringify(state) !== before);
}

// Runs once at boot, before the interval starts, so a restart mid-trade never causes a
// duplicate entry — the exchange's real position always overrides local assumptions.
async function reconcileOnStartup(config, state) {
  const position = await bitget.getSinglePosition(config);

  if (position && !state.openPosition) {
    log("Exchange reports an open position local state didn't know about — adopting it (entry time is a best-effort 'now').");
    // TP/SL are estimated from the entry price using this bot's own fixed parameters —
    // we don't know Bitget's actual attached trigger prices in this recovery path, but
    // this account only ever gets positions from this bot, so the estimate should match.
    state.openPosition = {
      pattern: "recovered",
      score: 0,
      leverage: position.leverage || LEVERAGE,
      size: position.marginSize,
      entryTime: Date.now(),
      entryPrice: position.openPriceAvg,
      takeProfit: position.openPriceAvg * (1 + TAKE_PROFIT_PCT / LEVERAGE),
      stopLoss: position.openPriceAvg * (1 - STOP_LOSS_PCT / LEVERAGE),
      orderId: null,
    };
    saveState(state);
  } else if (!position && state.openPosition) {
    log("Local state had an open position, but the exchange doesn't — it must have closed while this script wasn't running.");
    await reconcilePosition(config, state);
    saveState(state);
  }
}

async function main() {
  const config = bitget.loadConfig();
  const marginDesc = config.marginUsdt != null ? `${config.marginUsdt} USDT (fixed)` : "~95% of available balance each trade";
  log(
    `Starting live-trade loop for ${config.symbol} (${config.demo ? "DEMO" : "LIVE — real funds"}). ` +
      `Margin per trade: ${marginDesc} @ ${LEVERAGE}x.`,
  );

  const setup = await bitget.ensureAccountSetup(config, { leverage: LEVERAGE });
  log("Account setup (non-fatal if a position is already open):", setup);

  const state = loadState();
  await reconcileOnStartup(config, state);

  let tickInFlight = false;
  async function runTick() {
    if (tickInFlight) return; // previous tick's HTTP calls are still in flight — skip, don't overlap
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
