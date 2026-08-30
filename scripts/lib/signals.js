// Shared signal-detection logic for the Node scripts (Telegram alert + paper trading).
// This is a faithful port of detectSignals() and its helpers in
// app/components/BitcoinEntryChart.tsx. That file runs in the browser and this one runs
// under Node, so they can't literally share a module — if you change the rules in one,
// mirror the change in the other (search for the same section comments in both).

function toCandle(item) {
  return {
    time: Number(item[0]),
    open: Number(item[1]),
    high: Number(item[2]),
    low: Number(item[3]),
    close: Number(item[4]),
    volume: Number(item[5]),
  };
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function bodySize(candle) {
  return Math.abs(candle.close - candle.open);
}

function rangeSize(candle) {
  return Math.max(candle.high - candle.low, 1);
}

function lowerWickRatio(candle) {
  return (Math.min(candle.open, candle.close) - candle.low) / rangeSize(candle);
}

// Standard Wilder's RSI (14-period), computed once over the whole series. Unlike the
// other indicators here (which only look back 10-ish candles), Wilder's smoothing is
// recursive — recomputing it from a short window on every call would corrupt it — so
// this returns a parallel array (one RSI value per candle, null before enough history)
// for detectSignals() to index into instead of calling per-candle.
function computeRSISeries(candles, period = 14) {
  const rsi = new Array(candles.length).fill(null);
  if (candles.length <= period) return rsi;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = candles[i].close - candles[i - 1].close;
    if (change > 0) gainSum += change;
    else lossSum -= change;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < candles.length; i += 1) {
    const change = candles[i].close - candles[i - 1].close;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return rsi;
}

// rsiSeries is optional — getSupportLevels() only needs pivot prices, but detectSignals()
// passes its already-computed RSI series through so each pivot also carries the RSI(14)
// value at that candle, needed for real RSI divergence (see bullishDivergence below).
function getPivotLows(candles, endIndex = candles.length - 1, rsiSeries) {
  const pivots = [];

  for (let index = 3; index <= endIndex - 3; index += 1) {
    const candle = candles[index];
    const left = candles.slice(index - 3, index);
    const right = candles.slice(index + 1, index + 4);
    const isPivot = [...left, ...right].every((item) => candle.low <= item.low);

    if (isPivot) {
      pivots.push({
        index,
        price: candle.low,
        rsi: rsiSeries ? rsiSeries[index] : null,
        volume: candle.volume,
      });
    }
  }

  return pivots;
}

function roundStep(price) {
  if (price >= 100_000) return 5_000;
  if (price >= 30_000) return 1_000;
  if (price >= 10_000) return 500;
  return 100;
}

function getSupportLevels(candles) {
  if (!candles.length) return [];

  const pivots = getPivotLows(candles).slice(-5).map((pivot) => ({
    price: pivot.price,
    kind: "pivot",
  }));
  const current = candles.at(-1)?.close ?? 0;
  const step = roundStep(current);
  const round = Math.floor(current / step) * step;
  const roundLevels = [round - step, round, round + step]
    .filter((price) => price > 0)
    .map((price) => ({ price, kind: "round" }));

  return [...pivots, ...roundLevels];
}

function isNearSupport(price, supports, tolerance = 0.006) {
  return supports.some((support) => Math.abs(price - support.price) / support.price <= tolerance);
}

// The "previous low" a double-bottom retests should be the one the market actually
// remembers — the candle where selling climaxed on volume — not just whichever pivot
// happens to be most recent. getPivotLows() picks pivots by price geometry alone, so a
// quiet, insignificant wiggle can outrank the real capitulation candle just for being
// newer. Pick the highest-volume pivot among the last few instead of blindly using the
// last one; capped to a small recent window so this still means "the recent low", not
// "the biggest low in the whole fetched history".
function selectPreviousPivot(pivots, lookback = 3) {
  const recent = pivots.slice(-lookback);
  if (!recent.length) return undefined;
  return recent.reduce((best, pivot) => (pivot.volume > best.volume ? pivot : best), recent[0]);
}

// getPivotLows() only confirms a pivot once 3 candles afterward all traded higher — for
// an ordinary quiet low that's the right caution, but a genuine capitulation candle (long
// lower wick + a real volume spike) is a level the market already reacted to the moment
// it printed. Waiting the usual ~1h/4-candle confirmation window means the first retest
// after a flash-crash ends up referencing whatever older, less relevant pivot still
// qualifies instead of the crash low itself (confirmed against the 2026-08-29 01:15 KST
// crash: the 76846 wick low wasn't usable until 02:15, so the 02:00 retest signal
// referenced a stale 78363 pivot from the day before instead).
// 150-day/15m backtest (in-sample/out-of-sample split): wr>=0.4 + volume>=2x average,
// searched over the last 8 candles preferring the most recent match, improved final
// equity in BOTH halves independently (87.15->98.07 in-sample, 163.39->165.93
// out-of-sample) — tighter wr/volume cutoffs looked better in one half but not the other.
const WICK_PIVOT_LOOKBACK = 8;
const WICK_PIVOT_MIN_WICK_RATIO = 0.4;
const WICK_PIVOT_MIN_VOLUME_SPIKE = 2;

function findRecentWickPivot(candles, rsiSeries, upToIndex) {
  const start = Math.max(10, upToIndex - WICK_PIVOT_LOOKBACK + 1);
  for (let k = upToIndex; k >= start; k -= 1) {
    const candle = candles[k];
    const recentAvgVolume = average(candles.slice(k - 10, k).map((c) => c.volume));
    const volumeSpike = recentAvgVolume > 0 ? candle.volume / recentAvgVolume : 0;
    if (lowerWickRatio(candle) >= WICK_PIVOT_MIN_WICK_RATIO && volumeSpike >= WICK_PIVOT_MIN_VOLUME_SPIKE) {
      return { index: k, price: candle.low, rsi: rsiSeries[k], volume: candle.volume };
    }
  }
  return undefined;
}

const SIGNAL_TITLES = {
  "key-candle": "장대+거래량 컨펌 후보",
  "double-bottom": "쌍바닥 후보",
  avoid: "빠른 진입 금지",
};

const SIGNAL_REASONS = {
  "key-candle": [
    "직전 장대봉이 거래량을 동반한 과매도권 음봉이었습니다.",
    "그다음 봉이 도지 또는 작은 양봉으로 매수 반응을 보였습니다.",
    "이번 봉의 아래꼬리가 지지를 다시 확인해줍니다.",
  ],
  "double-bottom": ["직전 저점 부근을 다시 테스트했습니다.", "재하락 거래량이 과하지 않습니다.", "아래꼬리 또는 다이버전스가 붙었습니다."],
  avoid: ["첫 장대봉이 너무 강합니다.", "저점까지 매도 거래량이 계속 큽니다.", "PDF 기준 빠른 롱을 피하는 자리입니다."],
};

function signalTitle(pattern) {
  return SIGNAL_TITLES[pattern] ?? pattern;
}

function signalReasons(pattern) {
  return SIGNAL_REASONS[pattern] ?? [];
}

// Returns one entry per candle index (from index 16 onward) that matched a pattern.
// Mirrors detectSignals() in BitcoinEntryChart.tsx — see that file for the annotated
// rationale behind each condition.
function detectSignals(candles) {
  const signals = [];
  const rsiSeries = computeRSISeries(candles);

  for (let index = 16; index < candles.length; index += 1) {
    const current = candles[index];
    const recent = candles.slice(index - 10, index);
    const lastFour = candles.slice(index - 3, index + 1);
    const avgVolume = average(recent.map((candle) => candle.volume));
    const avgBody = average(recent.map(bodySize));
    const volumeSpike = avgVolume > 0 ? current.volume / avgVolume : 0;
    const rsi = rsiSeries[index];
    const rsiOversold = rsi != null && rsi <= 40;
    const lastBody = bodySize(current);
    const firstCandle = lastFour[0];
    const firstBody = bodySize(firstCandle);

    const steppedDecline =
      current.close < firstCandle.close &&
      lastFour.slice(1).every((candle) => candle.close <= firstCandle.open);
    const firstVolumeDominates =
      firstCandle.volume > avgVolume * 1.3 &&
      firstCandle.volume >= Math.max(...lastFour.slice(1).map((candle) => candle.volume));
    const firstCandleDominates = firstBody > avgBody * 1.7 && firstBody > lastBody * 1.25 && firstVolumeDominates;

    const supports = getSupportLevels(candles.slice(0, index + 1));
    const supportNearby = isNearSupport(current.low, supports);
    const pivots = getPivotLows(candles, index - 1, rsiSeries);
    // A fresh wick-pivot (see findRecentWickPivot above) takes priority when present —
    // it's the level the market just reacted to, unlike a plain geometric pivot which can
    // be an arbitrary quiet wiggle that happened to be the most recent one confirmed.
    const previousPivot = findRecentWickPivot(candles, rsiSeries, index - 1) ?? selectPreviousPivot(pivots);
    const nearPreviousLow = previousPivot
      ? Math.abs(current.low - previousPivot.price) / previousPivot.price <= 0.007
      : false;
    const slightlyBrokenDoubleBottom = previousPivot
      ? current.low < previousPivot.price && (previousPivot.price - current.low) / previousPivot.price <= 0.012
      : false;
    const inRetestZone = previousPivot
      ? Math.abs(current.low - previousPivot.price) / previousPivot.price <= 0.02
      : false;
    const highSellVolumeIntoRetest =
      inRetestZone && lastFour.every((candle) => candle.close < candle.open && candle.volume > avgVolume * 1.15);
    // Regular bullish RSI divergence — the same definition TradingView's built-in "RSI
    // Divergence Indicator" plots: price prints an equal-or-lower low while RSI(14) prints
    // a higher low at that same spot, i.e. momentum quietly fading even as price probes
    // lower. Replaces an earlier proxy that compared raw price rate-of-change instead of
    // RSI itself — this is the real oscillator divergence the pattern is named for.
    const bullishDivergence = previousPivot
      ? previousPivot.rsi != null &&
        rsi != null &&
        current.low <= previousPivot.price * 1.004 &&
        rsi > previousPivot.rsi
      : false;
    const retestVolumeOk = previousPivot
      ? current.volume <= previousPivot.volume * 1.15 && volumeSpike <= 1.6
      : false;
    // Lowered from 0.34 after a 150-day/15m backtest split into two 100/50-day halves:
    // 0.34 required a strong lower wick that, combined with the RSI divergence check
    // above, ended up screening out a lot of otherwise-valid retests. 0.2 improved final
    // equity in BOTH halves independently (not just one) — a tighter rsiOversold cutoff
    // looked better in-sample alone but reversed out-of-sample, so that one was left as-is.
    const wickOk = lowerWickRatio(current) >= 0.2;

    if ((firstCandleDominates && steppedDecline) || highSellVolumeIntoRetest) {
      signals.push({
        index,
        direction: "WAIT",
        score: 35,
        pattern: "avoid",
        detail: "첫 장대봉이 지배적이거나 저점 재방문까지 매도 거래량이 과합니다. 빠른 롱 금지.",
      });
      continue;
    }

    // "키캔들" 3봉 패턴 (index-2, index-1, index=current):
    //   1. 장대봉: 거래량 실린 과매도권 음봉 (장대 + 거래량 많이 + 과매도)
    //   2. 컨펌봉: 도지 또는 작은 양봉으로 매수 반응
    //   3. 진입봉(현재): 아래꼬리로 지지를 재확인 — 여기서 진입
    const keyCandle = candles[index - 2];
    const confirmCandle = candles[index - 1];
    const keyCandleIsLong = bodySize(keyCandle) > avgBody * 1.5;
    const keyCandleHeavyVolume = keyCandle.volume > avgVolume * 1.5;
    const keyCandleIsBearish = keyCandle.close < keyCandle.open;
    const keyCandleOversold = keyCandle.low <= Math.min(...recent.map((candle) => candle.low));
    const confirmBody = bodySize(confirmCandle);
    const confirmIsDojiOrSmallBull =
      confirmBody <= avgBody * 0.6 || (confirmCandle.close > confirmCandle.open && confirmBody <= avgBody * 0.9);

    if (
      keyCandleIsLong &&
      keyCandleHeavyVolume &&
      keyCandleIsBearish &&
      keyCandleOversold &&
      confirmIsDojiOrSmallBull &&
      wickOk
    ) {
      signals.push({
        index,
        direction: "LONG",
        score: clamp(
          78 +
            (avgVolume > 0 ? (keyCandle.volume / avgVolume) * 2 : 0) +
            (confirmCandle.close > confirmCandle.open ? 5 : 0) +
            (supportNearby ? 6 : 0),
          78,
          96,
        ),
        pattern: "key-candle",
        detail: "장대 음봉+거래량 폭발 후 도지/양봉 컨펌, 다음 봉 아래꼬리로 지지 재확인.",
        // The key candle's low is this setup's own thesis: if price ever trades back below
        // it, the "capitulation" this pattern is betting on didn't hold. Callers use this
        // for a structural stop-loss instead of an arbitrary fixed distance.
        structureLevel: keyCandle.low,
      });
      continue;
    }

    // Both confirmations required, not either/or — a lower wick alone (no real momentum
    // divergence vs. the reference low) is just a wiggle, and a divergence alone (no wick
    // reaction) is momentum without a visible buying response. Cut real occurrences from
    // 84 to 19 over a ~50h/200-candle sample when checked against live data.
    // rsiOversold guards against a shallow retest that sits "near" the previous pivot
    // without the market actually being oversold (RSI 14 <= 40) — caught a real live entry
    // whose retest low was only 0.15% below the pivot with RSI a neutral 58.
    if ((nearPreviousLow || slightlyBrokenDoubleBottom) && retestVolumeOk && wickOk && bullishDivergence && rsiOversold) {
      signals.push({
        index,
        direction: "LONG",
        score: clamp(66 + (bullishDivergence ? 10 : 0) + (wickOk ? 6 : 0) + (supportNearby ? 5 : 0), 66, 92),
        pattern: "double-bottom",
        detail: "직전 저점 부근 재방문. 거래량이 과하지 않고 꼬리/다이버전스가 붙은 쌍바닥 후보.",
        // The reference pivot low this retest is measured against — the "double bottom"
        // thesis is that this level holds again. See structureLevel note on key-candle above.
        structureLevel: previousPivot.price,
      });
    }
  }

  return signals;
}

module.exports = {
  toCandle,
  average,
  clamp,
  bodySize,
  rangeSize,
  lowerWickRatio,
  computeRSISeries,
  getPivotLows,
  getSupportLevels,
  isNearSupport,
  detectSignals,
  signalTitle,
  signalReasons,
};
