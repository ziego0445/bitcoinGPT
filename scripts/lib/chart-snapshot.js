// Renders a small, self-contained SVG candlestick snapshot — no headless browser, no
// canvas/image dependency, just a hand-built SVG string (same "no charting library"
// convention as the dashboard's own React components). Used by the live-trade bots to
// capture "what the chart looked like at the moment we entered" for the trade-report
// journal (see scripts/lib/trade-reports.js) — a plain SVG embeds directly into the
// dashboard and into the state JSON without any extra asset pipeline or dependency.

function escapeXml(str) {
  return String(str).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

// candles: [{time, open, high, low, close}], oldest first.
// markers: [{index, color, label}] — a labeled dot on one candle (e.g. the entry candle).
// lines: [{price, color, label}] — a horizontal reference line across the whole width
//   (take-profit / stop-loss / a structural reference level).
function renderCandleSnapshot({ candles, title, markers = [], lines = [], width = 760, height = 340 }) {
  const padding = { top: 30, right: 66, bottom: 20, left: 6 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  if (!candles.length) {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}"><rect width="${width}" height="${height}" fill="#05070a"/></svg>`;
  }

  const prices = candles.flatMap((c) => [c.low, c.high]).concat(lines.map((l) => l.price));
  const rawMin = Math.min(...prices);
  const rawMax = Math.max(...prices);
  const pricePad = (rawMax - rawMin) * 0.08 || 1;
  const min = rawMin - pricePad;
  const max = rawMax + pricePad;

  const candleWidth = plotWidth / candles.length;
  const bodyWidth = Math.max(1, candleWidth * 0.6);

  function xAt(index) {
    return padding.left + index * candleWidth + candleWidth / 2;
  }
  function yAt(price) {
    return padding.top + ((max - price) / (max - min)) * plotHeight;
  }

  const candleSvg = candles
    .map((candle, index) => {
      const isUp = candle.close >= candle.open;
      const color = isUp ? "#34d399" : "#f87171";
      const x = xAt(index);
      const highY = yAt(candle.high);
      const lowY = yAt(candle.low);
      const openY = yAt(candle.open);
      const closeY = yAt(candle.close);
      const bodyTop = Math.min(openY, closeY);
      const bodyHeight = Math.max(1, Math.abs(closeY - openY));
      return (
        `<line x1="${x}" y1="${highY}" x2="${x}" y2="${lowY}" stroke="${color}" stroke-width="1"/>` +
        `<rect x="${x - bodyWidth / 2}" y="${bodyTop}" width="${bodyWidth}" height="${bodyHeight}" fill="${color}"/>`
      );
    })
    .join("");

  const lineSvg = lines
    .map((line) => {
      const y = yAt(line.price);
      return (
        `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="${line.color}" stroke-width="1.2" stroke-dasharray="4,3"/>` +
        `<text x="${width - padding.right + 4}" y="${y + 3}" font-size="10" fill="${line.color}" font-family="Consolas,monospace">${escapeXml(line.label)}</text>`
      );
    })
    .join("");

  const markerSvg = markers
    .filter((m) => m.index >= 0 && m.index < candles.length)
    .map((m) => {
      const x = xAt(m.index);
      const y = yAt(candles[m.index].close);
      return (
        `<circle cx="${x}" cy="${y}" r="4.5" fill="${m.color}" stroke="#05070a" stroke-width="1.5"/>` +
        `<text x="${x}" y="${y - 9}" font-size="10" fill="${m.color}" font-family="Consolas,monospace" text-anchor="middle">${escapeXml(m.label)}</text>`
      );
    })
    .join("");

  const titleSvg = title
    ? `<text x="${padding.left}" y="16" font-size="12" fill="#e7e9ee" font-family="Consolas,monospace">${escapeXml(title)}</text>`
    : "";

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">` +
    `<rect width="${width}" height="${height}" fill="#05070a"/>` +
    titleSvg +
    candleSvg +
    lineSvg +
    markerSvg +
    `</svg>`
  );
}

module.exports = { renderCandleSnapshot };
