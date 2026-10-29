// Runs continuously on the user's own always-on PC (NOT GitHub Actions — see the note
// below). Places real Bitget orders off scripts/lib/climax-signals.js — chapter 1 of the
// strategy PDF ("마지막 봉이 가장 길 때"): buy the capitulation candle of a panic sell-off.
//   - ENTRY is one market buy at the close of a 15m candle that sits 3%+ under the last 5h
//     high on 3x+ average volume (the biggest of the last 20 candles).
//   - SIZE follows how deep the panic went: 1/3, 2/3 or all of the max position for a
//     3%/4%/5%+ drop (sizeTier()). Max position = ~95% of available balance at 10x.
//   - EXIT is time-based: the rebound this bets on comes within the hour, so the bot
//     market-sells the whole position at the close of the 4th candle after the signal.
//   - the STOP is a fixed 3% under the signal close, carried as presetStopLossPrice on the
//     entry, so Bitget's own engine closes the position at that price even if this process
//     is offline (the time exit then happens late, on restart).
//   - candles come from Bitget itself, so the signal source matches the venue we trade on.
//   - the exchange is always the source of truth: each tick reads the real position and
//     reconciles the local JSON to match. When flat, every leftover resting order is
//     cancelled.
//
// This replaced a double-bottom ladder (3 averaging-down tranches, TP 0.6%/1.6%, stop 2%)
// that a 2-year backtest showed losing ~1% of the account per trade — its signals had no
// more edge than a random long. The ladder-management code below stays for positions the
// old strategy opened (manageOpenPosition() still finishes them the old way).
//
// This script is intentionally NOT wired into .github/workflows/*.yml. It needs a real
// API key with trade permission, and CI runner IPs are unpredictable (can't be
// allow-listed on the Bitget key) — this must only ever run from a machine you control.
// Run it locally: `pnpm live-trade` (see .env.example for required vars).

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { signalTitle, signalReasons } = require("./lib/signals");
const { detectPanicClimax, sizeTier } = require("./lib/climax-signals");
const bitget = require("./lib/bitget-client");
const { sendTelegram } = require("./lib/telegram");
const { renderCandleSnapshot } = require("./lib/chart-snapshot");
const { loadReports, saveReports, openReport, closeReport, updateReportPartials } = require("./lib/trade-reports");

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
// Panic-climax trade. Backtest (2y Bitget 15m, 61 trades, fees in): 1h hold + 3% stop came
// out positive in both halves; a take-profit, tighter stops and 2h+ holds did not hold up
// across both halves and both venues. Re-run the scratchpad climax-*.js scripts before
// changing these.
const CLIMAX_STOP_PCT = 0.03;
const CLIMAX_HOLD_CANDLES = 4; // exit at the close of the 4th candle after the signal
const CANDLE_MS = 15 * 60_000;
// Old double-bottom ladder — only still used to finish (and adopt) positions it opened.
const TRANCHES = 3;
const TP1_PCT = 0.006;
const TP2_PCT = 0.016;
const STOP_PCT = 0.020;
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
    if (contract) await manageOpenPosition(config, contract, state, position, reports);
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

  const expectedSize =
    opened.positionSize != null
      ? Number(opened.positionSize)
      : opened.trancheSize != null
        ? Number(opened.trancheSize) * (opened.tranchesFilled ?? 1)
        : null;
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

  // The ladder's own average entry, from its own entry fills (clientOid live-<signalTime>,
  // -t2, -t3; the exits share the prefix but are reduce-only). opened.entryPrice tracks the
  // exchange's position average while open, and that stops meaning "this ladder" the moment
  // anything else trades the account — a manual buy on top of a live ladder moved it from
  // 78,137 to 77,044 for real. The bot's own fills can't be polluted that way.
  {
    let weighted = 0;
    let total = 0;
    for (const o of history) {
      const ownEntry =
        opened.signalCandleTime != null &&
        String(o.clientOid ?? "").startsWith(`live-${opened.signalCandleTime}`) &&
        o.reduceOnly !== "YES";
      const size = Number(o.baseVolume ?? 0);
      const price = Number(o.priceAvg ?? 0);
      if (ownEntry && size > 0 && price > 0) {
        weighted += size * price;
        total += size;
      }
    }
    if (total > 0) opened.entryPrice = weighted / total;
  }

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
    exitPrice = exitReason === "take-profit" ? (opened.takeProfit ?? opened.entryPrice) : opened.stopLoss;
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
    // currentBalance already moved mid-trade if an exit leg filled early (recordPartialExits)
    balanceBefore: opened.balanceBefore ?? state.currentBalance,
    balanceAfter: account.equity,
    orderId: opened.orderId,
    exitOrderId: closingOrder?.orderId,
    // Bot-side time exit (panic-climax) — exitReason above still says which side of entry
    // it closed on, which is what the dashboard's win/loss count reads.
    ...(opened.timeExitSent ? { exitKind: "time-exit" } : {}),
  });

  state.currentBalance = account.equity;
  state.openPosition = null;
  log(`Position closed: ${exitReason} @ ${exitPrice} (pnl ${pnlPct.toFixed(2)}%)`);

  // No matching open report for a "recovered" position (see adoptUntrackedPosition — it
  // never had a report opened for it in the first place) — closeReport() no-ops safely.
  closeReport(reports, opened.entryTime, { exitTime, exitPrice, exitReason, pnlPct, entryPrice: opened.entryPrice });

  await notify(
    [
      opened.timeExitSent
        ? `실전 포지션 시간 청산 (${exitReason === "take-profit" ? "수익" : "손실"})`
        : exitReason === "take-profit"
          ? "실전 포지션 익절 종료"
          : "실전 포지션 손절 종료",
      `패턴: ${signalTitle(opened.pattern)}`,
      `진입가: $${opened.entryPrice.toLocaleString()} → 청산가: $${exitPrice.toLocaleString()}`,
      `손익: ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`,
      `잔고: $${account.equity.toFixed(2)}`,
      `시간: ${new Date(exitTime).toLocaleString("ko-KR")}`,
    ].join("\n"),
  );
}

// The MAXIMUM margin a trade may commit; maybeEnter() takes 1/3, 2/3 or all of it by
// sizeTier(). BITGET_MARGIN_USDT unset/"full" (config.marginUsdt === null) means "use
// whatever the account currently has" — a 5% haircut avoids order rejection from
// fees/rounding eating into the last few cents. A configured fixed amount is still capped
// at the real available balance so a stale/optimistic env value can't over-commit.
async function resolveMarginUsdt(config) {
  const account = await bitget.getAccount(config);
  if (config.marginUsdt != null) return Math.min(config.marginUsdt, account.available);
  return Math.max(account.available * 0.95, 0);
}

// Panic-climax positions have no take-profit: once exitAt passes, sell the whole position
// at market. Retried every tick while the position is still there (a rejected/failed close
// just tries again 30s later); reduce-only means a duplicate can never open a short.
async function closeOnTimeExit(config, opened, position) {
  if (Date.now() < opened.exitAt) return;
  log(`Time exit due (${new Date(opened.exitAt).toISOString()}) — selling ${position.total} at market.`);
  try {
    await bitget.placeOrder(config, {
      side: "sell",
      size: String(position.total),
      reduceOnly: true,
      clientOid: `live-${opened.signalCandleTime}-exit-${Date.now()}`,
    });
    opened.timeExitSent = true;
  } catch (error) {
    log("WARN: time-exit market sell failed, retrying next tick:", error.message);
  }
}

// Places one tranche's own pair of exits: half of that tranche at the near target, half
// at the far one. Doing it per tranche (rather than resizing one shared pair every time
// the position grows) means the totals always land on "half the filled size at each
// target" without ever cancelling and re-placing a live order.
async function placeTrancheExits(config, contract, trancheSize, tp1, tp2, signalTime, trancheNumber) {
  const half = bitget.roundSize(Number(trancheSize) / 2, contract);
  // The far leg takes whatever the near leg didn't, NOT a second copy of `half`. roundSize()
  // floors, so two equal "halves" of an odd-lot tranche sum to less than the tranche —
  // 0.0042 split as 0.002 + 0.002 left 0.0002 per tranche unsold. That dust kept the
  // position open after every exit had filled, so the bot never recorded the trade and
  // stayed blocked from new entries (hit for real on the ICT bot, same code shape here).
  const rest = (Number(trancheSize) - Number(half)).toFixed(contract.volumePlace);
  // roundSize() also rounds UP to the contract minimum, so on a very small tranche "half"
  // can come back as the whole thing — fall back to one order at the near target.
  const exits =
    Number(half) * 2 > Number(trancheSize)
      ? [[tp1, "tp1", trancheSize]]
      : [
          [tp1, "tp1", half],
          [tp2, "tp2", rest],
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
// Records the ladder's exit legs that have filled while the position is still open (TP1
// before TP2). A trade is only written to state.trades once the position is flat, so
// without this a real TP1 fill left no trace anywhere on the dashboard. Only this ladder's
// own reduce-only fills (clientOid live-<signalTime>-tN-tp1/tp2) count — manual trades on
// the same account don't. Returns false if order history couldn't be read, so the caller
// retries next tick instead of marking the shrink as handled.
async function recordPartialExits(config, state, opened, position, reports) {
  const history = await bitget.getHistoryOrders(config, { startTime: opened.entryTime - 60_000 }).catch(() => null);
  if (!history) return false;
  const exits = history
    .filter(
      (o) =>
        String(o.clientOid ?? "").startsWith(`live-${opened.signalCandleTime}-`) &&
        o.reduceOnly === "YES" &&
        Number(o.baseVolume ?? 0) > 0,
    )
    .sort((a, b) => Number(a.uTime ?? a.cTime) - Number(b.uTime ?? b.cTime))
    .map((o) => ({
      time: Number(o.uTime ?? o.cTime),
      price: Number(o.priceAvg),
      size: Number(o.baseVolume),
      tag: String(o.clientOid).split("-").at(-1), // "tp1" | "tp2"
      pnlUsdt: Number(o.totalProfits ?? 0) + Number(o.fee ?? 0), // fee is negative
    }));
  const known = opened.partialExits?.length ?? 0;
  if (exits.length <= known) return true; // shrank for some other reason (e.g. a manual sell)

  // Balance before the trade, kept for the final trade record — currentBalance moves below.
  if (opened.balanceBefore == null) opened.balanceBefore = state.currentBalance;
  opened.partialExits = exits;
  opened.realizedPnlUsdt = exits.reduce((sum, e) => sum + e.pnlUsdt, 0);
  const account = await bitget.getAccount(config).catch(() => null);
  // Realized balance: equity minus what the still-open remainder is floating.
  if (account) state.currentBalance = account.equity - (position.unrealizedPL || 0);
  updateReportPartials(reports, opened.entryTime, exits, opened.realizedPnlUsdt);

  for (const e of exits.slice(known)) {
    log(`Partial exit ${e.tag}: ${e.size} @ ${e.price} (${e.pnlUsdt >= 0 ? "+" : ""}${e.pnlUsdt.toFixed(4)} USDT)`);
    await notify(
      [
        `분할 익절 체결 (${e.tag === "tp1" ? "1차" : "2차"})`,
        `수량: ${e.size} BTC @ $${e.price.toLocaleString()}`,
        `실현손익: ${e.pnlUsdt >= 0 ? "+" : ""}$${e.pnlUsdt.toFixed(2)} (수수료 포함)`,
        `잔여: ${position.total} BTC · 손절 $${opened.stopLoss.toFixed(1)} 유지`,
      ].join("\n"),
    );
  }
  return true;
}

async function manageOpenPosition(config, contract, state, position, reports) {
  const opened = state.openPosition;
  if (opened?.exitAt != null) return closeOnTimeExit(config, opened, position);
  // Everything below is the old double-bottom ladder's management, kept only to finish
  // positions it opened.
  if (!opened || !opened.trancheSize) return; // pre-ladder position (e.g. "recovered") — nothing to manage

  // Keep the average entry in sync with reality; every P&L number downstream uses it.
  if (position.openPriceAvg) opened.entryPrice = position.openPriceAvg;

  const size = Number(position.total);
  // Size seen on the previous tick; a drop means an exit leg filled in between.
  const lastSize = opened.lastSize ?? opened.peakSize ?? size;
  if (size < lastSize - 1e-9) {
    if (await recordPartialExits(config, state, opened, position, reports)) opened.lastSize = size;
  } else {
    opened.lastSize = size;
  }

  // Once any exit has fired, stop adding. The backtest this ladder is modelled on only
  // fills tranches while nothing has been taken off yet; leaving the resting limit buys up
  // would let the position re-grow at a worse average against an unchanged stop, which is
  // strictly more risk than was tested. A shrink below the high-water size is the tell.
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
// what detectPanicClimax() already computed for this signal — no new reasoning invented
// here, just the signal's own detail plus the pattern's bullet reasons (signalReasons()).
function buildReasonText(signal, tier) {
  const lines = [`패턴: ${signalTitle(signal.pattern)} (급락 ${(signal.drop * 100).toFixed(1)}%)`, signal.detail];
  const reasons = signalReasons(signal.pattern);
  if (reasons.length) lines.push(...reasons.map((reason) => `- ${reason}`));
  lines.push(`비중: 최대 포지션의 ${tier}/3 (급락 3%대 1/3 · 4%대 2/3 · 5% 이상 전부)`);
  return lines.join("\n");
}

async function maybeEnter(config, contract, state, closedCandles, signals, reports) {
  if (state.openPosition) return;

  const latestCandle = closedCandles[closedCandles.length - 1];
  const latest = signals.at(-1);
  if (!latest || !latestCandle || latest.index !== closedCandles.length - 1) return; // no signal on the freshest closed candle

  const watermark = resumeWatermark(state);
  if (watermark != null && latestCandle.time <= watermark) return; // already acted on this candle (or an earlier one)

  const capUsdt = await resolveMarginUsdt(config);
  if (capUsdt <= 0) {
    log("WARN: no available balance to open a position with — skipping this signal.");
    return;
  }
  const tier = sizeTier(latest.drop);
  const marginUsdt = (capUsdt * tier) / 3;

  const price = latestCandle.close;
  const stopLoss = price * (1 - CLIMAX_STOP_PCT);
  // Close of the CLIMAX_HOLD_CANDLES-th candle after the signal one (whose own close is
  // latestCandle.time + CANDLE_MS).
  const exitAt = latestCandle.time + CANDLE_MS * (1 + CLIMAX_HOLD_CANDLES);
  const size = bitget.roundSize((marginUsdt * LEVERAGE) / price, contract);

  // roundSize() always rounds UP to the contract's minimum, even when the resolved margin
  // implies a much smaller size — on a depleted balance this would ask for more margin than
  // we have, and Bitget would reject it on every 30s tick until the candle rolls over.
  const impliedMargin = (Number(size) * price) / LEVERAGE;
  if (impliedMargin > capUsdt * 1.05) {
    log(
      `WARN: skipping entry — exchange minimum order size needs ~$${impliedMargin.toFixed(2)} margin, ` +
        `only $${capUsdt.toFixed(2)} available.`,
    );
    return;
  }

  log(
    `Signal: panic-climax drop=${(latest.drop * 100).toFixed(2)}% vol=${latest.volumeRatio.toFixed(1)}x price=${price} ` +
      `tier=${tier}/3 margin=${marginUsdt.toFixed(2)} size=${size} — buying at market...`,
  );

  const order = await bitget.placeOrder(config, {
    side: "buy",
    size,
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
    positionSize: size,
    sizeTier: tier,
    drop: latest.drop,
    signalCandleTime: latestCandle.time,
    takeProfit: null, // no target — exitAt closes it
    exitAt,
    stopLoss,
    orderId: order.orderId,
  };

  const exitClock = new Date(exitAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  log(`Entered LONG ${size} @ ${entryPrice} (orderId ${order.orderId}) — SL ${stopLoss.toFixed(1)}, time exit ${new Date(exitAt).toISOString()}`);

  const snapshotCandles = closedCandles.slice(-CHART_SNAPSHOT_CANDLES);
  const chartSvg = renderCandleSnapshot({
    candles: snapshotCandles,
    title: `BTCUSDT 15m · ${new Date(entryTime).toLocaleString("ko-KR")}`,
    markers: [{ index: snapshotCandles.length - 1, color: "#f472b6", label: "B" }],
    lines: [
      { price: latest.refHigh, color: "#94a3b8", label: `5h 고점 ${latest.refHigh.toFixed(1)}` },
      { price: stopLoss, color: "#f43f5e", label: `SL ${stopLoss.toFixed(1)}` },
    ],
  });

  openReport(reports, {
    id: `bitget-${entryTime}`,
    bot: "bitget",
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
      "실전 포지션 진입 (패닉 클라이맥스)",
      `급락: ${(latest.drop * 100).toFixed(1)}% · 거래량 평균의 ${latest.volumeRatio.toFixed(1)}배`,
      `진입가: $${entryPrice.toLocaleString()}`,
      `비중: ${tier}/3 · 증거금 $${marginUsdt.toFixed(2)} · ${LEVERAGE}x`,
      `청산: ${exitClock} 시장가 (1시간 보유)`,
      `손절: $${stopLoss.toFixed(1)} (-${(CLIMAX_STOP_PCT * 100).toFixed(0)}%)`,
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
  const signals = detectPanicClimax(closedCandles);

  // Fetched before reconciling now — managing a live ladder needs the contract's size
  // rounding to place each tranche's exits.
  if (!contractConfigCache) {
    contractConfigCache = await bitget.getContractConfig(config);
  }

  await reconcilePosition(config, state, contractConfigCache, reports);

  if (!state.openPosition) {
    await maybeEnter(config, contractConfigCache, state, closedCandles, signals, reports);
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
  const marginDesc =
    "1/3, 2/3 or all of " +
    (config.marginUsdt != null ? `${config.marginUsdt} USDT` : "~95% of available balance") +
    " by panic depth (panic-climax strategy)";
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
