// Runs on a GitHub Actions schedule (see .github/workflows/telegram-alert.yml).
// Sends a Telegram message when the most recently closed 5m candle scores an
// alert-worthy signal. Detection logic lives in scripts/lib/signals.js, shared with
// scripts/paper-trade.js.

const { toCandle, detectSignals, signalTitle, signalReasons } = require("./lib/signals");

const CANDLE_LIMIT = 200;
const ALERT_MIN_SCORE = 85;

function buildMessage(signal, candle) {
  const reasons = signalReasons(signal.pattern).map((reason) => `- ${reason}`).join("\n");

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
    throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID environment variables are missing");
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

async function main() {
  const response = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=${CANDLE_LIMIT}`);
  if (!response.ok) {
    throw new Error(`Binance request failed: ${response.status}`);
  }

  const candles = (await response.json()).map(toCandle);
  // Binance returns the currently open candle last — only closed candles are valid signals.
  const closedCandles = candles.slice(0, -1);
  const events = detectSignals(closedCandles);
  const latest = events.at(-1);
  const isLatestClosedCandle = latest && latest.index === closedCandles.length - 1;

  if (!isLatestClosedCandle || latest.score < ALERT_MIN_SCORE) {
    console.log(`No alert (score=${isLatestClosedCandle ? latest.score : "n/a"}, threshold=${ALERT_MIN_SCORE}).`);
    return;
  }

  await sendTelegram(buildMessage(latest, closedCandles[latest.index]));
  console.log(`Alert sent: ${latest.pattern} (${latest.score}점)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
