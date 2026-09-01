// Trade-report journal shared shape/helpers for both live-trade bots. Each bot keeps its
// OWN report file (data/trade-reports-bitget.json / data/trade-reports-ict.json) — NOT one
// shared file — because they're two independent persistent Node processes; a single file
// both read-modify-write would race between them. The dashboard (TradeReportsPanel.tsx)
// merges both lists client-side into one feed instead.
//
// Purpose: for every real entry, capture WHY it fired (the signal's own reasoning) and
// WHAT the chart looked like at that moment (see chart-snapshot.js), then fill in the
// outcome once the position closes — a standing record to review/adjust the strategy
// from later, not just a live P&L number.

const fs = require("fs");
const path = require("path");

// Keep the file from growing forever — old reports stay meaningful as history, but a
// bot that runs for months would otherwise bloat this file (and the dashboard payload)
// without bound. Oldest reports drop first once the cap is hit.
const MAX_REPORTS = 150;

function loadReports(reportsPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(reportsPath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveReports(reportsPath, reports) {
  fs.mkdirSync(path.dirname(reportsPath), { recursive: true });
  fs.writeFileSync(reportsPath, JSON.stringify(reports, null, 2) + "\n");
}

// Trims the array IN PLACE (shift(), not slice()) — pruneReports(reports) === reports by
// reference, so returning a freshly-sliced copy here would silently orphan the caller's
// array on the very first prune. Mutating in place is what every call site actually wants.
function pruneReports(reports) {
  while (reports.length > MAX_REPORTS) reports.shift();
  return reports;
}

// `entry` carries everything specific to the strategy (pattern, reasonSummary,
// reasonDetail, entryTime, entryPrice, takeProfit, stopLoss, chartSvg, ...) — this just
// applies the common "open" shape and appends/prunes in place.
function openReport(reports, entry) {
  reports.push({
    status: "open",
    exitTime: null,
    exitPrice: null,
    exitReason: null,
    pnlPct: null,
    holdingMinutes: null,
    outcomeSummary: null,
    ...entry,
  });
  pruneReports(reports);
}

// Finds the most recent still-open report matching `entryTime` (unique per position —
// same value scripts/live-trade*.js already key their own state.openPosition on) and
// fills in the outcome. Returns false if no matching open report was found (shouldn't
// normally happen, but a report file that was pruned/reset out from under a still-open
// position is possible after a long gap — non-fatal, the trade still records in the
// bot's own state file regardless).
function closeReport(reports, entryTime, exit) {
  const report = [...reports].reverse().find((r) => r.status === "open" && r.entryTime === entryTime);
  if (!report) return false;

  report.status = "closed";
  report.exitTime = exit.exitTime;
  report.exitPrice = exit.exitPrice;
  report.exitReason = exit.exitReason;
  report.pnlPct = exit.pnlPct;
  report.holdingMinutes = Math.max(0, Math.round((exit.exitTime - report.entryTime) / 60_000));
  report.outcomeSummary = buildOutcomeSummary({ ...exit, holdingMinutes: report.holdingMinutes, entryPrice: report.entryPrice });
  return true;
}

function buildOutcomeSummary({ exitReason, pnlPct, holdingMinutes, entryPrice, exitPrice }) {
  const resultLabel = exitReason === "take-profit" ? "익절" : exitReason === "stop-loss" ? "손절" : exitReason;
  const durationLabel = holdingMinutes < 60 ? `${holdingMinutes}분` : `${(holdingMinutes / 60).toFixed(1)}시간`;
  const pnlLabel = `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(2)}%`;
  return `${resultLabel} 종료 · ${pnlLabel} · 보유 ${durationLabel} · 진입 $${entryPrice.toLocaleString()} → 청산 $${exitPrice.toLocaleString()}`;
}

module.exports = { loadReports, saveReports, openReport, closeReport, MAX_REPORTS };
