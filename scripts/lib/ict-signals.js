// ICT (Inner Circle Trader) concept-based signal detection: Liquidity Sweep -> Market
// Structure Shift (MSS/BOS/CHoCH) -> Fair Value Gap (FVG) entry.
//
// Modeled on the entry sequence LuxAlgo's "ICT Concepts" indicator plots (liquidity
// sweep, then a structural break, then an FVG the price retraces into) and the
// structure/BOS/CHoCH vocabulary from LuxAlgo's "Smart Money Concepts" indicator. Not a
// port of either indicator's actual Pine source — an independent re-implementation of the
// same public concepts, simplified down to what a bot can act on mechanically.
//
// STATUS: first structural pass. NOT backtested, NOT wired into scripts/live-trade.js —
// that script still only trades the double-bottom pattern in scripts/lib/signals.js.
// Before this trades real money it needs: a backtest (this repo's existing 150-day/15m
// harness pattern is the template — see conversation history / git log for examples),
// parameter tuning (swingStrength, SWEEP_LOOKBACK, MSS_MAX_GAP below are first guesses,
// not fitted to anything), and a live-trade.js change to support SHORT + running two
// concurrent strategies (it's currently single-position, LONG-only).
//
// Mirrors app/components/IctStrategyChart.tsx — keep both in sync, same convention as
// scripts/lib/signals.js / app/components/BitcoinEntryChart.tsx.

// Swing highs/lows: simple N-bar fractals (N candles on each side must all be less
// extreme). This is the "liquidity pool" location ICT concepts are built around — a swing
// low is where sell-stops/short-entry liquidity sits below price, a swing high is where
// buy-stops/short-liquidity sits above it.
function getSwingPoints(candles, strength = 2) {
  const highs = [];
  const lows = [];
  for (let i = strength; i < candles.length - strength; i += 1) {
    const candle = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let k = i - strength; k <= i + strength; k += 1) {
      if (k === i) continue;
      if (candles[k].high >= candle.high) isHigh = false;
      if (candles[k].low <= candle.low) isLow = false;
    }
    if (isHigh) highs.push({ index: i, price: candle.high });
    if (isLow) lows.push({ index: i, price: candle.low });
  }
  return { highs, lows };
}

// A swing point is only knowable `strength` candles after it prints (that's how many
// candles on its right had to stay less extreme to confirm it) — using it as if it were
// known at its own index is lookahead bias. Every lookup below goes through this so a
// point can't be referenced before it would actually be confirmed live.
function confirmedBy(points, atIndex, strength) {
  return points.filter((p) => p.index + strength <= atIndex);
}

// A liquidity sweep: price wicks through a resting swing point but closes back on the
// other side of it — the classic "stop hunt" right before a reversal. "bullish" sweeps a
// swing LOW (grabs sell-side liquidity, sets up a LONG); "bearish" sweeps a swing HIGH
// (grabs buy-side liquidity, sets up a SHORT).
function findLiquiditySweep(swingLows, swingHighs, candles, index, strength) {
  const candle = candles[index];
  const priorLow = confirmedBy(swingLows, index, strength).at(-1);
  if (priorLow && candle.low < priorLow.price && candle.close > priorLow.price) {
    return { direction: "bullish", sweptIndex: priorLow.index, sweptPrice: priorLow.price, extreme: candle.low };
  }
  const priorHigh = confirmedBy(swingHighs, index, strength).at(-1);
  if (priorHigh && candle.high > priorHigh.price && candle.close < priorHigh.price) {
    return { direction: "bearish", sweptIndex: priorHigh.index, sweptPrice: priorHigh.price, extreme: candle.high };
  }
  return null;
}

// Market Structure Shift: price CLOSES beyond the last swing point the PRIOR trend was
// built on — the "lower high" a downtrend kept making (bullish break) or the "higher low"
// an uptrend kept making (bearish break). That reference point has to already exist
// before the sweep that's reversing it; it is NOT a new peak/trough forming during the
// post-sweep bounce itself (an earlier version of this function searched forward from the
// sweep and was picking up exactly that — a minor bump in the reaction leg, not the
// structural level the reversal is actually supposed to invalidate).
// ICT calls a break CHoCH when it reverses the prevailing trend and BOS when it just
// continues one — this function doesn't distinguish the two (needs tracking the broader
// trend, left as a future refinement); either way a close beyond the level counts.
function findStructureBreak(swingHighs, swingLows, candles, sweepIndex, toIndex, direction, strength) {
  if (direction === "bullish") {
    const swingHigh = confirmedBy(swingHighs, sweepIndex, strength).at(-1);
    if (swingHigh && candles[toIndex].close > swingHigh.price) {
      return { index: toIndex, brokenLevel: swingHigh.price };
    }
  } else {
    const swingLow = confirmedBy(swingLows, sweepIndex, strength).at(-1);
    if (swingLow && candles[toIndex].close < swingLow.price) {
      return { index: toIndex, brokenLevel: swingLow.price };
    }
  }
  return null;
}

// Fair Value Gap: a 3-candle imbalance — candle[i-2] and candle[i] don't overlap, leaving
// a gap price often returns to "fill" before continuing the move that created it.
// "bullish" = gap sits below price (acts as support to retrace into for a LONG),
// "bearish" = gap sits above price (resistance to retrace into for a SHORT).
function findFairValueGap(candles, index, direction) {
  if (index < 2) return null;
  const first = candles[index - 2];
  const third = candles[index];
  if (direction === "bullish" && first.high < third.low) {
    return { low: first.high, high: third.low, formedAt: index };
  }
  if (direction === "bearish" && first.low > third.high) {
    return { low: third.high, high: first.low, formedAt: index };
  }
  return null;
}

const SWEEP_LOOKBACK = 40; // how far back to search for the sweep that started a setup
const MSS_MAX_GAP = 15; // sweep -> structure break must land within this many candles

// Full sequence: liquidity sweep -> structure break in the reversal direction -> an FVG
// formed during that impulse leg -> current candle retraces back into the FVG. Emits one
// signal per candle index at most, at the moment price taps into a still-valid FVG.
function detectICTSignals(candles, { swingStrength = 2 } = {}) {
  const { highs: swingHighs, lows: swingLows } = getSwingPoints(candles, swingStrength);
  const signals = [];
  // The same sweep+MSS+FVG setup can get "tapped" by several candles in a row as price
  // chops around inside the gap — only the first tap is a fresh entry, so track which
  // setups have already fired once.
  const firedSetups = new Set();

  for (let index = swingStrength * 2 + 5; index < candles.length; index += 1) {
    for (let sweepIndex = index; sweepIndex >= Math.max(0, index - SWEEP_LOOKBACK); sweepIndex -= 1) {
      const sweep = findLiquiditySweep(swingLows, swingHighs, candles, sweepIndex, swingStrength);
      if (!sweep) continue;

      let mss = null;
      let fvg = null;
      for (let k = sweepIndex + 1; k <= Math.min(index, sweepIndex + MSS_MAX_GAP); k += 1) {
        if (!mss) mss = findStructureBreak(swingHighs, swingLows, candles, sweepIndex, k, sweep.direction, swingStrength);
        if (mss && !fvg) {
          for (let f = mss.index; f >= sweepIndex + 2; f -= 1) {
            fvg = findFairValueGap(candles, f, sweep.direction);
            if (fvg) break;
          }
        }
        if (mss && fvg) break;
      }
      if (!mss || !fvg) continue;

      const setupKey = `${sweepIndex}-${mss.index}`;
      if (firedSetups.has(setupKey)) continue;

      const current = candles[index];
      const tappedIn =
        sweep.direction === "bullish"
          ? current.low <= fvg.high && current.low >= fvg.low
          : current.high >= fvg.low && current.high <= fvg.high;
      if (!tappedIn) continue;

      // Stale setup: price already ran back through the sweep's own extreme without ever
      // tapping the FVG first — the level that mattered has been invalidated.
      const invalidated =
        sweep.direction === "bullish"
          ? candles.slice(mss.index + 1, index).some((c) => c.low < sweep.extreme)
          : candles.slice(mss.index + 1, index).some((c) => c.high > sweep.extreme);
      if (invalidated) continue;

      firedSetups.add(setupKey);
      signals.push({
        index,
        direction: sweep.direction === "bullish" ? "LONG" : "SHORT",
        pattern: "ict-fvg",
        sweepIndex,
        sweepPrice: sweep.extreme,
        mssIndex: mss.index,
        mssLevel: mss.brokenLevel,
        fvgLow: fvg.low,
        fvgHigh: fvg.high,
        fvgFormedAt: fvg.formedAt,
        detail:
          sweep.direction === "bullish"
            ? "저점 유동성 스윕 → 구조 전환(MSS) → FVG 되돌림 진입(롱)"
            : "고점 유동성 스윕 → 구조 전환(MSS) → FVG 되돌림 진입(숏)",
      });
      break; // one signal per index at most
    }
  }

  return signals;
}

module.exports = {
  getSwingPoints,
  findLiquiditySweep,
  findStructureBreak,
  findFairValueGap,
  detectICTSignals,
};
