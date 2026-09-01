// ICT (Inner Circle Trader) concept-based signal detection: Liquidity Sweep -> Market
// Structure Shift (MSS/BOS/CHoCH) -> Fair Value Gap (FVG) entry.
//
// Modeled on the entry sequence LuxAlgo's "ICT Concepts" indicator plots (liquidity
// sweep, then a structural break, then an FVG the price retraces into) and the
// structure/BOS/CHoCH vocabulary from LuxAlgo's "Smart Money Concepts" indicator. Not a
// port of either indicator's actual Pine source — an independent re-implementation of the
// same public concepts, simplified down to what a bot can act on mechanically.
//
// STATUS: backtested (150-day/15m BTC, LONG-only, R=2 — see docs/ict-strategy.md) and
// live-trading for real on OKX via scripts/live-trade-ict.js. SHORT is detected/exposed
// but not traded live (no robust backtested edge). swingStrength/SWEEP_LOOKBACK/
// MSS_MAX_GAP below are still first-guess values, not parameter-swept.
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

// One forward pass over the WHOLE series computing every structure break — price CLOSES
// beyond the most recently confirmed opposite-side swing point. Classified as "MSS" (the
// first break in a new direction — doubles as ICT's CHoCH, a trend reversal) or "BOS" (a
// further break continuing the direction the trend is already in), mirroring LuxAlgo's
// ICT Concepts indicator's MSS.dir state machine. A given swing level only fires once
// (matches that indicator's crossed/cross-reset behavior) — a run of closes beyond the
// same level isn't a new event each candle.
//
// This is the ONLY place structure breaks get computed — detectICTSignals() below looks
// up breaks from this same list rather than re-deriving them per sweep candidate. An
// earlier version had a second, separate findStructureBreak() that re-checked "close vs.
// the swing confirmed as of the sweep candle" for each (sweepIndex, candidate) pair —
// since the "most recently confirmed swing" can change between the sweep and the actual
// break candle, that produced a DIFFERENT swing reference than this function's own
// continuously-updated one, so the two disagreed on ~half of all real signals about which
// level (and therefore which MSS/BOS type) actually applied. Keeping one source of truth
// closes that gap.
function computeStructureBreaks(candles, swingHighs, swingLows, strength) {
  const breaks = [];
  let trend = 0; // 0 = undetermined yet, 1 = bullish, -1 = bearish
  let lastHighBroken = null;
  let lastLowBroken = null;

  for (let index = 0; index < candles.length; index += 1) {
    const swingHigh = confirmedBy(swingHighs, index, strength).at(-1);
    if (swingHigh && candles[index].close > swingHigh.price && swingHigh.price !== lastHighBroken) {
      breaks.push({ index, direction: "bullish", level: swingHigh.price, type: trend <= 0 ? "MSS" : "BOS" });
      trend = 1;
      lastHighBroken = swingHigh.price;
    }
    const swingLow = confirmedBy(swingLows, index, strength).at(-1);
    if (swingLow && candles[index].close < swingLow.price && swingLow.price !== lastLowBroken) {
      breaks.push({ index, direction: "bearish", level: swingLow.price, type: trend >= 0 ? "MSS" : "BOS" });
      trend = -1;
      lastLowBroken = swingLow.price;
    }
  }
  return breaks;
}

// Wilder's ATR — used only as the FVG minimum-width yardstick below, matching how
// LuxAlgo's "ICT Killzones Toolkit" indicator sizes its own gap filter.
function computeATR(candles, period = 14) {
  const atr = new Array(candles.length).fill(null);
  let avg = null;
  let sum = 0;
  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i];
    const trueRange =
      i === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close));
    if (avg == null) {
      sum += trueRange;
      if (i === period - 1) avg = sum / period;
    } else {
      avg = (avg * (period - 1) + trueRange) / period;
    }
    atr[i] = avg;
  }
  return atr;
}

// Fair Value Gap: a 3-candle imbalance — candle[i-2] and candle[i] don't overlap, leaving
// a gap price often returns to "fill" before continuing the move that created it.
// "bullish" = gap sits below price (acts as support to retrace into for a LONG),
// "bearish" = gap sits above price (resistance to retrace into for a SHORT).
//
// Two extra conditions beyond the bare 3-candle overlap check, both taken from LuxAlgo's
// "ICT Killzones Toolkit" indicator's actual pFVG() logic (its default settings: a min
// width of ATR(144)*1.2, and a displacement close):
//   - minWidthATR: the gap itself must be at least this many ATR(14)s wide, so a 1-tick
//     technical gap from ordinary noise doesn't count as a real imbalance. 0 disables it
//     (the reference's own convention for "no filtering").
//   - displacement: the middle (impulse) candle's CLOSE must extend past the first
//     candle's level, confirming actual directional commitment rather than a gap that
//     happens to exist geometrically without the market really pushing through it.
function findFairValueGap(candles, index, direction, atrSeries, minWidthATR = 0) {
  if (index < 2) return null;
  const first = candles[index - 2];
  const middle = candles[index - 1];
  const third = candles[index];
  const atr = atrSeries ? atrSeries[index] : null;
  const minWidth = minWidthATR > 0 && atr != null ? atr * minWidthATR : 0;

  if (direction === "bullish" && first.high < third.low && third.low - first.high > minWidth && middle.close > first.high) {
    return { low: first.high, high: third.low, formedAt: index };
  }
  if (direction === "bearish" && first.low > third.high && first.low - third.high > minWidth && middle.close < first.low) {
    return { low: third.high, high: first.low, formedAt: index };
  }
  return null;
}

const SWEEP_LOOKBACK = 40; // how far back to search for the sweep that started a setup
const MSS_MAX_GAP = 15; // sweep -> structure break must land within this many candles

// Full sequence: liquidity sweep -> structure break in the reversal direction -> an FVG
// formed during that impulse leg -> current candle retraces back into the FVG. Emits one
// signal per candle index at most, at the moment price taps into a still-valid FVG.
function detectICTSignals(candles, { swingStrength = 2, fvgMinWidthATR = 0 } = {}) {
  const { highs: swingHighs, lows: swingLows } = getSwingPoints(candles, swingStrength);
  const structureBreaks = computeStructureBreaks(candles, swingHighs, swingLows, swingStrength);
  // Split by direction (each still sorted ascending by index) so the lookup below can
  // binary-search instead of scanning — matters once this runs over a real backtest's
  // worth of candles, not just a 200-candle dashboard window.
  const breaksByDirection = {
    bullish: structureBreaks.filter((b) => b.direction === "bullish"),
    bearish: structureBreaks.filter((b) => b.direction === "bearish"),
  };
  // First structure break strictly after `afterIndex` and at or before `maxIndex`, or
  // null. Binary search since breaksByDirection[...] is sorted ascending.
  function firstBreakInWindow(direction, afterIndex, maxIndex) {
    const list = breaksByDirection[direction];
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].index <= afterIndex) lo = mid + 1;
      else hi = mid;
    }
    if (lo >= list.length) return null;
    return list[lo].index <= maxIndex ? list[lo] : null;
  }
  // Only computed when the width filter is actually on — ATR isn't free at scale.
  const atrSeries = fvgMinWidthATR > 0 ? computeATR(candles, 14) : null;
  const signals = [];
  // The same sweep+MSS+FVG setup can get "tapped" by several candles in a row as price
  // chops around inside the gap — only the first tap is a fresh entry, so track which
  // setups have already fired once.
  const firedSetups = new Set();

  for (let index = swingStrength * 2 + 5; index < candles.length; index += 1) {
    for (let sweepIndex = index; sweepIndex >= Math.max(0, index - SWEEP_LOOKBACK); sweepIndex -= 1) {
      const sweep = findLiquiditySweep(swingLows, swingHighs, candles, sweepIndex, swingStrength);
      if (!sweep) continue;

      const mssBreak = firstBreakInWindow(sweep.direction, sweepIndex, Math.min(index, sweepIndex + MSS_MAX_GAP));
      if (!mssBreak) continue;
      const mss = { index: mssBreak.index, brokenLevel: mssBreak.level };

      let fvg = null;
      for (let f = mss.index; f >= sweepIndex + 2; f -= 1) {
        fvg = findFairValueGap(candles, f, sweep.direction, atrSeries, fvgMinWidthATR);
        if (fvg) break;
      }
      if (!fvg) continue;

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
        // "MSS" = first break in a new direction (ICT's CHoCH — the higher-conviction
        // reversal signal); "BOS" = a further break continuing a trend already underway.
        // Exposed rather than filtered so a backtest can compare MSS-only vs BOS-only vs
        // both, instead of guessing which one actually performs better.
        mssType: mssBreak.type,
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
  computeStructureBreaks,
  computeATR,
  findFairValueGap,
  detectICTSignals,
};
