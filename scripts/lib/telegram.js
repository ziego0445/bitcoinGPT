// Shared Telegram sender — used by check-bitcoin-signal.js (GitHub Actions, signal-only
// alerts) and live-trade.js/live-trade-ict.js (local, real-order notifications). Same env
// var convention as the rest of the repo: throw a clear error if the vars are missing, let
// the caller decide whether that's fatal.

// Both live-trade bots `await notify()` directly (not fire-and-forget) — their own
// try/catch around it only guards against a REJECTED promise, not a HUNG one. Node's fetch
// has no default timeout, so an unbounded fetch here would freeze the whole tick loop
// forever on a network stall, exactly like the same missing-timeout bug did to the OKX
// client (see its own comment). Bounded the same way.
const REQUEST_TIMEOUT_MS = 15_000;

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID environment variables are missing");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Telegram request timed out after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    throw new Error(`Telegram request failed: ${response.status} ${await response.text()}`);
  }
}

module.exports = { sendTelegram };
