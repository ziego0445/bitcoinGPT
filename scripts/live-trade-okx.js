// Runs continuously on the user's own always-on PC (NOT GitHub Actions — same reasoning
// as scripts/live-trade.js). Trades the same panic-climax long as the Bitget bot
// (scripts/lib/climax-signals.js, PDF chapter 1) on the OKX account, which used to run the
// ICT bot (scripts/live-trade-ict.js — retired: no ICT variant beat fees on 2 years of
// OKX or Bitget data).
//   - SIGNALS come from BITGET's 15m candles, not OKX's own. Over the last 2 years the same
//     rule on OKX's volume picked worse candles (+0.11% / +0.14% per trade, 1st / 2nd year)
//     than Bitget's signals traded at OKX prices (+0.39% / +0.26%) — the gap is in OKX's
//     volume feed, not its prices.
//   - ENTRY, SIZE, EXIT, STOP match live-trade.js: market buy at the signal close, 1/3, 2/3
//     or all of the max position by panic depth, market sell at the close of the 4th
//     candle after the signal, exchange-side stop 3% under the signal close.
//   - Both bots therefore usually trade the same candle — this doubles the bet, it does
//     not diversify it.
//
// The exchange is always the source of truth: each tick reads the real OKX position and
// reconciles the local JSON. OKX cancels the attached stop by itself once the position is
// closed (checked against this account's algo-order history).
//
// The account is in hedge mode (posMode "long_short_mode"), so every order names posSide.
// Run it locally: run-live-trade-okx.bat (needs both the OKX_* and BITGET_* vars in .env —
// Bitget's are only used to read candles).

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { signalTitle, signalReasons } = require("./lib/signals");
const { detectPanicClimax, sizeTier } = require("./lib/climax-signals");
const okx = require("./lib/okx-client");
const bitget = require("./lib/bitget-client");
const { sendTelegram } = require("./lib/telegram");
const { renderCandleSnapshot } = require("./lib/chart-snapshot");
const { loadReports, saveReports, openReport, closeReport } = require("./lib/trade-reports");

async function notify(text) {
  try {
    await sendTelegram(text);
  } catch (error) {
    log("WARN: Telegram notification failed (trading continues):", error.message);
  }
}

const LEVERAGE = 10;
// Same numbers as live-trade.js — see its note before changing them.
const CLIMAX_STOP_PCT = 0.03;
const CLIMAX_HOLD_CANDLES = 4;
const CANDLE_MS = 15 * 60_000;
const CANDLE_GRANULARITY = "15m";
const CANDLE_LIMIT = 200;
const POLL_INTERVAL_MS = 30_000;
const CHART_SNAPSHOT_CANDLES = 60;
const REPO_ROOT = path.join(__dirname, "..");
// Own files: the ICT bot's live-trades-ict.json keeps its 16 real trades as history.
const STATE_PATH = path.join(REPO_ROOT, "data", "live-trades-okx.json");
const REPORTS_PATH = path.join(REPO_ROOT, "data", "trade-reports-okx.json");
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
      strategy: "panic-climax",
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

// See live-trade.js's persistFiles() for the full rationale.
function persistFiles(files) {
  const changedFiles = files.filter((f) => f.changed);
  for (const file of changedFiles) file.save();
  if (!changedFiles.length && !pushRetryNeeded) return;

  try {
    if (changedFiles.length) {
      execFileSync("git", ["add", ...changedFiles.map((f) => f.path)], GIT_OPTS);
      execFileSync("git", ["commit", "-m", "Update OKX live-trade state [skip ci]"], GIT_OPTS);
    }
    execFileSync("git", ["pull", "--rebase", "origin", "main"], GIT_OPTS);
    execFileSync("git", ["push", "origin", "HEAD:main"], GIT_OPTS);
    log(pushRetryNeeded ? "Retried a previously failed push — succeeded." : "Committed and pushed OKX live-trade state.");
    pushRetryNeeded = false;
    for (const file of files) purgeJsDelivrCache(file.purgeUrl);
  } catch (error) {
    pushRetryNeeded = true;
    log("WARN: git commit/push failed, will retry next tick. Data is safe on disk either way.", error.message);
  }
}

const STATE_PURGE_URL = "https://purge.jsdelivr.net/gh/ziego0445/bitcoinGPT@main/data/live-trades-okx.json";
const REPORTS_PURGE_URL = "https://purge.jsdelivr.net/gh/ziego0445/bitcoinGPT@main/data/trade-reports-okx.json";

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

const isReduceOnly = (o) => o.reduceOnly === true || o.reduceOnly === "true";

// A position local state doesn't know about (a lost placeOrder() response, or something
// opened by hand) — tracked so no second entry stacks on it, but never closed by this bot:
// with no exitAt there is nothing to time out, and whatever stop it has stays on OKX.
function adoptUntrackedPosition(state, position) {
  log("Exchange reports an open position local state didn't know about — adopting it (entry time is a best-effort 'now').");
  state.openPosition = {
    pattern: "recovered",
    direction: position.posSide === "short" ? "SHORT" : "LONG",
    leverage: position.leverage || LEVERAGE,
    size: position.margin,
    entryTime: Date.now(),
    entryPrice: position.avgPrice,
    takeProfit: null,
    stopLoss: null,
    orderId: null,
  };
}

// Market-sells the whole position once exitAt passes. Retried every tick while the
// position is still there; reduce-only means a duplicate can never open a short.
async function closeOnTimeExit(config, opened, position) {
  if (opened.exitAt == null || Date.now() < opened.exitAt) return;
  log(`Time exit due (${new Date(opened.exitAt).toISOString()}) — selling ${position.contracts} contracts at market.`);
  try {
    await okx.placeOrder(config, {
      side: position.posSide === "short" ? "buy" : "sell",
      posSide: position.posSide,
      size: String(position.contracts),
      reduceOnly: true,
      clientOrderId: `pc${opened.signalCandleTime}x${Date.now() % 1e6}`,
    });
    opened.timeExitSent = true;
  } catch (error) {
    log("WARN: time-exit market sell failed, retrying next tick:", error.message);
  }
}

async function reconcilePosition(config, state, reports) {
  const position = await okx.getPosition(config);

  if (position && !state.openPosition) {
    adoptUntrackedPosition(state, position);
    return;
  }
  if (position) {
    await closeOnTimeExit(config, state.openPosition, position);
    return;
  }
  // Flat: nothing resting on the book belongs to anything any more.
  await okx.cancelAllOrders(config).catch((error) => log("WARN: could not clear leftover orders:", error.message));
  if (!state.openPosition) return;

  const opened = state.openPosition;
  const wasLong = opened.direction !== "SHORT";
  const history = await okx.getHistoryOrders(config, { startTime: opened.entryTime - 60_000 }).catch(() => []);

  // Oldest-first, stopping once the closed size covers what was entered — see
  // live-trade.js for the real mix-up with unrelated later fills that this guards against.
  const closingCandidates = history
    .filter((o) => Number(o.accFillSz ?? 0) > 0 && o.side === (wasLong ? "sell" : "buy") && isReduceOnly(o))
    .sort((a, b) => Number(a.uTime ?? a.cTime) - Number(b.uTime ?? b.cTime));
  const expectedSize = opened.positionSize != null ? Number(opened.positionSize) : null;
  const closingOrders = [];
  let closedSize = 0;
  for (const order of closingCandidates) {
    if (expectedSize != null && closedSize >= expectedSize - 1e-9) break;
    closingOrders.push(order);
    closedSize += Number(order.accFillSz);
  }
  if (expectedSize == null && closingOrders.length > 1) closingOrders.length = 1;
  const closingOrder = closingOrders.at(-1);

  // The entry's own fill, not the position average (which anything else trading the
  // account would move).
  const ownEntry = history.find(
    (o) => o.clOrdId === `pc${opened.signalCandleTime}` && !isReduceOnly(o) && Number(o.accFillSz ?? 0) > 0,
  );
  if (ownEntry && Number(ownEntry.avgPx) > 0) opened.entryPrice = Number(ownEntry.avgPx);

  const account = await okx.getAccount(config);
  let exitPrice;
  let exitReason;
  if (closingOrders.length) {
    let weighted = 0;
    for (const o of closingOrders) weighted += Number(o.accFillSz) * Number(o.avgPx);
    exitPrice = weighted / closedSize;
    const nearStopLoss = opened.stopLoss != null && Math.abs(exitPrice - opened.stopLoss) / opened.stopLoss < 0.001;
    const wentUp = wasLong ? exitPrice >= opened.entryPrice : exitPrice <= opened.entryPrice;
    exitReason = nearStopLoss || !wentUp ? "stop-loss" : "take-profit";
  } else {
    const balanceWentUp = state.currentBalance != null ? account.equity > state.currentBalance : true;
    exitReason = balanceWentUp ? "take-profit" : "stop-loss";
    exitPrice = (exitReason === "stop-loss" ? opened.stopLoss : null) ?? opened.entryPrice;
    log("WARN: couldn't find the closing order in history — estimated exit price/reason from balance change instead.");
  }
  const exitTime = closingOrder ? Number(closingOrder.uTime ?? closingOrder.cTime) || Date.now() : Date.now();
  const priceMovePct = ((wasLong ? 1 : -1) * (exitPrice - opened.entryPrice)) / opened.entryPrice;
  const pnlPct = priceMovePct * opened.leverage * 100;

  state.trades.push({
    pattern: opened.pattern,
    direction: opened.direction ?? "LONG",
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
    ...(opened.timeExitSent ? { exitKind: "time-exit" } : {}),
  });
  state.currentBalance = account.equity;
  state.openPosition = null;
  log(`Position closed: ${exitReason} @ ${exitPrice} (pnl ${pnlPct.toFixed(2)}%)`);

  closeReport(reports, opened.entryTime, { exitTime, exitPrice, exitReason, pnlPct, entryPrice: opened.entryPrice });

  await notify(
    [
      opened.timeExitSent
        ? `OKX 포지션 시간 청산 (${exitReason === "take-profit" ? "수익" : "손실"})`
        : exitReason === "take-profit"
          ? "OKX 포지션 익절 종료"
          : "OKX 포지션 손절 종료",
      `패턴: ${signalTitle(opened.pattern)}`,
      `진입가: $${opened.entryPrice.toLocaleString()} → 청산가: $${exitPrice.toLocaleString()}`,
      `손익: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`,
      `잔고: $${account.equity.toFixed(2)}`,
      `시간: ${new Date(exitTime).toLocaleString("ko-KR")}`,
    ].join("\n"),
  );
}

// The MAXIMUM margin a trade may commit (maybeEnter() takes tier/3 of it): ~95% of the
// available balance, or OKX_MARGIN_USDT if set, capped at what is actually available.
async function resolveMarginUsdt(config) {
  const account = await okx.getAccount(config);
  if (config.marginUsdt != null) return Math.min(config.marginUsdt, account.available);
  return Math.max(account.available * 0.95, 0);
}

function buildReasonText(signal, tier) {
  const lines = [`패턴: ${signalTitle(signal.pattern)} (급락 ${(signal.drop * 100).toFixed(1)}%, Bitget 15분봉 기준)`, signal.detail];
  const reasons = signalReasons(signal.pattern);
  if (reasons.length) lines.push(...reasons.map((reason) => `- ${reason}`));
  lines.push(`비중: 최대 포지션의 ${tier}/3 (급락 3%대 1/3 · 4%대 2/3 · 5% 이상 전부)`);
  return lines.join("\n");
}

async function maybeEnter(config, contract, state, closedCandles, signals, reports) {
  if (state.openPosition) return;

  const latestCandle = closedCandles[closedCandles.length - 1];
  const latest = signals.at(-1);
  if (!latest || !latestCandle || latest.index !== closedCandles.length - 1) return;

  const watermark = resumeWatermark(state);
  if (watermark != null && latestCandle.time <= watermark) return;

  const capUsdt = await resolveMarginUsdt(config);
  if (capUsdt <= 0) {
    log("WARN: no available balance to open a position with — skipping this signal.");
    return;
  }
  const tier = sizeTier(latest.drop);
  const marginUsdt = (capUsdt * tier) / 3;

  // Bitget's close stands in for OKX's: the stop has to be known before the order fills,
  // and the two perps trade within a few dollars of each other.
  const price = latestCandle.close;
  const stopLoss = price * (1 - CLIMAX_STOP_PCT);
  const exitAt = latestCandle.time + CANDLE_MS * (1 + CLIMAX_HOLD_CANDLES);
  const size = okx.roundSize((marginUsdt * LEVERAGE) / price, contract);

  // roundSize() rounds UP to the contract minimum — don't ask for margin we don't have.
  const impliedMargin = (Number(size) * contract.ctVal * price) / LEVERAGE;
  if (impliedMargin > capUsdt * 1.05) {
    log(`WARN: skipping entry — minimum order needs ~$${impliedMargin.toFixed(2)} margin, only $${capUsdt.toFixed(2)} available.`);
    return;
  }

  log(
    `Signal: panic-climax drop=${(latest.drop * 100).toFixed(2)}% vol=${latest.volumeRatio.toFixed(1)}x price=${price} ` +
      `tier=${tier}/3 margin=${marginUsdt.toFixed(2)} size=${size} contracts — buying at market...`,
  );

  const order = await okx.placeOrder(config, {
    side: "buy",
    posSide: "long",
    size,
    slTriggerPrice: stopLoss.toFixed(1),
    clientOrderId: `pc${latestCandle.time}`,
  });

  await new Promise((resolve) => setTimeout(resolve, 2000));
  const detail = await okx.getOrderDetail(config, { orderId: order.ordId }).catch(() => null);
  const entryPrice = (detail && Number(detail.avgPx)) || price;
  const entryTime = (detail && Number(detail.cTime)) || Date.now();

  state.openPosition = {
    pattern: latest.pattern,
    direction: "LONG",
    score: latest.score,
    leverage: LEVERAGE,
    size: marginUsdt,
    entryTime,
    entryPrice,
    positionSize: size, // contracts
    sizeTier: tier,
    drop: latest.drop,
    signalCandleTime: latestCandle.time,
    takeProfit: null, // no target — exitAt closes it
    exitAt,
    stopLoss,
    orderId: order.ordId,
  };

  const exitClock = new Date(exitAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  log(`Entered LONG ${size} contracts @ ${entryPrice} (ordId ${order.ordId}) — SL ${stopLoss.toFixed(1)}, time exit ${new Date(exitAt).toISOString()}`);

  const snapshotCandles = closedCandles.slice(-CHART_SNAPSHOT_CANDLES);
  const chartSvg = renderCandleSnapshot({
    candles: snapshotCandles,
    title: `BTCUSDT 15m (Bitget) · ${new Date(entryTime).toLocaleString("ko-KR")}`,
    markers: [{ index: snapshotCandles.length - 1, color: "#f472b6", label: "B" }],
    lines: [
      { price: latest.refHigh, color: "#94a3b8", label: `5h 고점 ${latest.refHigh.toFixed(1)}` },
      { price: stopLoss, color: "#f43f5e", label: `SL ${stopLoss.toFixed(1)}` },
    ],
  });

  openReport(reports, {
    id: `okx-${entryTime}`,
    bot: "okx",
    pattern: latest.pattern,
    score: latest.score,
    reasonSummary: signalTitle(latest.pattern),
    reasonDetail: buildReasonText(latest, tier),
    entryTime,
    entryPrice,
    takeProfit: null,
    stopLoss,
    chartSvg,
  });

  await notify(
    [
      "OKX 실전 포지션 진입 (패닉 클라이맥스)",
      `급락: ${(latest.drop * 100).toFixed(1)}% · 거래량 평균의 ${latest.volumeRatio.toFixed(1)}배 (Bitget 기준)`,
      `진입가: $${entryPrice.toLocaleString()}`,
      `비중: ${tier}/3 · 증거금 $${marginUsdt.toFixed(2)} · ${LEVERAGE}x`,
      `청산: ${exitClock} 시장가 (1시간 보유)`,
      `손절: $${stopLoss.toFixed(1)} (-${(CLIMAX_STOP_PCT * 100).toFixed(0)}%)`,
      `시간: ${new Date(entryTime).toLocaleString("ko-KR")}`,
    ].join("\n"),
  );
}

function trackedFiles(state, stateBefore, reports, reportsBefore) {
  return [
    { path: "data/live-trades-okx.json", changed: JSON.stringify(state) !== stateBefore, save: () => saveState(state), purgeUrl: STATE_PURGE_URL },
    {
      path: "data/trade-reports-okx.json",
      changed: JSON.stringify(reports) !== reportsBefore,
      save: () => saveReports(REPORTS_PATH, reports),
      purgeUrl: REPORTS_PURGE_URL,
    },
  ];
}

let contractConfigCache = null;

async function tick(config, bitgetConfig, state, reports) {
  const stateBefore = JSON.stringify(state);
  const reportsBefore = JSON.stringify(reports);

  if (state.startingBalance == null) {
    const account = await okx.getAccount(config);
    state.startingBalance = account.equity;
    state.currentBalance = account.equity;
  }

  const candles = await bitget.getCandles(bitgetConfig, { granularity: CANDLE_GRANULARITY, limit: CANDLE_LIMIT });
  const closedCandles = candles.slice(0, -1); // last candle is still forming
  const signals = detectPanicClimax(closedCandles);

  if (!contractConfigCache) contractConfigCache = await okx.getContractConfig(config);

  await reconcilePosition(config, state, reports);
  if (!state.openPosition) await maybeEnter(config, contractConfigCache, state, closedCandles, signals, reports);

  persistFiles(trackedFiles(state, stateBefore, reports, reportsBefore));
}

async function main() {
  const config = okx.loadConfig();
  const bitgetConfig = bitget.loadConfig();
  const marginDesc =
    "1/3, 2/3 or all of " +
    (config.marginUsdt != null ? `${config.marginUsdt} USDT` : "~95% of available balance") +
    " by panic depth (panic-climax, Bitget signals)";
  log(`Starting OKX live-trade loop for ${config.symbol} (LIVE — real funds). Margin per trade: ${marginDesc} @ ${LEVERAGE}x.`);

  const setup = await okx.ensureAccountSetup(config, { leverage: LEVERAGE });
  log("Account setup (non-fatal if a position is already open):", setup);

  const state = loadState();
  const reports = loadReports(REPORTS_PATH);
  contractConfigCache = await okx.getContractConfig(config);
  {
    const stateBefore = JSON.stringify(state);
    const reportsBefore = JSON.stringify(reports);
    await reconcilePosition(config, state, reports);
    persistFiles(trackedFiles(state, stateBefore, reports, reportsBefore));
  }

  let tickInFlight = false;
  async function runTick() {
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      await tick(config, bitgetConfig, state, reports);
    } catch (error) {
      log("ERROR during tick (loop continues):", error.message);
    } finally {
      tickInFlight = false;
    }
  }

  await runTick();
  setInterval(runTick, POLL_INTERVAL_MS);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { reconcilePosition, maybeEnter };
