// Runs on the same GitHub Actions schedule as the Telegram alert (see
// .github/workflows/telegram-alert.yml). Simulates a single-position paper-trading
// account: whenever a LONG signal scores >= ALERT_MIN_SCORE and no position is open,
// "buy" with the full current balance; exit at a fixed take-profit or stop-loss.
// Only committed to data/paper-trades.json when a position actually opens or closes,
// so idle runs don't spam the repo with commits (which would also redeploy GitHub Pages).

const fs = require("fs");
const path = require("path");
const { toCandle, detectSignals } = require("./lib/signals");

const CANDLE_LIMIT = 200;
const ALERT_MIN_SCORE = 85;
const TAKE_PROFIT_PCT = 0.015; // +1.5%
const STOP_LOSS_PCT = 0.008; // -0.8%
const STARTING_BALANCE = 10_000;
const STATE_PATH = path.join(__dirname, "..", "data", "paper-trades.json");

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return {
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

// Resume scanning right after whatever candle the persisted state last reflects —
// derived from the trade history itself instead of a separate stored watermark, so the
// file only changes (and only needs a commit) when a real open/close event happens.
// Before any trade has happened, fall back to `startedAt` rather than the full fetched
// window, so the very first run doesn't backfill trades from hours before it went live.
function resumeIndex(closedCandles, state) {
  const watermark = state.openPosition
    ? state.openPosition.entryTime
    : state.trades.length
      ? state.trades[state.trades.length - 1].exitTime
      : (state.startedAt ?? null);

  if (watermark == null) return 16; // detectSignals() needs a 16-candle warmup

  const idx = closedCandles.findIndex((candle) => candle.time > watermark);
  return idx === -1 ? closedCandles.length : Math.max(idx, 16);
}

function simulate(closedCandles, events, state) {
  const eventByIndex = new Map(events.map((event) => [event.index, event]));
  const startIndex = resumeIndex(closedCandles, state);

  for (let index = startIndex; index < closedCandles.length; index += 1) {
    const candle = closedCandles[index];

    if (state.openPosition) {
      const position = state.openPosition;
      const hitStop = candle.low <= position.stopLoss;
      const hitTarget = candle.high >= position.takeProfit;

      // If both levels fall inside the same candle we can't know which was touched
      // first without intra-candle data — assume the worse outcome (stop-loss first).
      if (hitStop || hitTarget) {
        const exitReason = hitStop ? "stop-loss" : "take-profit";
        const exitPrice = hitStop ? position.stopLoss : position.takeProfit;
        const pnlPct = (exitPrice - position.entryPrice) / position.entryPrice;
        const balanceBefore = state.currentBalance;
        const balanceAfter = balanceBefore * (1 + pnlPct);

        state.trades.push({
          pattern: position.pattern,
          score: position.score,
          entryTime: position.entryTime,
          entryPrice: position.entryPrice,
          exitTime: candle.time,
          exitPrice,
          exitReason,
          pnlPct: pnlPct * 100,
          balanceBefore,
          balanceAfter,
        });
        state.currentBalance = balanceAfter;
        state.openPosition = null;
      }
    }

    if (!state.openPosition) {
      const event = eventByIndex.get(index);
      if (event && event.direction === "LONG" && event.score >= ALERT_MIN_SCORE) {
        state.openPosition = {
          pattern: event.pattern,
          score: event.score,
          entryTime: candle.time,
          entryPrice: candle.close,
          takeProfit: candle.close * (1 + TAKE_PROFIT_PCT),
          stopLoss: candle.close * (1 - STOP_LOSS_PCT),
        };
      }
    }
  }

  return state;
}

async function main() {
  const response = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=${CANDLE_LIMIT}`);
  if (!response.ok) {
    throw new Error(`Binance request failed: ${response.status}`);
  }

  const candles = (await response.json()).map(toCandle);
  const closedCandles = candles.slice(0, -1);
  const events = detectSignals(closedCandles);

  const before = loadState();
  const beforeJson = JSON.stringify(before);
  const after = simulate(closedCandles, events, before);

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
