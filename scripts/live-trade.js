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
const { detectSignals, signalTitle, signalReasons } = require("./lib/signals");
const bitget = require("./lib/bitget-client");
const { sendTelegram } = require("./lib/telegram");
const { renderCandleSnapshot } = require("./lib/chart-snapshot");
const { loadReports, saveReports, openReport, closeReport } = require("./lib/trade-reports");

// Telegram notification is best-effort — a Telegram outage must never block or crash the
// trading loop, so every call site awaits this wrapper instead of sendTelegram() directly.
async function notify(text) {
  try {
    await sendTelegram(text);
  } catch (error) {
    log("WARN: Telegram notification failed (trading continues):", error.message);
  }
}

const LEVERAGE = 10;
const TAKE_PROFIT_PCT = 0.08; // +8% on account equity (= +0.8% price move at 10x)
const STOP_LOSS_PCT = 0.08;
// A bot-side breakeven-close (arm once unrealized P&L crossed +4% of margin, then close
// immediately if price fell back to entry) was tried and rolled back — a 150-day/15m
// backtest across every arm threshold from +2% to +7% showed it *always* underperforms not
// having it at all (best case +7%: 79.98 vs 84.27 final equity on the same signal set).
// This strategy's winners often dip after entry and take hours to recover to the full +8%
// TP; cutting them off at breakeven sacrifices more of those eventual wins than it saves
// from full losses. Do not re-add without new backtest evidence it helps.
const ALERT_MIN_SCORE = 85;
// Structural stop-loss (SL just under the pattern's own reference level, e.g.
// detectSignals()'s structureLevel) was tried and rolled back. It backtested well in
// isolation, but after findRecentWickPivot() (signals.js) started letting a just-formed
// capitulation wick act as that reference immediately, the reference level is often very
// close to entry — the clamp's floor then made stops tight enough that a 150-day/15m
// backtest showed a flat fixed ±STOP_LOSS_PCT beating every clamp width tried (222.01
// final equity vs the best structural variant's 209.12, both halves of an in/out split).
// structureLevel is still computed and carried on signals for potential future use —
// only the stop-loss formula itself reverted.
// The PDF strategy this bot follows is written by/for a 15m-primary trader (explicitly
// warns against fast 5m entries for at least one pattern) — matches the dashboard's own
// default timeframe. detectSignals()'s conditions are relative-to-recent-average, not
// absolute, so the same logic carries over to a coarser candle size without retuning.
const CANDLE_GRANULARITY = "15m";
const CANDLE_LIMIT = 200;
const POLL_INTERVAL_MS = 30_000;
const CHART_SNAPSHOT_CANDLES = 60;
const REPO_ROOT = path.join(__dirname, "..");
const STATE_PATH = path.join(REPO_ROOT, "data", "live-trades.json");
const REPORTS_PATH = path.join(REPO_ROOT, "data", "trade-reports-bitget.json");
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

// Only touches git when something actually changed (or a previous push failed and needs
// a retry) — mirrors paper-trade.js's "don't spam commits on idle ticks" principle.
// `files`: [{ path: "data/live-trades.json", changed, save, purgeUrl }, ...] — a single
// entry per tracked file. One commit covers whichever files changed this tick (state and
// a trade report can both change in the same tick, at the moment of entry/exit) instead
// of committing twice.
function persistFiles(files) {
  const changedFiles = files.filter((f) => f.changed);
  for (const file of changedFiles) file.save();
  if (!changedFiles.length && !pushRetryNeeded) return;

  try {
    if (changedFiles.length) {
      execFileSync("git", ["add", ...changedFiles.map((f) => f.path)], GIT_OPTS);
      execFileSync("git", ["commit", "-m", "Update live-trade state [skip ci]"], GIT_OPTS);
    }
    execFileSync("git", ["pull", "--rebase", "origin", "main"], GIT_OPTS);
    execFileSync("git", ["push", "origin", "HEAD:main"], GIT_OPTS);
    log(pushRetryNeeded ? "Retried a previously failed push — succeeded." : "Committed and pushed live-trade state.");
    pushRetryNeeded = false;
    // Purge every tracked file's CDN cache on any successful push, not just the ones that
    // changed this specific tick — a retried push can carry an earlier tick's change that
    // never got purged the first time around. Fire-and-forget, same as before.
    for (const file of files) purgeJsDelivrCache(file.purgeUrl);
  } catch (error) {
    pushRetryNeeded = true;
    log("WARN: git commit/push failed, will retry next tick. Data is safe on disk either way.", error.message);
  }
}

// The dashboard reads these files through jsDelivr's GitHub CDN mirror, not
// raw.githubusercontent.com directly — GitHub's raw-content endpoint anti-scraping limits
// were 429-ing real site visitors. jsDelivr caches its GitHub mirror rather than fetching
// on every request, so without this the dashboard would show stale state until jsDelivr's
// own cache window elapsed. Best-effort like notify(): a purge failure must never block or
// crash the trading loop — the next successful purge (or jsDelivr's normal cache expiry)
// catches it up.
const STATE_PURGE_URL = "https://purge.jsdelivr.net/gh/ziego0445/bitcoinGPT@main/data/live-trades.json";
const REPORTS_PURGE_URL = "https://purge.jsdelivr.net/gh/ziego0445/bitcoinGPT@main/data/trade-reports-bitget.json";

async function purgeJsDelivrCache(purgeUrl) {
  try {
    const response = await fetch(purgeUrl);
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

// Adopts an exchange position the local state doesn't know about. This isn't just a
// startup thing: if placeOrder() succeeds server-side but the response is lost (a network
// drop between sending the request and reading the reply), state.openPosition never gets
// set locally even though a real order went through — the next tick would otherwise see
// "no position" and could open a second one on top of it. Called every tick, not once.
function adoptUntrackedPosition(state, position) {
  log("Exchange reports an open position local state didn't know about — adopting it (entry time is a best-effort 'now').");
  // TP/SL are estimated from the entry price using this bot's own fixed parameters — we
  // don't know Bitget's actual attached trigger prices in this recovery path, but this
  // account only ever gets positions from this bot, so the estimate should match.
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
}

// Called every tick before looking for a new entry. Reconciles both directions against
// the real exchange position — adopts one we didn't know about, or (if the exchange no
// longer has a position that the local state thinks is open) records the closing fill.
// Exchange state always wins.
//
// Field names (priceAvg / cTime / uTime / side / reduceOnly) were confirmed against a
// real filled order — see the manual round-trip test run during setup. One thing that
// test *did* reveal: in one-way mode, `tradeSide` on an order is "buy_single"/
// "sell_single", not "open"/"close" — so the `tradeSide === "close"` check below never
// actually matches on this account. Left in as a harmless no-op in case Bitget ever
// returns that value for a different order type; `reduceOnly === "YES"` and
// `side === "sell"` are the fallbacks that actually do the work here.
async function reconcilePosition(config, state, reports) {
  const position = await bitget.getSinglePosition(config);

  if (position && !state.openPosition) {
    adoptUntrackedPosition(state, position);
    return;
  }
  if (position) return; // still open and already tracked — nothing to reconcile
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
    // A real TP/SL trigger fill lands within a hair of the exact preset price. Only
    // trust "closer to TP than SL" as a real take-profit when it's actually close to TP
    // in absolute terms — otherwise (e.g. a manual close somewhere near entry) that
    // proximity comparison can mislabel a losing trade as "take-profit" just because it
    // happened to be numerically nearer the target than the stop. Fall back to the
    // sign of the actual price move, which can never contradict the P&L shown next to it.
    const nearTakeProfit = Math.abs(exitPrice - opened.takeProfit) / opened.takeProfit < 0.001;
    const nearStopLoss = Math.abs(exitPrice - opened.stopLoss) / opened.stopLoss < 0.001;
    if (nearTakeProfit && !nearStopLoss) exitReason = "take-profit";
    else if (nearStopLoss && !nearTakeProfit) exitReason = "stop-loss";
    else exitReason = exitPrice >= opened.entryPrice ? "take-profit" : "stop-loss";
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

  // No matching open report for a "recovered" position (see adoptUntrackedPosition — it
  // never had a report opened for it in the first place) — closeReport() no-ops safely.
  closeReport(reports, opened.entryTime, { exitTime, exitPrice, exitReason, pnlPct });

  await notify(
    [
      exitReason === "take-profit" ? "실전 포지션 익절 종료" : "실전 포지션 손절 종료",
      `패턴: ${signalTitle(opened.pattern)}`,
      `진입가: $${opened.entryPrice.toLocaleString()} → 청산가: $${exitPrice.toLocaleString()}`,
      `손익: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`,
      `잔고: $${account.equity.toFixed(2)}`,
      `시간: ${new Date(exitTime).toLocaleString("ko-KR")}`,
    ].join("\n"),
  );
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

// Composes the "why did we enter" writeup for the trade-report journal, straight from
// what detectSignals() already computed for this signal — no new reasoning invented here,
// just the pattern's own title/detail/bullet reasons (signalReasons()) plus the reference
// level double-bottom/key-candle stake their thesis on (structureLevel), if any.
function buildReasonText(signal) {
  const lines = [`패턴: ${signalTitle(signal.pattern)} (score ${Math.round(signal.score)})`, signal.detail];
  const reasons = signalReasons(signal.pattern);
  if (reasons.length) lines.push(...reasons.map((reason) => `- ${reason}`));
  if (signal.structureLevel != null) lines.push(`기준 레벨(구조적 참조가): $${signal.structureLevel.toLocaleString()}`);
  return lines.join("\n");
}

async function maybeEnter(config, contract, state, closedCandles, events, reports) {
  if (state.openPosition) return;

  const latest = events.at(-1);
  const latestCandle = closedCandles[closedCandles.length - 1];
  if (!latest || !latestCandle || latest.index !== closedCandles.length - 1) return; // no signal on the freshest closed candle
  if (latest.direction !== "LONG" || latest.score < ALERT_MIN_SCORE) return;
  // key-candle disabled: a 150-day/15m backtest showed it net-losing at every score
  // threshold tried (78-94), even with the structural stop-loss above — double-bottom
  // alone was roughly breakeven over the same window. Still detected/shown on the
  // dashboard's signal timeline for visibility, just never traded live. Revisit if the
  // pattern gets reworked (e.g. an RSI or trend filter, like double-bottom already has).
  if (latest.pattern === "key-candle") return;

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

  // roundSize() always rounds UP to the contract's minimum, even when the resolved
  // margin implies a much smaller size — on a small/depleted balance this would silently
  // ask for more margin than we actually have. Bitget would reject it anyway, but doing
  // that on every 30s tick until the candle rolls over just spams rejected live orders.
  // Skip cleanly instead and wait for the next signal.
  const impliedMargin = (Number(size) * price) / LEVERAGE;
  if (impliedMargin > marginUsdt * 1.05) {
    log(
      `WARN: skipping entry — exchange minimum order size needs ~$${impliedMargin.toFixed(2)} margin, ` +
        `only $${marginUsdt.toFixed(2)} available.`,
    );
    return;
  }

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

  const snapshotCandles = closedCandles.slice(-CHART_SNAPSHOT_CANDLES);
  const chartSvg = renderCandleSnapshot({
    candles: snapshotCandles,
    title: `BTCUSDT 15m · ${new Date(entryTime).toLocaleString("ko-KR")}`,
    markers: [{ index: snapshotCandles.length - 1, color: "#f472b6", label: "B" }],
    lines: [
      { price: takeProfit, color: "#4ade80", label: `TP ${takeProfit.toFixed(1)}` },
      { price: stopLoss, color: "#f43f5e", label: `SL ${stopLoss.toFixed(1)}` },
      ...(latest.structureLevel != null ? [{ price: latest.structureLevel, color: "#22d3ee", label: "기준가" }] : []),
    ],
  });

  openReport(reports, {
    id: `bitget-${entryTime}`,
    bot: "bitget",
    pattern: latest.pattern,
    score: latest.score,
    reasonSummary: signalTitle(latest.pattern),
    reasonDetail: buildReasonText(latest),
    entryTime,
    entryPrice,
    takeProfit,
    stopLoss,
    chartSvg,
  });

  await notify(
    [
      "실전 포지션 진입",
      `패턴: ${signalTitle(latest.pattern)} (${latest.score.toFixed(0)}점)`,
      `진입가: $${entryPrice.toLocaleString()}`,
      `증거금: $${marginUsdt.toFixed(2)} · ${LEVERAGE}x`,
      `TP: $${takeProfit.toFixed(1)} · SL: $${stopLoss.toFixed(1)}`,
      `시간: ${new Date(entryTime).toLocaleString("ko-KR")}`,
    ].join("\n"),
  );
}

let contractConfigCache = null;

async function tick(config, state, reports) {
  const stateBefore = JSON.stringify(state);
  const reportsBefore = JSON.stringify(reports);

  if (state.startingBalance == null) {
    const account = await bitget.getAccount(config);
    state.startingBalance = account.equity;
    state.currentBalance = account.equity;
  }

  const candles = await bitget.getCandles(config, { granularity: CANDLE_GRANULARITY, limit: CANDLE_LIMIT });
  const closedCandles = candles.slice(0, -1); // last candle is still forming
  const events = detectSignals(closedCandles);

  await reconcilePosition(config, state, reports);

  if (!contractConfigCache) {
    contractConfigCache = await bitget.getContractConfig(config);
  }

  if (!state.openPosition) {
    await maybeEnter(config, contractConfigCache, state, closedCandles, events, reports);
  }

  persistFiles([
    { path: "data/live-trades.json", changed: JSON.stringify(state) !== stateBefore, save: () => saveState(state), purgeUrl: STATE_PURGE_URL },
    {
      path: "data/trade-reports-bitget.json",
      changed: JSON.stringify(reports) !== reportsBefore,
      save: () => saveReports(REPORTS_PATH, reports),
      purgeUrl: REPORTS_PURGE_URL,
    },
  ]);
}

// Runs once at boot, before the interval starts, so a restart mid-trade never causes a
// duplicate entry — the exchange's real position always overrides local assumptions.
// Just the regular per-tick reconciliation (see reconcilePosition above), forced to
// persist immediately rather than waiting for tick()'s own before/after diff.
async function reconcileOnStartup(config, state, reports) {
  const stateBefore = JSON.stringify(state);
  const reportsBefore = JSON.stringify(reports);
  await reconcilePosition(config, state, reports);
  persistFiles([
    { path: "data/live-trades.json", changed: JSON.stringify(state) !== stateBefore, save: () => saveState(state), purgeUrl: STATE_PURGE_URL },
    {
      path: "data/trade-reports-bitget.json",
      changed: JSON.stringify(reports) !== reportsBefore,
      save: () => saveReports(REPORTS_PATH, reports),
      purgeUrl: REPORTS_PURGE_URL,
    },
  ]);
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
  const reports = loadReports(REPORTS_PATH);
  await reconcileOnStartup(config, state, reports);

  let tickInFlight = false;
  async function runTick() {
    if (tickInFlight) return; // previous tick's HTTP calls are still in flight — skip, don't overlap
    tickInFlight = true;
    try {
      await tick(config, state, reports);
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
