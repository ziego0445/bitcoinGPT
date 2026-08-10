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

function momentumAt(candles, index) {
  const lookback = Math.max(0, index - 5);
  const base = candles[lookback].close;
  if (!base) return 0;
  return (candles[index].close - base) / base;
}

function getPivotLows(candles, endIndex = candles.length - 1) {
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
        momentum: momentumAt(candles, index),
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

const SIGNAL_TITLES = {
  panic: "패닉셀 반등 후보",
  "double-bottom": "쌍바닥 후보",
  divergence: "상승 다이버전스 후보",
  "slow-bottom": "바닥 다지기 후보",
  avoid: "빠른 진입 금지",
};

const SIGNAL_REASONS = {
  panic: ["최근 저점을 새로 만들었습니다.", "평균보다 거래량이 크게 늘었습니다.", "긴 봉 또는 아래꼬리로 매수 반응이 보입니다."],
  "double-bottom": ["직전 저점 부근을 다시 테스트했습니다.", "재하락 거래량이 과하지 않습니다.", "아래꼬리 또는 다이버전스가 붙었습니다."],
  divergence: ["가격은 저점 부근인데 하락 힘은 약해졌습니다.", "최근 지지선 근처에서 버티는 흐름입니다.", "추격보다 반등 확인용 포인트입니다."],
  "slow-bottom": ["하락 폭이 점점 줄어듭니다.", "거래량도 같이 줄어 매도 압력이 둔해졌습니다.", "반등은 느릴 수 있어 확인이 필요합니다."],
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

  for (let index = 16; index < candles.length; index += 1) {
    const current = candles[index];
    const recent = candles.slice(index - 10, index);
    const lastFour = candles.slice(index - 3, index + 1);
    const avgVolume = average(recent.map((candle) => candle.volume));
    const avgBody = average(recent.map(bodySize));
    const avgRange = average(recent.map(rangeSize));
    const volumeSpike = avgVolume > 0 ? current.volume / avgVolume : 0;
    const bodyExpansion = avgBody > 0 ? bodySize(current) / avgBody : 0;
    const rangeExpansion = avgRange > 0 ? rangeSize(current) / avgRange : 0;
    const freshLow = current.low <= Math.min(...recent.map((candle) => candle.low));
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
    const pivots = getPivotLows(candles, index - 1);
    const previousPivot = pivots.at(-1);
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
    const currentMomentum = momentumAt(candles, index);
    const bullishDivergence = previousPivot
      ? current.low <= previousPivot.price * 1.004 && currentMomentum > previousPivot.momentum
      : false;
    const retestVolumeOk = previousPivot
      ? current.volume <= previousPivot.volume * 1.15 && volumeSpike <= 1.6
      : false;
    const wickOk = lowerWickRatio(current) >= 0.34;
    const sellingSlows =
      current.volume < avgVolume * 0.95 &&
      bodySize(current) < avgBody * 0.9 &&
      rangeSize(current) < avgRange * 0.95;
    const bodyExtreme = bodyExpansion >= 1.1 || bodyExpansion <= 0.4;

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

    if (freshLow && volumeSpike >= 2.0 && rangeExpansion >= 1.45 && bodyExtreme && (wickOk || supportNearby)) {
      signals.push({
        index,
        direction: "LONG",
        score: clamp(70 + volumeSpike * 5 + rangeExpansion * 4 + Math.abs(bodyExpansion - 1) * 3 + (supportNearby ? 6 : 0), 70, 96),
        pattern: "panic",
        detail: "마지막 장대봉, 거래량 폭발, 지지/꼬리 조건이 겹친 패닉셀 반등 후보.",
      });
      continue;
    }

    if ((nearPreviousLow || slightlyBrokenDoubleBottom) && retestVolumeOk && (wickOk || bullishDivergence)) {
      signals.push({
        index,
        direction: "LONG",
        score: clamp(66 + (bullishDivergence ? 10 : 0) + (wickOk ? 6 : 0) + (supportNearby ? 5 : 0), 66, 92),
        pattern: "double-bottom",
        detail: "직전 저점 부근 재방문. 거래량이 과하지 않고 꼬리/다이버전스가 붙은 쌍바닥 후보.",
      });
      continue;
    }

    if (freshLow && bullishDivergence && supportNearby) {
      signals.push({
        index,
        direction: "LONG",
        score: 72,
        pattern: "divergence",
        detail: "저점은 낮거나 비슷하지만 모멘텀은 덜 빠지는 상승 다이버전스 후보.",
      });
      continue;
    }

    if (freshLow && sellingSlows && (wickOk || current.close >= current.open)) {
      signals.push({
        index,
        direction: "LONG",
        score: 58,
        pattern: "slow-bottom",
        detail: "하락 폭과 거래량이 줄어드는 바닥 다지기 후보. 반등은 느릴 수 있음.",
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
  momentumAt,
  getPivotLows,
  getSupportLevels,
  isNearSupport,
  detectSignals,
  signalTitle,
  signalReasons,
};
