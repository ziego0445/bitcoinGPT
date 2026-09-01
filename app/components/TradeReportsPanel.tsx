"use client"

import { useEffect, useMemo, useState } from "react"

// Trade-report journal: every real entry (both bots) writes one of these the moment it
// fires — why it entered (reasonDetail, straight from the signal that triggered it) plus
// a chart snapshot captured at that instant (scripts/lib/chart-snapshot.js) — then the
// SAME record gets filled in with the outcome once the position closes. Written by
// scripts/live-trade.js (bot: "bitget") and scripts/live-trade-ict.js (bot: "ict") — see
// scripts/lib/trade-reports.js for the shared shape/lifecycle. This panel just polls both
// bots' files and renders them merged into one feed, newest first.
interface TradeReport {
  id: string
  bot: "bitget" | "ict"
  status: "open" | "closed"
  pattern: string
  mssType?: "MSS" | "BOS" | null
  score?: number
  reasonSummary: string
  reasonDetail: string
  entryTime: number
  entryPrice: number
  takeProfit: number | null
  stopLoss: number | null
  chartSvg: string
  exitTime: number | null
  exitPrice: number | null
  exitReason: "take-profit" | "stop-loss" | string | null
  pnlPct: number | null
  holdingMinutes: number | null
  outcomeSummary: string | null
}

const BITGET_REPORTS_URL = "https://cdn.jsdelivr.net/gh/ziego0445/bitcoinGPT@main/data/trade-reports-bitget.json"
const ICT_REPORTS_URL = "https://cdn.jsdelivr.net/gh/ziego0445/bitcoinGPT@main/data/trade-reports-ict.json"

function usePolledJson<T>(url: string, intervalMs: number): T | null {
  const [data, setData] = useState<T | null>(null)

  useEffect(() => {
    let cancelled = false

    async function load() {
      try {
        const response = await fetch(url, { cache: "no-store" })
        if (!response.ok) throw new Error(`${url} ${response.status}`)
        const next = (await response.json()) as T
        if (!cancelled) setData(next)
      } catch {
        // Keep the last known value on a transient fetch failure.
      }
    }

    load()
    const interval = window.setInterval(load, intervalMs)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [url, intervalMs])

  return data
}

function formatPrice(price: number) {
  return `$${price.toLocaleString("en-US", { maximumFractionDigits: price >= 1000 ? 0 : 2 })}`
}

function formatDateTime(time: number) {
  return new Intl.DateTimeFormat("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(time))
}

const BOT_LABEL: Record<TradeReport["bot"], string> = { bitget: "Bitget · 더블바텀", ict: "OKX · ICT" }
const BOT_BADGE_CLASS: Record<TradeReport["bot"], string> = {
  bitget: "border-pink-400/40 bg-pink-300/10 text-pink-200",
  ict: "border-fuchsia-400/40 bg-fuchsia-300/10 text-fuchsia-200",
}

function ReportCard({ report }: { report: TradeReport }) {
  const isOpen = report.status === "open"
  const won = report.exitReason === "take-profit"

  return (
    <article className="overflow-hidden rounded-2xl border border-[#1c2733] bg-[#0b0f17]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#1a2432] bg-[#0d1420] px-4 py-3">
        <div className="flex items-center gap-2">
          <span className={`rounded-full border px-2.5 py-0.5 text-[10px] font-bold ${BOT_BADGE_CLASS[report.bot]}`}>{BOT_LABEL[report.bot]}</span>
          <span className="text-sm font-semibold text-zinc-100">{report.reasonSummary}</span>
          {report.mssType && <span className="text-xs text-zinc-500">({report.mssType})</span>}
        </div>
        {isOpen ? (
          <span className="flex items-center gap-1.5 rounded-full border border-amber-400/40 bg-amber-300/10 px-2.5 py-0.5 text-[10px] font-bold text-amber-200">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-300 opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-amber-300" />
            </span>
            보유중
          </span>
        ) : (
          <span
            className={`rounded-full border px-2.5 py-0.5 text-[10px] font-bold ${
              won ? "border-emerald-400/40 bg-emerald-300/10 text-emerald-200" : "border-rose-400/40 bg-rose-300/10 text-rose-200"
            }`}
          >
            {won ? "익절" : "손절"} 종료
          </span>
        )}
      </div>

      <div className="grid gap-4 p-4 lg:grid-cols-[1.1fr_1fr]">
        <div
          className="overflow-hidden rounded-xl border border-[#1a2432] bg-black/40 [&_svg]:block [&_svg]:h-auto [&_svg]:w-full"
          dangerouslySetInnerHTML={{ __html: report.chartSvg }}
        />

        <div className="flex flex-col gap-3">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-zinc-500">진입 근거 (당시 판단)</p>
            <pre className="mt-1 whitespace-pre-wrap font-sans text-xs leading-5 text-zinc-300">{report.reasonDetail}</pre>
          </div>

          <div className="grid grid-cols-2 gap-3 rounded-lg border border-[#1a2432] bg-[#080d13] p-3 text-xs">
            <div>
              <p className="text-zinc-500">진입</p>
              <p className="mt-0.5 tabular-nums text-zinc-200">
                {formatPrice(report.entryPrice)} <span className="text-zinc-600">{formatDateTime(report.entryTime)}</span>
              </p>
            </div>
            <div>
              <p className="text-zinc-500">목표/손절</p>
              <p className="mt-0.5 tabular-nums text-zinc-200">
                {report.takeProfit != null ? formatPrice(report.takeProfit) : "-"} / {report.stopLoss != null ? formatPrice(report.stopLoss) : "-"}
              </p>
            </div>
            {!isOpen && report.exitTime != null && report.exitPrice != null && (
              <>
                <div>
                  <p className="text-zinc-500">청산</p>
                  <p className="mt-0.5 tabular-nums text-zinc-200">
                    {formatPrice(report.exitPrice)} <span className="text-zinc-600">{formatDateTime(report.exitTime)}</span>
                  </p>
                </div>
                <div>
                  <p className="text-zinc-500">손익</p>
                  <p className={`mt-0.5 font-semibold tabular-nums ${(report.pnlPct ?? 0) >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                    {(report.pnlPct ?? 0) >= 0 ? "+" : ""}
                    {(report.pnlPct ?? 0).toFixed(2)}%
                  </p>
                </div>
              </>
            )}
          </div>

          {!isOpen && report.outcomeSummary && (
            <div className="rounded-lg border border-[#263545] bg-[#080d13] p-3">
              <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-zinc-500">결과 요약 (마무리)</p>
              <p className="mt-1 text-xs leading-5 text-zinc-300">{report.outcomeSummary}</p>
            </div>
          )}
        </div>
      </div>
    </article>
  )
}

type BotFilter = "all" | "bitget" | "ict"

export default function TradeReportsPanel() {
  const bitgetReports = usePolledJson<TradeReport[]>(BITGET_REPORTS_URL, 30_000)
  const ictReports = usePolledJson<TradeReport[]>(ICT_REPORTS_URL, 30_000)
  const [filter, setFilter] = useState<BotFilter>("all")

  const merged = useMemo(() => {
    const all = [...(bitgetReports ?? []), ...(ictReports ?? [])]
    return all.filter((r) => filter === "all" || r.bot === filter).sort((a, b) => b.entryTime - a.entryTime)
  }, [bitgetReports, ictReports, filter])

  const loaded = bitgetReports != null || ictReports != null
  const openCount = merged.filter((r) => r.status === "open").length
  const closedCount = merged.length - openCount
  const winCount = merged.filter((r) => r.exitReason === "take-profit").length

  return (
    <div className="mx-auto flex max-w-[1360px] flex-col overflow-hidden rounded-2xl border border-[#1b2534] bg-[#0a0e15] shadow-[0_30px_90px_rgba(0,0,0,0.5)]">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1a2432] bg-[#0c1119] px-5 py-4 lg:px-7">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-amber-300/60">실거래 회고 저널</p>
          <div className="mt-0.5 flex items-baseline gap-2">
            <h1 className="text-lg font-semibold text-zinc-50">거래 리포트</h1>
            <span className="text-sm font-medium text-zinc-500">진입 이유 + 당시 차트 + 결과</span>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {loaded && (
            <div className="hidden gap-4 text-right sm:flex">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-zinc-500">보유중</p>
                <p className="text-sm font-semibold tabular-nums text-amber-200">{openCount}</p>
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-zinc-500">청산</p>
                <p className="text-sm font-semibold tabular-nums text-zinc-100">
                  {closedCount}건 {closedCount > 0 && <span className="text-zinc-500">(승 {winCount})</span>}
                </p>
              </div>
            </div>
          )}
          <div className="flex items-center gap-1.5 rounded-full border border-[#28394b] bg-[#0a1017] p-1">
            {([
              ["all", "전체"],
              ["bitget", "Bitget"],
              ["ict", "ICT"],
            ] as [BotFilter, string][]).map(([value, label]) => (
              <button
                key={value}
                onClick={() => setFilter(value)}
                className={`rounded-full px-2.5 py-1 text-xs font-semibold transition ${
                  filter === value ? "bg-amber-400/20 text-amber-200" : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="border-b border-[#1a2432] bg-[#0d1420] px-5 py-3 text-xs text-zinc-400 lg:px-7">
        실제 진입마다 자동으로 한 장씩 쌓입니다 — 왜 그 순간 들어갔는지(신호 근거)와 당시 차트를 함께 남기고, 익절/손절로 끝나면 결과를 채워 넣습니다.
        전략을 다시 조정하거나 회고할 때 이 기록을 근거로 씁니다.
      </div>

      <div className="flex flex-col gap-4 px-5 py-5 lg:px-7">
        {!loaded ? (
          <div className="rounded-xl border border-dashed border-[#263545] bg-[#080d13] p-6 text-center text-sm text-zinc-500">
            리포트를 불러오는 중입니다...
          </div>
        ) : merged.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[#263545] bg-[#080d13] p-6 text-center text-sm text-zinc-500">
            아직 실거래 진입 기록이 없습니다. 두 봇 중 하나라도 진입하면 여기 카드가 쌓입니다.
          </div>
        ) : (
          merged.map((report) => <ReportCard key={report.id} report={report} />)
        )}
      </div>
    </div>
  )
}
