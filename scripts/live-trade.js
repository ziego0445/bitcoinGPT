// Runs continuously on the user's own always-on PC (NOT GitHub Actions — see the note
// below). Places real Bitget orders off scripts/lib/signals.js's double-bottom pattern
// (10x leverage, LONG only, score>=85), scaling into each signal and back out again:
//   - ENTRY is a three-slice ladder: one market buy now, two limit buys resting 0.4% and
//     0.8% lower. Averaging down is what makes this profitable after fees — see the
//     TRANCHES block below for the numbers.
//   - EXIT is split: half the filled size at +0.6%, the rest at +1.6%, both as resting
//     reduce-only limit sells placed per tranche as that tranche fills.
//   - the STOP is a single fixed level 2.0% under the FIRST entry, carried as
//     presetStopLossPrice on every tranche buy, so Bitget's own engine closes the position
//     at that price even if this process is offline. That is the one guarantee this script
//     does not manage itself.
//   - candles come from Bitget itself, not Binance, so the signal source matches the
//     venue we actually trade on.
//   - the exchange is always the source of truth: each tick reads the real position,
//     notices tranche fills, and reconciles the local JSON to match. When the position is
//     flat, every leftover resting order is cancelled — an unfilled tranche buy left on
//     the book would otherwise re-open a position with no signal behind it.
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
// Scale in / scale out. Replaced the old single-entry +-8%-of-margin (+-0.80% price) setup
// after that was shown to have no edge once real fees were counted: the round-trip fee
// measured off the Bitget ledger is 0.080% of notional, which ate 10% of every 0.80%
// target. Breakeven win rate was 56.9% and the strategy delivered exactly 55.0%.
//
// This ladder instead buys in three slices as price dips, then sells half at a near target
// and half at a far one. On the same 150-day data, with the same real fee applied:
//   single entry  : 120 trades, 55.0% win, 100 -> 70.6, max drawdown 74%
//   this ladder    :  79 trades, 67.1% win, 100 -> 178.2, max drawdown 36%
//   (in-sample 137.6 / out-of-sample 126.1 — profitable in both halves, and 119.6 on
//    Bitget's own candles over the 31 days they publish)
// Re-run scratchpad/scale_stress.js before changing any of these numbers.
const TRANCHES = 3;
const TRANCHE_STEP_PCT = 0.004; // each further slice rests 0.4% below the first entry
const TP1_PCT = 0.006; // half the filled size exits here
const TP2_PCT = 0.016; // the rest exits here
const STOP_PCT = 0.020; // measured from the FIRST entry and never moved, so the level is
                        // known up front and every tranche can carry the same stop
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
  // TP/SL are estimated off the position's own average price using this bot's ladder
  // percentages — we don't know which tranche(s) this position came from in this recovery
  // path, so `trancheSize` is deliberately left unset: manageOpenPosition() skips
  // positions it can't attribute to a ladder rather than guessing and placing exits for a
  // size it doesn't understand. Whatever exits/stop the original ladder left on the book
  // are still live on the exchange.
  state.openPosition = {
    pattern: "recovered",
    score: 0,
    leverage: position.leverage || LEVERAGE,
    size: position.marginSize,
    entryTime: Date.now(),
    entryPrice: position.openPriceAvg,
    takeProfit: position.openPriceAvg * (1 + TP1_PCT),
    takeProfit2: position.openPriceAvg * (1 + TP2_PCT),
    stopLoss: position.openPriceAvg * (1 - STOP_PCT),
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
async function reconcilePosition(config, state, contract, reports) {
  const position = await bitget.getSinglePosition(config);

  if (position && !state.openPosition) {
    adoptUntrackedPosition(state, position);
    return;
  }
  if (position) {
    // Still open — the only thing to do is notice tranche fills and give each one its
    // own exits.
    if (contract) await manageOpenPosition(config, contract, state, position);
    return;
  }
  // Flat on the exchange. Whatever is still resting on the book belongs to a ladder that
  // is now over — an unfilled tranche buy left behind would quietly re-open a position
  // with no signal behind it, so clear the book before anything else.
  await bitget.cancelAllOrders(config).catch((error) => log("WARN: could not clear leftover orders:", error.message));
  if (!state.openPosition) return; // idle tick, no position on either side

  const opened = state.openPosition;
  // A small negative buffer covers clock skew between this process and Bitget's server —
  // the entry order itself should always be inside [entryTime - buffer, now].
  const history = await bitget.getHistoryOrders(config, { startTime: opened.entryTime - 60_000 }).catch(() => []);
  // The ladder can close in TWO reduce-only fills (TP1 half, TP2 half), and anything else
  // that happens to sell on this account afterward — a manual close, a diagnostic script,
  // whatever — also matches this same filter and lands in the same history window. Taking
  // just history.find()'s first match is wrong on both counts: it can grab one leg of a
  // real two-part exit instead of blending them, and it has no way to tell a genuine
  // closing fill apart from unrelated later activity. Sorting oldest-first and stopping
  // once the closed size reaches what was actually entered fixes both — confirmed against
  // a real mix-up where a manual close followed shortly by an unrelated sell on the same
  // account got recorded as the trade's exit instead of the real one.
  const closingCandidates = history
    // Keyed on actual filled volume rather than status: a limit exit that partly filled
    // and was then cancelled still closed part of the position and still belongs in the
    // average, but its status reads "cancelled", not "filled".
    .filter(
      (order) =>
        Number(order.baseVolume ?? order.size ?? 0) > 0 &&
        (order.tradeSide === "close" || order.reduceOnly === "YES" || order.side === "sell"),
    )
    .sort((a, b) => Number(a.uTime ?? a.cTime) - Number(b.uTime ?? b.cTime));

  const expectedSize = opened.trancheSize != null ? Number(opened.trancheSize) * (opened.tranchesFilled ?? 1) : null;
  const closingOrders = [];
  let closedSize = 0;
  for (const order of closingCandidates) {
    if (expectedSize != null && closedSize >= expectedSize - 1e-9) break; // rest belongs to something else
    closingOrders.push(order);
    closedSize += Number(order.baseVolume ?? order.size ?? 0);
  }
  // Legacy (pre-ladder) positions never set trancheSize, so expectedSize is unknown —
  // fall back to the single-order behavior this replaced rather than guessing a size.
  if (expectedSize == null && closingOrders.length > 1) closingOrders.length = 1;
  const closingOrder = closingOrders.at(-1); // for exitOrderId/exitTime below

  const account = await bitget.getAccount(config);
  let exitPrice;
  let exitReason;

  if (closingOrders.length) {
    // Size-weighted average across every leg that closed this position.
    let weightedSum = 0;
    let totalSize = 0;
    for (const order of closingOrders) {
      const size = Number(order.baseVolume ?? order.size ?? 0);
      weightedSum += size * Number(order.priceAvg ?? order.price ?? 0);
      totalSize += size;
    }
    exitPrice = totalSize > 0 ? weightedSum / totalSize : Number(closingOrder.priceAvg ?? closingOrder.price);
    // A real TP/SL trigger fill lands within a hair of the exact preset price. Only
    // trust "closer to TP than SL" as a real take-profit when it's actually close to TP
    // in absolute terms — otherwise (e.g. a manual close somewhere near entry) that
    // proximity comparison can mislabel a losing trade as "take-profit" just because it
    // happened to be numerically nearer the target than the stop. Fall back to the
    // sign of the actual price move, which can never contradict the P&L shown next to it.
    const nearTakeProfit = Math.abs(exitPrice - opened.takeProfit) / opened.takeProfit < 0.001;
    const nearStopLoss = opened.stopLoss != null && Math.abs(exitPrice - opened.stopLoss) / opened.stopLoss < 0.001;
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
  closeReport(reports, opened.entryTime, { exitTime, exitPrice, exitReason, pnlPct, entryPrice: opened.entryPrice });

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

// Places one tranche's own pair of exits: half of that tranche at the near target, half
// at the far one. Doing it per tranche (rather than resizing one shared pair every time
// the position grows) means the totals always land on "half the filled size at each
// target" without ever cancelling and re-placing a live order.
async function placeTrancheExits(config, contract, trancheSize, tp1, tp2, signalTime, trancheNumber) {
  const half = bitget.roundSize(Number(trancheSize) / 2, contract);
  // roundSize() rounds UP to the contract minimum, so on a very small tranche "half" can
  // come back as the whole thing — two of those would exceed the position and the exchange
  // rejects the second (seen for real on a minimum-size rehearsal). Fall back to one
  // order at the near target, which is the leg most likely to fill anyway.
  const exits =
    Number(half) * 2 > Number(trancheSize)
      ? [[tp1, "tp1", trancheSize]]
      : [
          [tp1, "tp1", half],
          [tp2, "tp2", half],
        ];
  for (const [price, tag, size] of exits) {
    await bitget
      .placeOrder(config, {
        side: "sell",
        size,
        price: price.toFixed(1),
        reduceOnly: true,
        clientOid: `live-${signalTime}-t${trancheNumber}-${tag}`,
      })
      .catch((error) => log(`WARN: tranche ${trancheNumber} ${tag} exit order failed:`, error.message));
  }
}

// Watches a live ladder: when a resting tranche buy fills, the exchange position grows, so
// that tranche's own exits get placed. The exchange's position size is the source of truth
// — comparing it against tranchesFilled is what detects the fill, so a fill that happened
// while this process was down is still picked up on the next tick.
async function manageOpenPosition(config, contract, state, position) {
  const opened = state.openPosition;
  if (!opened || !opened.trancheSize) return; // pre-ladder position (e.g. "recovered") — nothing to manage

  // Keep the average entry in sync with reality; every P&L number downstream uses it.
  if (position.openPriceAvg) opened.entryPrice = position.openPriceAvg;

  // Once any exit has fired, stop adding. The backtest this ladder is modelled on only
  // fills tranches while nothing has been taken off yet; leaving the resting limit buys up
  // would let the position re-grow at a worse average against an unchanged stop, which is
  // strictly more risk than was tested. A shrink below the high-water size is the tell.
  const size = Number(position.total);
  opened.peakSize = Math.max(opened.peakSize ?? size, size);
  if (size < opened.peakSize - Number(opened.trancheSize) * 0.1 && !opened.addsClosed) {
    const cancelled = await bitget.cancelEntryOrders(config).catch((error) => {
      log("WARN: could not cancel remaining tranche buys:", error.message);
      return 0;
    });
    opened.addsClosed = true;
    log(`Partial exit detected (size ${size} < peak ${opened.peakSize}) — cancelled ${cancelled} unfilled tranche buy(s).`);
  }

  const filledNow = Math.min(TRANCHES, Math.round(size / Number(opened.trancheSize)));
  if (filledNow <= (opened.tranchesFilled ?? 1)) return;

  const tp1 = opened.firstEntryPrice * (1 + TP1_PCT);
  const tp2 = opened.firstEntryPrice * (1 + TP2_PCT);
  for (let t = (opened.tranchesFilled ?? 1) + 1; t <= filledNow; t += 1) {
    log(`Tranche ${t}/${TRANCHES} filled (position now ${position.total}) — placing its exits.`);
    await placeTrancheExits(config, contract, opened.trancheSize, tp1, tp2, opened.signalCandleTime, t);
  }
  opened.tranchesFilled = filledNow;

  await notify(
    [
      `분할 추가매수 체결 (${filledNow}/${TRANCHES})`,
      `평단: $${Number(position.openPriceAvg).toLocaleString()}`,
      `보유수량: ${position.total}`,
      `익절: $${tp1.toFixed(1)} · $${tp2.toFixed(1)}`,
    ].join("\n"),
  );
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
  // Every level is measured off the FIRST entry and never recalculated, so the whole
  // ladder can be placed up front and left alone — the bot being briefly offline can't
  // strand a position without a stop.
  const stopLoss = price * (1 - STOP_PCT);
  const takeProfit1 = price * (1 + TP1_PCT);
  const takeProfit2 = price * (1 + TP2_PCT);
  const trancheSize = bitget.roundSize((marginUsdt * LEVERAGE) / price / TRANCHES, contract);

  // roundSize() always rounds UP to the contract's minimum, even when the resolved
  // margin implies a much smaller size — on a small/depleted balance this would silently
  // ask for more margin than we actually have. Bitget would reject it anyway, but doing
  // that on every 30s tick until the candle rolls over just spams rejected live orders.
  // Skip cleanly instead and wait for the next signal. Checked against the FULL ladder,
  // since all three tranches can fill.
  const impliedMargin = (Number(trancheSize) * TRANCHES * price) / LEVERAGE;
  if (impliedMargin > marginUsdt * 1.05) {
    log(
      `WARN: skipping entry — exchange minimum order size needs ~$${impliedMargin.toFixed(2)} margin for the full ladder, ` +
        `only $${marginUsdt.toFixed(2)} available.`,
    );
    return;
  }

  log(
    `Signal: ${latest.pattern} score=${latest.score} price=${price} margin=${marginUsdt.toFixed(2)} ` +
      `tranche=${trancheSize} x${TRANCHES} — placing ladder...`,
  );

  // Tranche 1 goes in at market, carrying the stop. Bitget treats presetStopLossPrice as a
  // position-level trigger in one-way mode, and every later tranche repeats the same price,
  // so the stop covers whatever size ends up filled.
  const order = await bitget.placeOrder(config, {
    side: "buy",
    size: trancheSize,
    presetStopLossPrice: stopLoss.toFixed(1),
    clientOid: `live-${latestCandle.time}`,
  });

  // Give the market order a moment to fill before reading back the real entry price.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  const detail = await bitget.getOrderDetail(config, { orderId: order.orderId }).catch(() => null);
  const entryPrice = (detail && Number(detail.priceAvg || detail.price)) || price;
  const entryTime = (detail && Number(detail.cTime)) || Date.now();

  // Remaining tranches rest on the book as limit buys so they fill at the exact ladder
  // price even between 30s polls, matching what the backtest assumed.
  for (let t = 1; t < TRANCHES; t += 1) {
    const level = price * (1 - TRANCHE_STEP_PCT * t);
    await bitget
      .placeOrder(config, {
        side: "buy",
        size: trancheSize,
        price: level.toFixed(1),
        presetStopLossPrice: stopLoss.toFixed(1),
        clientOid: `live-${latestCandle.time}-t${t + 1}`,
      })
      .catch((error) => log(`WARN: tranche ${t + 1} limit order failed (ladder continues):`, error.message));
  }

  // Tranche 1's own exits. Each tranche gets its own pair (half near, half far) as it
  // fills, so the totals always come out to half the filled size at each target without
  // ever having to cancel and re-size anything.
  await placeTrancheExits(config, contract, trancheSize, takeProfit1, takeProfit2, latestCandle.time, 1);

  state.openPosition = {
    pattern: latest.pattern,
    score: latest.score,
    leverage: LEVERAGE,
    size: marginUsdt,
    entryTime,
    entryPrice, // average entry — refreshed from the exchange as tranches fill
    firstEntryPrice: entryPrice,
    trancheSize,
    tranchesFilled: 1,
    signalCandleTime: latestCandle.time,
    takeProfit: takeProfit1, // kept under the old names so the dashboard keeps rendering
    takeProfit2,
    stopLoss,
    orderId: order.orderId,
  };

  log(
    `Entered LONG tranche 1/${TRANCHES} @ ${entryPrice} (orderId ${order.orderId}) — ` +
      `adds at ${(price * (1 - TRANCHE_STEP_PCT)).toFixed(1)} / ${(price * (1 - TRANCHE_STEP_PCT * 2)).toFixed(1)}, ` +
      `TP ${takeProfit1.toFixed(1)} & ${takeProfit2.toFixed(1)}, SL ${stopLoss.toFixed(1)}`,
  );

  const snapshotCandles = closedCandles.slice(-CHART_SNAPSHOT_CANDLES);
  const chartSvg = renderCandleSnapshot({
    candles: snapshotCandles,
    title: `BTCUSDT 15m · ${new Date(entryTime).toLocaleString("ko-KR")}`,
    markers: [{ index: snapshotCandles.length - 1, color: "#f472b6", label: "B" }],
    lines: [
      { price: takeProfit2, color: "#4ade80", label: `TP2 ${takeProfit2.toFixed(1)}` },
      { price: takeProfit1, color: "#86efac", label: `TP1 ${takeProfit1.toFixed(1)}` },
      { price: price * (1 - TRANCHE_STEP_PCT), color: "#94a3b8", label: "추가2" },
      { price: price * (1 - TRANCHE_STEP_PCT * 2), color: "#94a3b8", label: "추가3" },
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
      "실전 포지션 진입 (분할 1/3)",
      `패턴: ${signalTitle(latest.pattern)} (${latest.score.toFixed(0)}점)`,
      `진입가: $${entryPrice.toLocaleString()}`,
      `증거금: $${marginUsdt.toFixed(2)} · ${LEVERAGE}x (3분할)`,
      `추가매수: $${(price * (1 - TRANCHE_STEP_PCT)).toFixed(1)} / $${(price * (1 - TRANCHE_STEP_PCT * 2)).toFixed(1)}`,
      `익절: $${takeProfit1.toFixed(1)}(절반) · $${takeProfit2.toFixed(1)}(절반)`,
      `손절: $${stopLoss.toFixed(1)}`,
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

  // Fetched before reconciling now — managing a live ladder needs the contract's size
  // rounding to place each tranche's exits.
  if (!contractConfigCache) {
    contractConfigCache = await bitget.getContractConfig(config);
  }

  await reconcilePosition(config, state, contractConfigCache, reports);

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
async function reconcileOnStartup(config, state, contract, reports) {
  const stateBefore = JSON.stringify(state);
  const reportsBefore = JSON.stringify(reports);
  await reconcilePosition(config, state, contract, reports);
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
  contractConfigCache = await bitget.getContractConfig(config);
  await reconcileOnStartup(config, state, contractConfigCache, reports);

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
