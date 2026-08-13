// Shared Telegram sender — used by check-bitcoin-signal.js (GitHub Actions, signal-only
// alerts) and live-trade.js (local, real-order notifications). Same env var convention as
// the rest of the repo: throw a clear error if the vars are missing, let the caller decide
// whether that's fatal.

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

module.exports = { sendTelegram };
