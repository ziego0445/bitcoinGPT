// Chapter 1 of the strategy PDF ("찐바닥 잡는 법" — 마지막 봉이 가장 길 때): during a panic
// sell-off, the candle that finally prints by far the most volume is the capitulation, and
// the rebound off it comes fastest and strongest. The PDF's author rates it the easiest of
// the five setups and their favourite.
//
// Measured on 2 years of 15m BTCUSDT (Oct 2024 - Oct 2026), Bitget and OKX candles, split in
// two halves: it is the one setup from the PDF (and the only one of everything else tried —
// the old double-bottom, 297 TP/SL ladders, ICT, 126 trend-following configs) that came out
// positive in both halves on both venues. The rebound also scales with how deep the panic
// went — mean 1h forward return ~+0.3-0.5% after a 3% drop, ~+0.6-1.2% after 4%, ~+1.3-2%
// after 5%+ — which is what sizeTier() leans on. Below a 3% drop the effect disappears.
// The mirrored short (fading a buying climax) LOST money on both halves — not traded.

const LOOKBACK = 20; // candles the drop and the volume are measured against (5h on 15m)
const MIN_DROP = 0.03; // close at least this far under the lookback's highest high
const MIN_VOLUME_MULT = 3; // volume at least this many times the lookback average...
// ...and the single biggest of the lookback ("월등히 많은 거래량").
// A panic usually prints several qualifying candles in a row; only the first one of a
// cluster is an entry, matching the backtest's de-clustering (no match in the 7 before).
const COOLDOWN = 7;

function isClimax(candles, index) {
  if (index < LOOKBACK) return null;
  const current = candles[index];
  let refHigh = -Infinity;
  let volumeSum = 0;
  let volumeMax = 0;
  for (let k = index - LOOKBACK; k < index; k += 1) {
    refHigh = Math.max(refHigh, candles[k].high);
    volumeSum += candles[k].volume;
    volumeMax = Math.max(volumeMax, candles[k].volume);
  }
  const drop = (refHigh - current.close) / refHigh;
  const volumeRatio = current.volume / (volumeSum / LOOKBACK);
  if (drop < MIN_DROP || volumeRatio < MIN_VOLUME_MULT || current.volume <= volumeMax) return null;
  return { drop, volumeRatio, refHigh };
}

function detectPanicClimax(candles) {
  const signals = [];
  for (let index = LOOKBACK + COOLDOWN; index < candles.length; index += 1) {
    const hit = isClimax(candles, index);
    if (!hit) continue;
    let clustered = false;
    for (let k = index - COOLDOWN; k < index; k += 1) if (isClimax(candles, k)) clustered = true;
    if (clustered) continue;
    signals.push({
      index,
      direction: "LONG",
      pattern: "panic-climax",
      score: Math.round(hit.drop * 1000) / 10, // drop in %, shown where other patterns show a score
      drop: hit.drop,
      volumeRatio: hit.volumeRatio,
      refHigh: hit.refHigh,
      detail:
        `5시간 고점 $${Math.round(hit.refHigh).toLocaleString()} 대비 ${(hit.drop * 100).toFixed(1)}% 급락, ` +
        `거래량 평균의 ${hit.volumeRatio.toFixed(1)}배(최근 20봉 최대) — 패닉 클라이맥스 반등 진입.`,
    });
  }
  return signals;
}

// Share of the maximum position to commit, by how deep the panic went (1/3, 2/3, all). The
// backtest's per-trade edge roughly doubles at 4% and again at 5%, so the bet follows it:
// 2.38x over the 2 years with these tiers (max drawdown 36%) vs 2.75x always-full (50%)
// and 1.58x always-a-third (19%).
function sizeTier(drop) {
  if (drop >= 0.05) return 3;
  if (drop >= 0.04) return 2;
  return 1;
}

module.exports = { detectPanicClimax, sizeTier, MIN_DROP };
