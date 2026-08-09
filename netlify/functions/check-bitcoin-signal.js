const CANDLE_LIMIT = 120;

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
  return candles[index].close - candles[lookback].close;
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
  if (price >= 100000) return 5000;
  if (price >= 30000) return 1000;
  if (price >= 10000) return 500;
  return 100;
}

function getSupportLevels(candles) {
  if (!candles.length) return [];

  const pivots = getPivotLows(candles)
    .slice(-5)
    .map((pivot) => ({ price: pivot.price, kind: "pivot" }));
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

function signalTitle(pattern) {
  const names = {
    panic: "패닉셀 반등 후보",
    "double-bottom": "쌍바닥 후보",
    divergence: "상승 다이버전스 후보",
    "slow-bottom": "바닥 다지기 후보",
    avoid: "빠른 진입 금지",
  };

  return names[pattern] ?? pattern;
}

function signalReasons(pattern, volumeSpike) {
  const reasons = {
    panic: ["최근 저점을 새로 만들었습니다.", `평균 대비 거래량이 ${volumeSpike.toFixed(2)}배입니다.`, "긴 봉 또는 아래꼬리로 매수 반응이 보입니다."],
    "double-bottom": ["직전 저점 부근을 다시 테스트했습니다.", "재하락 거래량이 과하지 않습니다.", "아래꼬리 또는 다이버전스가 붙었습니다."],
    divergence: ["가격은 저점 부근인데 하락 힘은 약해졌습니다.", "최근 지지선 근처에서 버티는 흐름입니다.", "추격보다 반등 확인용 포인트입니다."],
    "slow-bottom": ["하락 폭이 점점 줄어듭니다.", "거래량도 같이 줄어 매도 압력이 둔해졌습니다.", "반등은 느릴 수 있어 확인이 필요합니다."],
    avoid: ["첫 장대봉이 너무 강합니다.", "저점까지 매도 거래량이 계속 큽니다.", "PDF 기준 빠른 롱을 피하는 자리입니다."],
  };

  return reasons[pattern] ?? [];
}

function detectLatestClosedSignal(candles) {
  if (candles.length < 25) return null;

  // Binance returns the currently open candle last. Use the previous candle.
  const index = candles.length - 2;
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
  const firstBody = bodySize(lastFour[0]);
  const lastBody = bodySize(current);
  const fallingCloses = lastFour.every((candle, candleIndex) => {
    if (candleIndex === 0) return true;
    return candle.close <= lastFour[candleIndex - 1].close;
  });
  const firstCandleDominates = firstBody > avgBody * 1.7 && firstBody > lastBody * 1.25;
  const highSellVolumeIntoRetest = lastFour.every((candle) => candle.close < candle.open && candle.volume > avgVolume * 1.15);
  const supports = getSupportLevels(candles.slice(0, index + 1));
  const supportNearby = isNearSupport(current.low, supports);
  const pivots = getPivotLows(candles, index - 1);
  const previousPivot = pivots.at(-1);
  const wickOk = lowerWickRatio(current) >= 0.34;
  const sellingSlows = current.volume < avgVolume * 0.95 && bodySize(current) < avgBody * 0.9 && rangeSize(current) < avgRange * 0.95;

  let nearPreviousLow = false;
  let slightlyBrokenDoubleBottom = false;
  let bullishDivergence = false;
  let retestVolumeOk = false;

  if (previousPivot) {
    nearPreviousLow = Math.abs(current.low - previousPivot.price) / previousPivot.price <= 0.007;
    slightlyBrokenDoubleBottom = current.low < previousPivot.price && (previousPivot.price - current.low) / previousPivot.price <= 0.012;
    bullishDivergence = current.low <= previousPivot.price * 1.004 && momentumAt(candles, index) > previousPivot.momentum;
    retestVolumeOk = current.volume <= previousPivot.volume * 1.15 || volumeSpike <= 1.35;
  }

  function makeSignal(pattern, direction, score, detail) {
    return {
      pattern,
      direction,
      score: Math.round(clamp(score, 0, 100)),
      detail,
      volumeSpike,
      candle: current,
    };
  }

  if ((firstCandleDominates && fallingCloses) || highSellVolumeIntoRetest) {
    return makeSignal("avoid", "WAIT", 35, "첫 장대봉이 지배적이거나 저점 재방문까지 매도 거래량이 과합니다.");
  }

  if (freshLow && volumeSpike >= 2.0 && rangeExpansion >= 1.45 && bodyExpansion >= 1.1 && (wickOk || supportNearby)) {
    return makeSignal("panic", "LONG", 70 + volumeSpike * 5 + rangeExpansion * 4 + bodyExpansion * 3 + (supportNearby ? 6 : 0), "마지막 장대봉, 거래량 폭발, 지지/꼬리 조건이 겹친 패닉셀 반등 후보입니다.");
  }

  if ((nearPreviousLow || slightlyBrokenDoubleBottom) && retestVolumeOk && (wickOk || bullishDivergence)) {
    return makeSignal("double-bottom", "LONG", 66 + (bullishDivergence ? 10 : 0) + (wickOk ? 6 : 0) + (supportNearby ? 5 : 0), "직전 저점 부근 재방문. 거래량이 과하지 않고 꼬리/다이버전스가 붙은 쌍바닥 후보입니다.");
  }

  if (freshLow && bullishDivergence && supportNearby) {
    return makeSignal("divergence", "LONG", 72, "저점은 낮거나 비슷하지만 모멘텀은 덜 빠지는 상승 다이버전스 후보입니다.");
  }

  if (freshLow && sellingSlows && (wickOk || current.close >= current.open)) {
    return makeSignal("slow-bottom", "LONG", 58, "하락 폭과 거래량이 줄어드는 바닥 다지기 후보입니다.");
  }

  return null;
}

function buildMessage(signal) {
  const candle = signal.candle;
  const reasons = signalReasons(signal.pattern, signal.volumeSpike).map((reason) => `- ${reason}`).join("\n");

  return [
    "BTC 진입 참고 신호",
    `신호: ${signalTitle(signal.pattern)}`,
    `방향: ${signal.direction}`,
    `점수: ${signal.score}점`,
    `가격: $${Math.round(candle.close).toLocaleString()}`,
    "시간봉: 5m",
    `발생 시간: ${new Date(candle.time).toLocaleString("ko-KR")}`,
    "",
    "왜 이 자리인가?",
    reasons,
    "",
    `설명: ${signal.detail}`,
    "주의: 자동 매매 신호가 아니라 진입 참고용입니다.",
  ].join("\n");
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    throw new Error("Telegram environment variables are missing");
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Telegram request failed: ${response.status} ${await response.text()}`);
  }
}

exports.handler = async function handler() {
  const response = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=${CANDLE_LIMIT}`);
  if (!response.ok) {
    throw new Error(`Binance request failed: ${response.status}`);
  }

  const candles = (await response.json()).map(toCandle);
  const signal = detectLatestClosedSignal(candles);

  if (!signal || (signal.direction === "LONG" && signal.score < 70)) {
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, sent: false }),
    };
  }

  await sendTelegram(buildMessage(signal));

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, sent: true, pattern: signal.pattern }),
  };
};
