// Paper-trading simulation for the ICT (Liquidity Sweep -> MSS -> FVG) strategy —
// scripts/lib/ict-signals.js. Mirrors scripts/paper-trade.js's shape (single-run script
// meant for a GitHub Actions cron, not a persistent process) but is otherwise a fresh,
// separate simulation: its own $100 starting balance, its own state file
// (data/paper-trades-ict.json), and its own entry/exit rules.
//
// NOT connected to scripts/live-trade.js or the real Bitget account — this never places
// real orders. Purely for watching how the ICT signal set performs against live market
// data before anyone considers trading it for real. See docs/ict-strategy.md.
//
// Rules (from the 150-day/15m backtest — see conversation history / git log):
//   - LONG only. SHORT looked bad over the backtested window, and was very likely just
//     riding that window's uptrend rather than a real directional edge either way — no
//     reason to paper-trade the side that already lost money in testing.
//   - Stop-loss at the signal's own sweepPrice (the liquidity sweep's extreme) — if that
//     level breaks again, the reversal thesis was wrong. This is the ICT-native stop,
//     not an arbitrary fixed %.
//   - Take-profit at a fixed 2R (twice the entry-to-stop distance) — R=2 had the best
//     combination of win rate, trade count, and consistency across the R-multiples
//     tried (1, 1.5, 2, 3, 4).

const fs = require("fs");
const path = require("path");
const { detectICTSignals } = require("./lib/ict-signals");

const CANDLE_GRANULARITY = "15m";
const CANDLE_LIMIT = 200;
const LEVERAGE = 10;
const R_MULTIPLE = 2;
const STARTING_BALANCE = 100;
const STATE_PATH = path.join(__dirname, "..", "data", "paper-trades-ict.json");

function toCandle(row) {
  return { time: row[0], open: Number(row[1]), high: Number(row[2]), low: Number(row[3]), close: Number(row[4]), volume: Number(row[5]) };
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return {
      mode: "paper",
      strategy: "ict-fvg",
      startingBalance: STARTING_BALANCE,
      currentBalance: STARTING_BALANCE,
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

// Same idea as paper-trade.js's resumeIndex(): pick up right after whatever candle the
// persisted state last reflects, so re-running this script never re-simulates the same
// history twice. detectICTSignals() needs more warmup than detectSignals() did (liquidity
// sweep search looks back up to 40 candles), so the pre-first-trade fallback needs a
// larger floor.
const WARMUP_CANDLES = 50;

function resumeIndex(closedCandles, state) {
  const watermark = state.openPosition
    ? state.openPosition.entryTime
    : state.trades.length
      ? state.trades[state.trades.length - 1].exitTime
      : (state.startedAt ?? null);

  if (watermark == null) return WARMUP_CANDLES;

  const idx = closedCandles.findIndex((candle) => candle.time > watermark);
  return idx === -1 ? closedCandles.length : Math.max(idx, WARMUP_CANDLES);
}

function simulate(closedCandles, state) {
  // detectICTSignals() needs the whole series for its swing/structure computation
  // (it isn't index-incremental like detectSignals()), so run it once up front and index
  // into the result exactly like paper-trade.js does with its own event map.
  const signals = detectICTSignals(closedCandles).filter((s) => s.direction === "LONG");
  const signalByIndex = new Map(signals.map((s) => [s.index, s]));
  const startIndex = resumeIndex(closedCandles, state);

  for (let index = startIndex; index < closedCandles.length; index += 1) {
    const candle = closedCandles[index];

    if (state.openPosition) {
      const position = state.openPosition;
      const hitStop = candle.low <= position.stopLoss;
      const hitTarget = candle.high >= position.takeProfit;

      // Can't know which was touched first intra-candle without tick data — assume the
      // worse outcome (stop-loss first), same convention as paper-trade.js.
      if (hitStop || hitTarget) {
        const exitReason = hitStop ? "stop-loss" : "take-profit";
        const exitPrice = hitStop ? position.stopLoss : position.takeProfit;
        const priceMovePct = (exitPrice - position.entryPrice) / position.entryPrice;
        const accountPnlPct = priceMovePct * position.leverage;
        const balanceBefore = state.currentBalance;
        const balanceAfter = balanceBefore * (1 + accountPnlPct);

        state.trades.push({
          pattern: position.pattern,
          mssType: position.mssType,
          leverage: position.leverage,
          entryTime: position.entryTime,
          entryPrice: position.entryPrice,
          exitTime: candle.time,
          exitPrice,
          exitReason,
          pnlPct: accountPnlPct * 100,
          balanceBefore,
          balanceAfter,
        });
        state.currentBalance = balanceAfter;
        state.openPosition = null;
      }
    }

    if (!state.openPosition) {
      const signal = signalByIndex.get(index);
      if (signal) {
        const entryPrice = candle.close;
        const stopLoss = signal.sweepPrice;
        const risk = Math.abs(entryPrice - stopLoss);
        // A zero/negative risk means the sweep price is at or above entry — shouldn't
        // happen for a real LONG signal, but skip defensively rather than open a
        // nonsensical position.
        if (risk > 0) {
          state.openPosition = {
            pattern: "ict-fvg",
            mssType: signal.mssType,
            leverage: LEVERAGE,
            size: state.currentBalance,
            entryTime: candle.time,
            entryPrice,
            stopLoss,
            takeProfit: entryPrice + risk * R_MULTIPLE,
          };
        }
      }
    }
  }

  return state;
}

async function main() {
  const response = await fetch(
    `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${CANDLE_GRANULARITY}&limit=${CANDLE_LIMIT}`,
  );
  if (!response.ok) {
    throw new Error(`Binance request failed: ${response.status}`);
  }

  const candles = (await response.json()).map(toCandle);
  const closedCandles = candles.slice(0, -1);

  const before = loadState();
  const beforeJson = JSON.stringify(before);
  const after = simulate(closedCandles, before);

  if (JSON.stringify(after) === beforeJson) {
    console.log("No new trade activity — state unchanged.");
    return;
  }

  saveState(after);
  console.log(
    `State updated. Balance: $${after.currentBalance.toFixed(2)} | Trades: ${after.trades.length} | Open: ${
      after.openPosition ? after.openPosition.pattern : "none"
    }`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
