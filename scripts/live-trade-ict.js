// Runs continuously on the user's own always-on PC (NOT GitHub Actions — same reasoning
// as scripts/live-trade.js). Places real OKX orders for the ICT (Liquidity Sweep -> MSS ->
// FVG) strategy — scripts/lib/ict-signals.js. This is a SEPARATE exchange/account from the
// Bitget double-bottom bot on purpose: Bitget's one-way position mode would merge both
// bots' positions into one if they ever traded the same symbol on the same account,
// breaking independent $-amount allocation. OKX is a clean second account for this.
//
// Rules (see the TRANCHES block below for the backtest numbers behind each one):
//   - DIRECTION follows whichever way recent ICT signals have been leaning, rather than a
//     fixed LONG. A signal against the lean, or one during a period with no clear lean, is
//     skipped.
//   - ENTRY is a three-slice ladder priced off the signal's own risk (entry -> sweep
//     extreme): one market order now, two limit orders resting 0.4R and 0.8R further away.
//   - EXIT is split: half the filled size at +1R, the rest at +3R, as resting reduce-only
//     limit orders placed per tranche as that tranche fills.
//   - the STOP is a single level 1.6R from the FIRST entry, attached to every tranche as an
//     exchange-side trigger (slTriggerPx) so OKX closes the position even if this process
//     is offline. That is the one guarantee this script does not manage itself.
//   - position size is a FIXED margin amount (OKX_MARGIN_USDT), same as live-trade.js.
//
// The exchange is always the source of truth: each tick reads the real position, notices
// tranche fills, and reconciles the local JSON. When flat, every leftover resting order is
// cancelled — an unfilled tranche would otherwise re-open a position with no signal behind
// it. See scripts/lib/okx-client.js for the exact API calls.
//
// This account is in hedge mode (posMode: "long_short_mode"), so every order names its
// posSide — "long" for a long ladder, "short" for a short one.
//
// Run it locally: run-live-trade-ict.bat (needs OKX_API_KEY / OKX_API_SECRET /
// OKX_API_PASSPHRASE / OKX_SYMBOL in .env — see the OKX section already there).

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { detectICTSignals } = require("./lib/ict-signals");
const okx = require("./lib/okx-client");
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
// Scale in / scale out, sized off each signal's own risk (entry -> sweep extreme), and
// traded in whichever direction ICT signals have been leaning lately rather than a fixed
// LONG. The old single-entry R=2 LONG-only setup had no edge once the real 0.080%
// round-trip fee was counted — its stop sits only ~0.64% away, so fees ate ~12% of every
// risk unit. Measured on 150 days of 15m BTC with that fee applied:
//   single entry, LONG only (what ran before) : 94 trades, 39.4% win, 100 -> 57.6, MDD 66%
//   ladder, LONG only                          : 81 trades, 53.1% win, 100 -> 160.5, MDD 21%
//   ladder + dominant direction (this)         : 85 trades, 51.8% win, 100 -> 186.5, MDD 18%
//     in-sample 151.5 / out-of-sample 131.6 — profitable in both halves
// Direction rule sensitivity: lookback 10 fails (84.0), 20 and 40 both hold (189 / 170);
// the majority threshold works anywhere from 0 to 4 and breaks at 6. Re-run
// scratchpad/ict_direction_cmp.js before touching any of these.
const TRANCHES = 3;
const TRANCHE_STEP_R = 0.4; // each further slice rests 0.4R further against the entry
const TP1_R = 1.0; // half the filled size exits here
const TP2_R = 3.0; // the rest exits here
const STOP_R = 1.6; // measured from the FIRST entry and never moved
const DIRECTION_LOOKBACK = 20; // how many prior signals the direction vote reads
const DIRECTION_MIN_EDGE = 1; // one side must lead by more than this to be tradeable
const CANDLE_GRANULARITY = "15m";
// The direction vote reads the previous DIRECTION_LOOKBACK signals, and ICT signals are
// sparse (~1 per 100 candles), so a 200-candle window would only ever hold a handful and
// the vote would almost never reach a verdict — a live-vs-backtest gap, since the backtest
// always had 20 prior signals to count. 1500 candles yields ~44 signals and costs ~150ms
// per tick to scan, which is nothing against a 30s poll.
const CANDLE_LIMIT = 1500;
const CANDLE_PAGE_SIZE = 300; // OKX caps /market/candles at 300 rows per request
const POLL_INTERVAL_MS = 30_000;
const CHART_SNAPSHOT_CANDLES = 60;
const REPO_ROOT = path.join(__dirname, "..");
const STATE_PATH = path.join(REPO_ROOT, "data", "live-trades-ict.json");
const REPORTS_PATH = path.join(REPO_ROOT, "data", "trade-reports-ict.json");
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

// See live-trade.js's persistFiles() for the full rationale — same generalization to
// cover both the state file and this bot's own trade-report journal in one commit.
function persistFiles(files) {
  const changedFiles = files.filter((f) => f.changed);
  for (const file of changedFiles) file.save();
  if (!changedFiles.length && !pushRetryNeeded) return;

  try {
    if (changedFiles.length) {
      execFileSync("git", ["add", ...changedFiles.map((f) => f.path)], GIT_OPTS);
      execFileSync("git", ["commit", "-m", "Update ICT live-trade state [skip ci]"], GIT_OPTS);
    }
    execFileSync("git", ["pull", "--rebase", "origin", "main"], GIT_OPTS);
    execFileSync("git", ["push", "origin", "HEAD:main"], GIT_OPTS);
    log(pushRetryNeeded ? "Retried a previously failed push — succeeded." : "Committed and pushed ICT live-trade state.");
    pushRetryNeeded = false;
    for (const file of files) purgeJsDelivrCache(file.purgeUrl);
  } catch (error) {
    pushRetryNeeded = true;
    log("WARN: git commit/push failed, will retry next tick. Data is safe on disk either way.", error.message);
  }
}

const STATE_PURGE_URL = "https://purge.jsdelivr.net/gh/ziego0445/bitcoinGPT@main/data/live-trades-ict.json";
const REPORTS_PURGE_URL = "https://purge.jsdelivr.net/gh/ziego0445/bitcoinGPT@main/data/trade-reports-ict.json";

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
    // Taken from the exchange, not assumed: this bot trades both ways now, and getting
    // this wrong would flip the sign on the recorded P&L and make reconcilePosition hunt
    // for the closing fill on the wrong side.
    direction: position.posSide === "short" ? "SHORT" : "LONG",
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
// Watches a live ladder: when a resting tranche fills, the exchange position grows, so
// that tranche's own exits get placed. The exchange's size is the source of truth, so a
// fill that happened while this process was down is still picked up on the next tick.
async function manageOpenPosition(config, contract, state, position) {
  const opened = state.openPosition;
  if (!opened || !opened.trancheSize) return; // pre-ladder position (e.g. "recovered")

  if (position.avgPrice) opened.entryPrice = position.avgPrice;

  // Once any exit has fired, stop adding — see live-trade.js's copy of this guard for why
  // (the backtest only fills tranches before anything is taken off).
  const size = position.contracts;
  opened.peakSize = Math.max(opened.peakSize ?? size, size);
  if (size < opened.peakSize - Number(opened.trancheSize) * 0.1 && !opened.addsClosed) {
    const cancelled = await okx.cancelEntryOrders(config).catch((error) => {
      log("WARN: could not cancel remaining tranche orders:", error.message);
      return 0;
    });
    opened.addsClosed = true;
    log(`Partial exit detected (size ${size} < peak ${opened.peakSize}) — cancelled ${cancelled} unfilled tranche order(s).`);
  }

  const filledNow = Math.min(TRANCHES, Math.round(size / Number(opened.trancheSize)));
  if (filledNow <= (opened.tranchesFilled ?? 1)) return;

  const isLong = opened.direction !== "SHORT";
  const sgn = isLong ? 1 : -1;
  const tp1 = opened.firstEntryPrice + sgn * opened.riskPerUnit * TP1_R;
  const tp2 = opened.firstEntryPrice + sgn * opened.riskPerUnit * TP2_R;
  for (let t = (opened.tranchesFilled ?? 1) + 1; t <= filledNow; t += 1) {
    log(`Tranche ${t}/${TRANCHES} filled (position now ${position.contracts}) — placing its exits.`);
    await placeTrancheExits(config, contract, opened.trancheSize, isLong, tp1, tp2, opened.signalCandleTime, t);
  }
  opened.tranchesFilled = filledNow;

  await notify(
    [
      `ICT 분할 추가진입 체결 (${filledNow}/${TRANCHES}, ${opened.direction})`,
      `평단: $${Number(position.avgPrice).toLocaleString()}`,
      `보유: ${position.contracts} 계약`,
      `익절: $${tp1.toFixed(1)} · $${tp2.toFixed(1)}`,
    ].join("\n"),
  );
}

// Size-weighted average price across a set of fills, or null when there are none.
function ladderAverage(orders, sizeOf, priceOf) {
  let weighted = 0;
  let total = 0;
  for (const order of orders) {
    const size = sizeOf(order);
    const price = priceOf(order);
    if (!(size > 0) || !(price > 0)) continue;
    weighted += size * price;
    total += size;
  }
  return total > 0 ? weighted / total : null;
}

async function reconcilePosition(config, state, contract, reports) {
  const position = await okx.getPosition(config);

  if (position && !state.openPosition) {
    adoptUntrackedPosition(state, position);
    return;
  }
  if (position) {
    // Still open — the only thing to do is notice tranche fills and give each its exits.
    if (contract) await manageOpenPosition(config, contract, state, position);
    return;
  }
  // Flat on the exchange. Anything still resting belongs to a ladder that is now over —
  // an unfilled tranche left behind would quietly re-open a position with no signal
  // behind it, so clear the book first.
  await okx.cancelAllOrders(config).catch((error) => log("WARN: could not clear leftover orders:", error.message));
  if (!state.openPosition) return; // idle tick, no position on either side

  const opened = state.openPosition;
  // A short is opened by selling and CLOSED BY BUYING, so which side counts as the closing
  // fill depends on the direction this position was in.
  const wasLong = opened.direction !== "SHORT";
  const closingSide = wasLong ? "sell" : "buy";
  const history = await okx.getHistoryOrders(config, { startTime: opened.entryTime - 60_000 }).catch(() => []);
  // The ladder closes in TWO reduce-only fills (half at TP1, half at TP2), and any other
  // activity on this account afterward matches the same filter. Taking one arbitrary match
  // both misses half of a real two-part exit and can pick up something unrelated — so walk
  // oldest-first and stop once the closed size covers what was actually entered. See
  // live-trade.js's copy for the real mix-up that motivated this.
  const closingCandidates = history
    // Filled volume, not status: a partly-filled-then-cancelled exit still closed part of
    // the position and still belongs in the average.
    .filter(
      (order) =>
        Number(order.accFillSz ?? 0) > 0 &&
        order.side === closingSide &&
        (order.reduceOnly === true || order.reduceOnly === "true"),
    )
    .sort((a, b) => Number(a.uTime ?? a.cTime) - Number(b.uTime ?? b.cTime));

  const expectedSize = opened.trancheSize != null ? Number(opened.trancheSize) * (opened.tranchesFilled ?? 1) : null;
  const closingOrders = [];
  let closedSize = 0;
  for (const order of closingCandidates) {
    if (expectedSize != null && closedSize >= expectedSize - 1e-9) break; // rest belongs to something else
    closingOrders.push(order);
    closedSize += Number(order.accFillSz ?? order.sz ?? 0);
  }
  // A "recovered" position never recorded a tranche size, so there is nothing to measure
  // against — fall back to the single-order behavior this replaced.
  if (expectedSize == null && closingOrders.length > 1) closingOrders.length = 1;
  const closingOrder = closingOrders.at(-1); // last leg: gives exitTime / exitOrderId

  const account = await okx.getAccount(config);
  let exitPrice;
  let exitReason;

  // The ladder's own average entry, from its own entry fills (clOrdId ict<signalTime>,
  // ict<signalTime>t2, ...t3 — the exits carry the same prefix but are reduce-only).
  // opened.entryPrice is kept in sync with the exchange's position average while open,
  // which is wrong the moment anything else trades this account; the bot's own fills
  // aren't.
  const ownEntryPrice = ladderAverage(
    history.filter(
      (o) =>
        String(o.clOrdId ?? "").startsWith(`ict${opened.signalCandleTime}`) &&
        !(o.reduceOnly === true || o.reduceOnly === "true") &&
        Number(o.accFillSz ?? 0) > 0,
    ),
    (o) => Number(o.accFillSz),
    (o) => Number(o.avgPx),
  );
  if (ownEntryPrice != null) opened.entryPrice = ownEntryPrice;

  if (closingOrder) {
    // Size-weighted across every leg that closed the ladder, not just the last one — the
    // last leg alone recorded a clean 1R+3R short as its 0.03-contract dust close at
    // 76,939.9 (+17.6%) when the real blended exit was ~77,495 (~+10.5%).
    exitPrice =
      ladderAverage(closingOrders, (o) => Number(o.accFillSz ?? o.sz ?? 0), (o) => Number(o.avgPx ?? o.fillPx ?? o.px)) ??
      Number(closingOrder.avgPx ?? closingOrder.fillPx ?? closingOrder.px);
    const nearTakeProfit = opened.takeProfit != null && Math.abs(exitPrice - opened.takeProfit) / opened.takeProfit < 0.001;
    const nearStopLoss = opened.stopLoss != null && Math.abs(exitPrice - opened.stopLoss) / opened.stopLoss < 0.001;
    if (nearTakeProfit && !nearStopLoss) exitReason = "take-profit";
    else if (nearStopLoss && !nearTakeProfit) exitReason = "stop-loss";
    // Falling back on the direction of the move: up is a win for a long, down for a short.
    else exitReason = (wasLong ? exitPrice >= opened.entryPrice : exitPrice <= opened.entryPrice) ? "take-profit" : "stop-loss";
  } else {
    const balanceWentUp = state.currentBalance != null ? account.equity > state.currentBalance : true;
    exitReason = balanceWentUp ? "take-profit" : "stop-loss";
    exitPrice = (exitReason === "take-profit" ? opened.takeProfit : opened.stopLoss) ?? opened.entryPrice;
    log("WARN: couldn't find the closing order in history — estimated exit price/reason from balance change instead.");
  }
  const exitTime = closingOrder ? Number(closingOrder.uTime ?? closingOrder.cTime) || Date.now() : Date.now();

  // A short profits when price falls, so the move is measured in the position's direction.
  const priceMovePct = ((wasLong ? 1 : -1) * (exitPrice - opened.entryPrice)) / opened.entryPrice;
  const pnlPct = priceMovePct * opened.leverage * 100;

  state.trades.push({
    pattern: opened.pattern,
    direction: opened.direction ?? "LONG", // pre-ladder records had no direction; they were all long
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

  // No matching open report for a "recovered" position — closeReport() no-ops safely.
  closeReport(reports, opened.entryTime, { exitTime, exitPrice, exitReason, pnlPct, entryPrice: opened.entryPrice });

  await notify(
    [
      exitReason === "take-profit" ? "ICT 실전 포지션 익절 종료 (OKX)" : "ICT 실전 포지션 손절 종료 (OKX)",
      opened.mssType ? `구조: ${opened.mssType}` : null,
      `진입가: $${opened.entryPrice.toLocaleString()} → 청산가: $${exitPrice.toLocaleString()}`,
      `손익: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`,
      `잔고: $${account.equity.toFixed(2)}`,
      `시간: ${new Date(exitTime).toLocaleString("ko-KR")}`,
    ]
      .filter(Boolean)
      .join("\n"),
  );
}

// See live-trade.js's identical helper for the "full"/fixed rationale.
async function resolveMarginUsdt(config) {
  const account = await okx.getAccount(config);
  if (config.marginUsdt != null) return Math.min(config.marginUsdt, account.available);
  return Math.max(account.available * 0.95, 0);
}

// Composes the "why did we enter" writeup straight from the signal's own three-step
// evidence (sweep -> MSS/BOS -> FVG) — same no-new-reasoning-invented approach as
// live-trade.js's buildReasonText().
function buildReasonText(signal, closedCandles) {
  const sweepTime = closedCandles[signal.sweepIndex]?.time;
  const mssTime = closedCandles[signal.mssIndex]?.time;
  return [
    `패턴: ICT 유동성 스윕 → ${signal.mssType} → FVG 진입 (LONG)`,
    signal.detail,
    `① 유동성 스윕: ${sweepTime ? new Date(sweepTime).toLocaleString("ko-KR") : "-"} · $${signal.sweepPrice.toLocaleString()}`,
    `② ${signal.mssType}: ${mssTime ? new Date(mssTime).toLocaleString("ko-KR") : "-"} · $${signal.mssLevel.toLocaleString()}`,
    `③ FVG 구간: $${signal.fvgLow.toLocaleString()} ~ $${signal.fvgHigh.toLocaleString()}`,
  ].join("\n");
}

// Which way to trade right now: whichever direction the recent ICT signals have been
// leaning. Only signals BEFORE the one being judged are counted, so this can't peek ahead.
// Returns null when neither side leads clearly enough — then the signal is skipped.
function dominantDirection(signals, uptoIndex) {
  const prior = signals.filter((s) => s.index < uptoIndex).slice(-DIRECTION_LOOKBACK);
  const longs = prior.filter((s) => s.direction === "LONG").length;
  const shorts = prior.length - longs;
  if (longs > shorts + DIRECTION_MIN_EDGE) return "LONG";
  if (shorts > longs + DIRECTION_MIN_EDGE) return "SHORT";
  return null;
}

// One tranche's own exits: half of it at the near target, half at the far one. Placed per
// tranche as it fills, so the totals always come out to half the filled size at each
// target without ever resizing a live order.
async function placeTrancheExits(config, contract, trancheSize, isLong, tp1, tp2, signalTime, trancheNumber) {
  const half = okx.roundSize((Number(trancheSize) * contract.ctVal) / 2, contract);
  // The far leg takes the remainder, not a second `half` — see live-trade.js's copy. Here
  // 0.31 contracts split as 0.15 + 0.15 left 0.01 per tranche; after a clean 1R + 3R win
  // on all three tranches, 0.03 contracts stayed open and blocked the bot.
  const lotDecimals = (String(contract.lotSz).split(".")[1] || "").length;
  const rest = (Number(trancheSize) - Number(half)).toFixed(lotDecimals);
  // roundSize() also rounds up to the contract minimum, so on a small tranche "half" can
  // come back as the whole thing — fall back to a single order at the near target.
  const exits =
    Number(half) * 2 > Number(trancheSize)
      ? [[tp1, "a", trancheSize]]
      : [
          [tp1, "a", half],
          [tp2, "b", rest],
        ];
  for (const [price, tag, size] of exits) {
    await okx
      .placeOrder(config, {
        side: isLong ? "sell" : "buy", // closing side is the opposite of the entry
        posSide: isLong ? "long" : "short",
        size,
        price: price.toFixed(1),
        reduceOnly: true,
        clientOrderId: `ict${signalTime}x${trancheNumber}${tag}`,
      })
      .catch((error) => log(`WARN: tranche ${trancheNumber} exit ${tag} failed:`, error.message));
  }
}

async function maybeEnter(config, contract, state, closedCandles, signals, reports) {
  if (state.openPosition) return;

  const latestCandle = closedCandles[closedCandles.length - 1];
  const latest = signals.find((s) => s.index === closedCandles.length - 1);
  if (!latest || !latestCandle) return; // no signal on the freshest closed candle

  const watermark = resumeWatermark(state);
  if (watermark != null && latestCandle.time <= watermark) return; // already acted on this candle (or an earlier one)

  // Only trade with the recent grain. A signal against it (or during a period with no
  // clear lean) is skipped — that filter is worth 160.5 -> 186.5 on the backtest.
  const regime = dominantDirection(signals, latest.index);
  if (regime == null || regime !== latest.direction) {
    log(`Signal ${latest.direction} skipped — recent signal lean is ${regime ?? "unclear"}.`);
    return;
  }

  const isLong = latest.direction === "LONG";
  const sgn = isLong ? 1 : -1;
  const price = latestCandle.close;
  // Every level is a multiple of the signal's own risk (entry -> sweep extreme), measured
  // off the FIRST entry and never recalculated, so the whole ladder can be placed up front.
  const risk = sgn * (price - latest.sweepPrice);
  if (!(risk > 0)) {
    log("WARN: sweep price is on the wrong side of entry — skipping (shouldn't happen for a real signal).");
    return;
  }
  const stopLoss = price - sgn * risk * STOP_R;
  const takeProfit1 = price + sgn * risk * TP1_R;
  const takeProfit2 = price + sgn * risk * TP2_R;

  const marginUsdt = await resolveMarginUsdt(config);
  if (marginUsdt <= 0) {
    log("WARN: no available balance to open a position with — skipping this signal.");
    return;
  }

  const trancheSize = okx.roundSize((marginUsdt * LEVERAGE) / price / TRANCHES, contract);
  // Checked against the FULL ladder, since all three tranches can fill.
  const impliedMargin = (Number(trancheSize) * TRANCHES * contract.ctVal * price) / LEVERAGE;
  if (impliedMargin > marginUsdt * 1.05) {
    log(
      `WARN: skipping entry — exchange minimum order size needs ~$${impliedMargin.toFixed(2)} margin for the full ladder, ` +
        `only $${marginUsdt.toFixed(2)} available.`,
    );
    return;
  }

  log(
    `Signal: ICT ${latest.mssType} ${latest.direction} (lean ${regime}) price=${price} risk=${risk.toFixed(1)} ` +
      `stop=${stopLoss.toFixed(1)} targets=${takeProfit1.toFixed(1)}/${takeProfit2.toFixed(1)} ` +
      `margin=${marginUsdt.toFixed(2)} tranche=${trancheSize} x${TRANCHES} — placing ladder...`,
  );

  // Tranche 1 at market, carrying the stop as an exchange-side trigger so OKX closes the
  // position at that level even while this process is offline. clOrdId must be plain
  // alphanumeric per OKX's rules (no hyphens, unlike Bitget's clientOid).
  const posSide = isLong ? "long" : "short";
  const order = await okx.placeOrder(config, {
    side: isLong ? "buy" : "sell",
    posSide,
    size: trancheSize,
    slTriggerPrice: stopLoss.toFixed(1),
    clientOrderId: `ict${latestCandle.time}`,
  });

  await new Promise((resolve) => setTimeout(resolve, 2000));
  const detail = await okx.getOrderDetail(config, { orderId: order.ordId }).catch(() => null);
  const entryPrice = (detail && Number(detail.avgPx || detail.px)) || price;
  const entryTime = (detail && Number(detail.cTime)) || Date.now();

  // Remaining tranches rest on the book so they fill at the exact ladder price even
  // between 30s polls, matching what the backtest assumed.
  for (let t = 1; t < TRANCHES; t += 1) {
    const level = price - sgn * risk * TRANCHE_STEP_R * t;
    await okx
      .placeOrder(config, {
        side: isLong ? "buy" : "sell",
        posSide,
        size: trancheSize,
        price: level.toFixed(1),
        slTriggerPrice: stopLoss.toFixed(1),
        clientOrderId: `ict${latestCandle.time}t${t + 1}`,
      })
      .catch((error) => log(`WARN: tranche ${t + 1} limit order failed (ladder continues):`, error.message));
  }

  await placeTrancheExits(config, contract, trancheSize, isLong, takeProfit1, takeProfit2, latestCandle.time, 1);

  const takeProfit = takeProfit1; // kept under the old name so the dashboard keeps rendering
  state.openPosition = {
    pattern: "ict-fvg",
    direction: latest.direction,
    mssType: latest.mssType,
    leverage: LEVERAGE,
    size: marginUsdt,
    entryTime,
    entryPrice, // average entry — refreshed from the exchange as tranches fill
    firstEntryPrice: entryPrice,
    riskPerUnit: risk,
    trancheSize,
    tranchesFilled: 1,
    signalCandleTime: latestCandle.time,
    takeProfit,
    takeProfit2,
    stopLoss,
    orderId: order.ordId,
  };

  log(
    `Entered ${latest.direction} tranche 1/${TRANCHES} @ ${entryPrice} (orderId ${order.ordId}) — ` +
      `adds at ${(price - sgn * risk * TRANCHE_STEP_R).toFixed(1)} / ${(price - sgn * risk * TRANCHE_STEP_R * 2).toFixed(1)}, ` +
      `TP ${takeProfit1.toFixed(1)} & ${takeProfit2.toFixed(1)}, SL ${stopLoss.toFixed(1)}`,
  );

  // Map the signal's sweep/MSS candle indices (against the full closedCandles series)
  // onto the trimmed snapshot window so their markers land on the right candle.
  const snapshotCandles = closedCandles.slice(-CHART_SNAPSHOT_CANDLES);
  const snapshotOffset = closedCandles.length - snapshotCandles.length;
  const toSnapshotIndex = (index) => index - snapshotOffset;
  const markers = [{ index: snapshotCandles.length - 1, color: "#facc15", label: "B" }];
  const sweepSnapIndex = toSnapshotIndex(latest.sweepIndex);
  if (sweepSnapIndex >= 0) markers.push({ index: sweepSnapIndex, color: "#f472b6", label: "①스윕" });
  const mssSnapIndex = toSnapshotIndex(latest.mssIndex);
  if (mssSnapIndex >= 0) markers.push({ index: mssSnapIndex, color: "#22d3ee", label: `②${latest.mssType}` });

  const chartSvg = renderCandleSnapshot({
    candles: snapshotCandles,
    title: `BTC-USDT-SWAP 15m · ${new Date(entryTime).toLocaleString("ko-KR")}`,
    markers,
    lines: [
      { price: takeProfit2, color: "#4ade80", label: `TP2 ${takeProfit2.toFixed(1)}` },
      { price: takeProfit1, color: "#86efac", label: `TP1 ${takeProfit1.toFixed(1)}` },
      { price: price - sgn * risk * TRANCHE_STEP_R, color: "#94a3b8", label: "추가2" },
      { price: price - sgn * risk * TRANCHE_STEP_R * 2, color: "#94a3b8", label: "추가3" },
      { price: stopLoss, color: "#f43f5e", label: `SL ${stopLoss.toFixed(1)}` },
      { price: latest.fvgLow, color: "#a78bfa", label: "FVG low" },
      { price: latest.fvgHigh, color: "#a78bfa", label: "FVG high" },
    ],
  });

  openReport(reports, {
    id: `ict-${entryTime}`,
    bot: "ict",
    pattern: "ict-fvg",
    direction: latest.direction, // this bot trades both ways now — the journal has to say which
    mssType: latest.mssType,
    reasonSummary: `유동성 스윕 → ${latest.mssType} → FVG 진입`,
    reasonDetail: buildReasonText(latest, closedCandles),
    entryTime,
    entryPrice,
    takeProfit,
    stopLoss,
    chartSvg,
  });

  await notify(
    [
      `ICT 실전 포지션 진입 ${latest.direction} (분할 1/${TRANCHES}, OKX)`,
      `구조: ${latest.mssType} 유동성 스윕 → FVG 진입 · 최근 신호 우세 ${regime}`,
      `진입가: $${entryPrice.toLocaleString()}`,
      `증거금: $${marginUsdt.toFixed(2)} · ${LEVERAGE}x (3분할)`,
      `추가진입: $${(price - sgn * risk * TRANCHE_STEP_R).toFixed(1)} / $${(price - sgn * risk * TRANCHE_STEP_R * 2).toFixed(1)}`,
      `익절: $${takeProfit1.toFixed(1)}(절반) · $${takeProfit2.toFixed(1)}(절반)`,
      `손절: $${stopLoss.toFixed(1)}`,
      `시간: ${new Date(entryTime).toLocaleString("ko-KR")}`,
    ].join("\n"),
  );
}

// OKX returns at most CANDLE_PAGE_SIZE rows per call, so walk backwards until we have
// enough history for the direction vote.
async function fetchCandles(config) {
  let all = [];
  let after;
  while (all.length < CANDLE_LIMIT) {
    const batch = await okx.getCandles(config, { bar: CANDLE_GRANULARITY, limit: CANDLE_PAGE_SIZE, after });
    if (!batch.length) break;
    all = batch.concat(all);
    after = batch[0].time;
    if (batch.length < CANDLE_PAGE_SIZE) break;
  }
  // de-dup by timestamp (pages can overlap by a row) and keep ascending order
  const byTime = new Map();
  for (const c of all) byTime.set(c.time, c);
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

let contractConfigCache = null;

async function tick(config, state, reports) {
  const stateBefore = JSON.stringify(state);
  const reportsBefore = JSON.stringify(reports);

  if (state.startingBalance == null) {
    const account = await okx.getAccount(config);
    state.startingBalance = account.equity;
    state.currentBalance = account.equity;
  }

  const candles = await fetchCandles(config);
  const closedCandles = candles.slice(0, -1); // last candle is still forming
  // Both directions are kept — maybeEnter() decides which way to trade from the recent
  // signal lean, and the vote itself needs to see both sides to count them.
  const signals = detectICTSignals(closedCandles);

  // Fetched before reconciling now — managing a live ladder needs the contract's size
  // rounding to place each tranche's exits.
  if (!contractConfigCache) {
    contractConfigCache = await okx.getContractConfig(config);
  }

  await reconcilePosition(config, state, contractConfigCache, reports);

  if (!state.openPosition) {
    await maybeEnter(config, contractConfigCache, state, closedCandles, signals, reports);
  }

  persistFiles([
    { path: "data/live-trades-ict.json", changed: JSON.stringify(state) !== stateBefore, save: () => saveState(state), purgeUrl: STATE_PURGE_URL },
    {
      path: "data/trade-reports-ict.json",
      changed: JSON.stringify(reports) !== reportsBefore,
      save: () => saveReports(REPORTS_PATH, reports),
      purgeUrl: REPORTS_PURGE_URL,
    },
  ]);
}

async function reconcileOnStartup(config, state, contract, reports) {
  const stateBefore = JSON.stringify(state);
  const reportsBefore = JSON.stringify(reports);
  await reconcilePosition(config, state, contract, reports);
  persistFiles([
    { path: "data/live-trades-ict.json", changed: JSON.stringify(state) !== stateBefore, save: () => saveState(state), purgeUrl: STATE_PURGE_URL },
    {
      path: "data/trade-reports-ict.json",
      changed: JSON.stringify(reports) !== reportsBefore,
      save: () => saveReports(REPORTS_PATH, reports),
      purgeUrl: REPORTS_PURGE_URL,
    },
  ]);
}

async function main() {
  const config = okx.loadConfig();
  const marginDesc = config.marginUsdt != null ? `${config.marginUsdt} USDT (fixed)` : "~95% of available balance each trade";
  log(`Starting ICT live-trade loop for ${config.symbol} on OKX (LIVE — real funds). Margin per trade: ${marginDesc} @ ${LEVERAGE}x.`);

  const setup = await okx.ensureAccountSetup(config, { leverage: LEVERAGE });
  log("Account setup (non-fatal if a position is already open):", setup);

  const state = loadState();
  const reports = loadReports(REPORTS_PATH);
  contractConfigCache = await okx.getContractConfig(config);
  await reconcileOnStartup(config, state, contractConfigCache, reports);

  let tickInFlight = false;
  async function runTick() {
    if (tickInFlight) return;
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
