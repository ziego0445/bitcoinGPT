"use client"

import { useEffect, useMemo, useState } from "react"

// ICT (Inner Circle Trader) concept-based signal detection: Liquidity Sweep -> Market
// Structure Shift (MSS) -> Fair Value Gap (FVG) entry. Mirrors scripts/lib/ict-signals.js
// — see that file's header comment for the full rationale and current status. Same
// "keep both copies in sync" convention as signals.js / BitcoinEntryChart.tsx.
//
// STATUS: backtested (150-day/15m BTC, LONG-only), live-traded for real on OKX via
// scripts/live-trade-ict.js — see docs/ict-strategy.md. This component is read-only
// (detects/displays signals, never places orders itself); it polls the real bot's state
// file (LIVE_TRADE_ICT_URL below) once that exists, and falls back to the earlier $100
// paper-trading state otherwise.

type Timeframe = "5m" | "15m" | "1h" | "4h"
type Direction = "LONG" | "SHORT"

interface PaperOpenPosition {
  pattern: string
  mssType: "MSS" | "BOS"
  leverage: number
  size: number
  entryTime: number
  entryPrice: number
  stopLoss: number
  takeProfit: number
}

interface PaperTrade {
  pattern: string
  mssType: "MSS" | "BOS"
  leverage: number
  entryTime: number
  entryPrice: number
  exitTime: number
  exitPrice: number
  exitReason: "take-profit" | "stop-loss"
  pnlPct: number
}

interface PaperTradeState {
  mode: string
  strategy: string
  startingBalance: number
  currentBalance: number
  startedAt: number
  openPosition: PaperOpenPosition | null
  trades: PaperTrade[]
}

interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

interface SwingPoint {
  index: number
  price: number
}

interface IctSignal {
  index: number
  direction: Direction
  pattern: "ict-fvg"
  sweepIndex: number
  sweepPrice: number
  mssIndex: number
  mssLevel: number
  mssType: "MSS" | "BOS"
  fvgLow: number
  fvgHigh: number
  fvgFormedAt: number
  detail: string
}

const CANDLE_LIMIT = 200
const SWING_STRENGTH = 2
const SWEEP_LOOKBACK = 40
const MSS_MAX_GAP = 15

function getSwingPoints(candles: Candle[], strength = SWING_STRENGTH) {
  const highs: SwingPoint[] = []
  const lows: SwingPoint[] = []
  for (let i = strength; i < candles.length - strength; i += 1) {
    const candle = candles[i]
    let isHigh = true
    let isLow = true
    for (let k = i - strength; k <= i + strength; k += 1) {
      if (k === i) continue
      if (candles[k].high >= candle.high) isHigh = false
      if (candles[k].low <= candle.low) isLow = false
    }
    if (isHigh) highs.push({ index: i, price: candle.high })
    if (isLow) lows.push({ index: i, price: candle.low })
  }
  return { highs, lows }
}

// A swing point is only knowable `strength` candles after it prints — using it as if it
// were known at its own index is lookahead bias. See the matching comment in
// scripts/lib/ict-signals.js.
function confirmedBy(points: SwingPoint[], atIndex: number, strength: number) {
  return points.filter((p) => p.index + strength <= atIndex)
}

function findLiquiditySweep(swingLows: SwingPoint[], swingHighs: SwingPoint[], candles: Candle[], index: number, strength: number) {
  const candle = candles[index]
  const priorLow = confirmedBy(swingLows, index, strength).at(-1)
  if (priorLow && candle.low < priorLow.price && candle.close > priorLow.price) {
    return { direction: "bullish" as const, sweptIndex: priorLow.index, sweptPrice: priorLow.price, extreme: candle.low }
  }
  const priorHigh = confirmedBy(swingHighs, index, strength).at(-1)
  if (priorHigh && candle.high > priorHigh.price && candle.close < priorHigh.price) {
    return { direction: "bearish" as const, sweptIndex: priorHigh.index, sweptPrice: priorHigh.price, extreme: candle.high }
  }
  return null
}

// Two extra conditions beyond the bare 3-candle overlap check, both taken from LuxAlgo's
// "ICT Killzones Toolkit" indicator's actual pFVG() logic — see the matching comment in
// scripts/lib/ict-signals.js. The width-filter side (atrSeries/minWidthATR) is plumbed
// through but unused here (always called with null/0) — this dashboard doesn't compute
// ATR itself; scripts/lib/ict-signals.js's computeATR() is there for when a backtest
// script wants to try it.
function findFairValueGap(
  candles: Candle[],
  index: number,
  direction: "bullish" | "bearish",
  atrSeries: (number | null)[] | null,
  minWidthATR = 0,
) {
  if (index < 2) return null
  const first = candles[index - 2]
  const middle = candles[index - 1]
  const third = candles[index]
  const atr = atrSeries ? atrSeries[index] : null
  const minWidth = minWidthATR > 0 && atr != null ? atr * minWidthATR : 0

  if (direction === "bullish" && first.high < third.low && third.low - first.high > minWidth && middle.close > first.high) {
    return { low: first.high, high: third.low, formedAt: index }
  }
  if (direction === "bearish" && first.low > third.high && first.low - third.high > minWidth && middle.close < first.low) {
    return { low: third.high, high: first.low, formedAt: index }
  }
  return null
}

// One forward pass classifying every structure break as "MSS" (first break in a new
// direction — doubles as ICT's CHoCH, a trend reversal) or "BOS" (continues a trend
// already underway). Mirrors LuxAlgo's ICT Concepts indicator's MSS.dir state machine.
// This is the ONLY place structure breaks get computed — detectIctSignals() below looks
// up breaks from this same list rather than re-deriving them per sweep candidate (an
// earlier version had a second, separate findStructureBreak() with its own "closest swing
// as of the sweep" logic, which disagreed with this function's continuously-updated one on
// ~half of all real signals — see the matching comment in scripts/lib/ict-signals.js).
function computeStructureBreaks(candles: Candle[], swingHighs: SwingPoint[], swingLows: SwingPoint[], strength: number) {
  const breaks: { index: number; direction: "bullish" | "bearish"; level: number; type: "MSS" | "BOS" }[] = []
  let trend = 0
  let lastHighBroken: number | null = null
  let lastLowBroken: number | null = null

  for (let index = 0; index < candles.length; index += 1) {
    const swingHigh = confirmedBy(swingHighs, index, strength).at(-1)
    if (swingHigh && candles[index].close > swingHigh.price && swingHigh.price !== lastHighBroken) {
      breaks.push({ index, direction: "bullish", level: swingHigh.price, type: trend <= 0 ? "MSS" : "BOS" })
      trend = 1
      lastHighBroken = swingHigh.price
    }
    const swingLow = confirmedBy(swingLows, index, strength).at(-1)
    if (swingLow && candles[index].close < swingLow.price && swingLow.price !== lastLowBroken) {
      breaks.push({ index, direction: "bearish", level: swingLow.price, type: trend >= 0 ? "MSS" : "BOS" })
      trend = -1
      lastLowBroken = swingLow.price
    }
  }
  return breaks
}

function detectIctSignals(candles: Candle[]): IctSignal[] {
  const { highs: swingHighs, lows: swingLows } = getSwingPoints(candles)
  const structureBreaks = computeStructureBreaks(candles, swingHighs, swingLows, SWING_STRENGTH)
  // Split by direction (each still sorted ascending by index) for the binary-search lookup
  // below. See the matching comment in scripts/lib/ict-signals.js.
  const breaksByDirection: Record<"bullish" | "bearish", typeof structureBreaks> = {
    bullish: structureBreaks.filter((b) => b.direction === "bullish"),
    bearish: structureBreaks.filter((b) => b.direction === "bearish"),
  }
  function firstBreakInWindow(direction: "bullish" | "bearish", afterIndex: number, maxIndex: number) {
    const list = breaksByDirection[direction]
    let lo = 0
    let hi = list.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (list[mid].index <= afterIndex) lo = mid + 1
      else hi = mid
    }
    if (lo >= list.length) return null
    return list[lo].index <= maxIndex ? list[lo] : null
  }
  const signals: IctSignal[] = []
  const firedSetups = new Set<string>()

  for (let index = SWING_STRENGTH * 2 + 5; index < candles.length; index += 1) {
    for (let sweepIndex = index; sweepIndex >= Math.max(0, index - SWEEP_LOOKBACK); sweepIndex -= 1) {
      const sweep = findLiquiditySweep(swingLows, swingHighs, candles, sweepIndex, SWING_STRENGTH)
      if (!sweep) continue

      const mssBreak = firstBreakInWindow(sweep.direction, sweepIndex, Math.min(index, sweepIndex + MSS_MAX_GAP))
      if (!mssBreak) continue
      const mss = { index: mssBreak.index, brokenLevel: mssBreak.level }

      let fvg: { low: number; high: number; formedAt: number } | null = null
      for (let f = mss.index; f >= sweepIndex + 2; f -= 1) {
        fvg = findFairValueGap(candles, f, sweep.direction, null, 0)
        if (fvg) break
      }
      if (!fvg) continue

      const setupKey = `${sweepIndex}-${mss.index}`
      if (firedSetups.has(setupKey)) continue

      const current = candles[index]
      const tappedIn =
        sweep.direction === "bullish"
          ? current.low <= fvg.high && current.low >= fvg.low
          : current.high >= fvg.low && current.high <= fvg.high
      if (!tappedIn) continue

      const invalidated =
        sweep.direction === "bullish"
          ? candles.slice(mss.index + 1, index).some((c) => c.low < sweep.extreme)
          : candles.slice(mss.index + 1, index).some((c) => c.high > sweep.extreme)
      if (invalidated) continue

      firedSetups.add(setupKey)
      signals.push({
        index,
        direction: sweep.direction === "bullish" ? "LONG" : "SHORT",
        pattern: "ict-fvg",
        sweepIndex,
        sweepPrice: sweep.extreme,
        mssIndex: mss.index,
        mssLevel: mss.brokenLevel,
        mssType: mssBreak.type,
        fvgLow: fvg.low,
        fvgHigh: fvg.high,
        fvgFormedAt: fvg.formedAt,
        detail:
          sweep.direction === "bullish"
            ? "저점 유동성 스윕 → 구조 전환(MSS) → FVG 되돌림 진입(롱)"
            : "고점 유동성 스윕 → 구조 전환(MSS) → FVG 되돌림 진입(숏)",
      })
      break
    }
  }

  return signals
}

// scripts/paper-trade-ict.js runs on the same GitHub Actions cron as the Telegram alert
// (every 5 minutes) and commits here — jsDelivr mirrors the raw GitHub content with far
// more generous rate limits, same reason BitcoinEntryChart.tsx reads live-trades.json
// through it instead of raw.githubusercontent.com directly.
const PAPER_TRADE_ICT_URL = "https://cdn.jsdelivr.net/gh/ziego0445/bitcoinGPT@main/data/paper-trades-ict.json"
// scripts/live-trade-ict.js runs persistently on the user's own PC and commits here on
// every state change (see its own jsDelivr-purge comment) — same file shape as the paper
// state above (mode/strategy/startingBalance/currentBalance/startedAt/openPosition/trades),
// just against the real OKX account. Once it exists, it fully replaces the paper display
// below (see the `paperState = liveState ?? rawPaperState` merge) — real trading superseded
// the $100 simulation, it isn't run alongside it.
const LIVE_TRADE_ICT_URL = "https://cdn.jsdelivr.net/gh/ziego0445/bitcoinGPT@main/data/live-trades-ict.json"

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
        // Swallow and keep the last known value — a transient fetch failure shouldn't
        // blank out a panel that already has good data.
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

function formatTime(time: number) {
  return new Intl.DateTimeFormat("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(time))
}

function formatBalance(value: number) {
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// Same small building blocks as BitcoinEntryChart.tsx's status panel (StatPill/StatTile) —
// duplicated rather than imported since that file keeps them as unexported local
// functions, but kept visually identical so both dashboards' "live status" panels read
// the same way.
function StatPill({ label, tone = "neutral" }: { label: string; tone?: "good" | "warn" | "neutral" }) {
  const toneClass =
    tone === "good"
      ? "border-emerald-400/30 bg-emerald-300/10 text-emerald-200"
      : tone === "warn"
        ? "border-rose-400/30 bg-rose-300/10 text-rose-200"
        : "border-[#28394b] bg-[#0a1017] text-zinc-300"

  return <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold ${toneClass}`}>{label}</span>
}

function StatTile({ label, value, tone = "neutral", highlight = false }: { label: string; value: string; tone?: "good" | "bad" | "neutral"; highlight?: boolean }) {
  const valueClass = tone === "good" ? "text-emerald-300" : tone === "bad" ? "text-rose-300" : "text-zinc-200"

  return (
    <div className={`flex-1 rounded-xl border px-3 py-2.5 text-center ${highlight ? "border-amber-400/40 bg-amber-300/5" : "border-[#1c2733] bg-[#080d13]"}`}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-zinc-500">{label}</p>
      <p className={`mt-1 text-lg font-bold tabular-nums ${valueClass}`}>{value}</p>
    </div>
  )
}

const CHART = { width: 1200, height: 520, padding: { top: 16, right: 64, bottom: 24, left: 8 } }

export default function IctStrategyChart() {
  const [timeframe, setTimeframe] = useState<Timeframe>("15m")
  const [candles, setCandles] = useState<Candle[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const rawPaperState = usePolledJson<PaperTradeState>(PAPER_TRADE_ICT_URL, 60_000)
  const liveState = usePolledJson<PaperTradeState>(LIVE_TRADE_ICT_URL, 30_000)
  const isLive = liveState != null
  const paperState = liveState ?? rawPaperState

  useEffect(() => {
    let cancelled = false

    async function load() {
      setLoading(true)
      setError("")
      try {
        const response = await fetch(`https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${timeframe}&limit=${CANDLE_LIMIT}`)
        if (!response.ok) throw new Error(`Binance ${response.status}`)
        const rows = (await response.json()) as [number, string, string, string, string, string][]
        if (cancelled) return
        setCandles(
          rows.map((row) => ({
            time: row[0],
            open: Number(row[1]),
            high: Number(row[2]),
            low: Number(row[3]),
            close: Number(row[4]),
            volume: Number(row[5]),
          })),
        )
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "캔들 데이터를 불러오지 못했습니다.")
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    const interval = window.setInterval(load, 30_000)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [timeframe])

  const closedCandles = useMemo(() => candles.slice(0, -1), [candles])
  const signals = useMemo(() => (closedCandles.length ? detectIctSignals(closedCandles) : []), [closedCandles])
  const recentSignals = useMemo(() => signals.slice(-10), [signals])

  const { min, max } = useMemo(() => {
    if (!candles.length) return { min: 0, max: 1 }
    const lows = candles.map((c) => c.low)
    const highs = candles.map((c) => c.high)
    const rawMin = Math.min(...lows)
    const rawMax = Math.max(...highs)
    const pad = (rawMax - rawMin) * 0.08 || 1
    return { min: rawMin - pad, max: rawMax + pad }
  }, [candles])

  const plotWidth = CHART.width - CHART.padding.left - CHART.padding.right
  const plotHeight = CHART.height - CHART.padding.top - CHART.padding.bottom
  const candleWidth = candles.length ? plotWidth / candles.length : 0
  const bodyWidth = Math.max(1, candleWidth * 0.6)

  function xAt(index: number) {
    return CHART.padding.left + index * candleWidth + candleWidth / 2
  }
  function yAt(price: number) {
    return CHART.padding.top + ((max - price) / (max - min)) * plotHeight
  }
  // Maps a paper-trade timestamp (always on 15m data — see paper-trade-ict.js) onto
  // whichever candle set is currently displayed, same approach as
  // BitcoinEntryChart.tsx's renderTradeMarkers().
  function indexAtTime(time: number) {
    if (!candles.length || time < candles[0].time) return -1
    let found = -1
    for (let i = 0; i < candles.length; i += 1) {
      if (candles[i].time <= time) found = i
      else break
    }
    return found
  }

  const paperReturnPct = paperState ? ((paperState.currentBalance - paperState.startingBalance) / paperState.startingBalance) * 100 : null
  const paperEntryIndex = paperState?.openPosition ? indexAtTime(paperState.openPosition.entryTime) : -1
  const currentPrice = candles.at(-1)?.close
  const openUnrealizedPct =
    paperState?.openPosition && currentPrice
      ? ((currentPrice - paperState.openPosition.entryPrice) / paperState.openPosition.entryPrice) * paperState.openPosition.leverage * 100
      : null
  const closedTrades = paperState?.trades ?? []
  const winCount = closedTrades.filter((trade) => trade.exitReason === "take-profit").length
  const winRatePct = closedTrades.length ? (winCount / closedTrades.length) * 100 : null

  return (
    <div className="mx-auto flex max-w-[1360px] flex-col overflow-hidden rounded-2xl border border-[#1b2534] bg-[#0a0e15] shadow-[0_30px_90px_rgba(0,0,0,0.5)]">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1a2432] bg-[#0c1119] px-5 py-4 lg:px-7">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-fuchsia-300/60">BTCUSDT · ICT Concepts</p>
          <div className="mt-0.5 flex items-baseline gap-2">
            <h1 className="text-lg font-semibold text-zinc-50">유동성 스윕 · MSS · FVG</h1>
            <span
              className={
                isLive
                  ? "rounded-full border border-rose-400/40 bg-rose-300/10 px-2 py-0.5 text-[10px] font-semibold text-rose-200"
                  : "rounded-full border border-amber-400/40 bg-amber-300/10 px-2 py-0.5 text-[10px] font-semibold text-amber-200"
              }
            >
              {isLive ? "실거래 중 · OKX 연동" : "$100 모의투자 중 · 실거래 미연결"}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {paperState && (
            <div className="hidden text-right sm:block">
              <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-zinc-500">{isLive ? "실거래 잔고 (OKX)" : "모의 잔고"}</p>
              <p className="text-sm font-semibold tabular-nums text-zinc-100">
                ${paperState.currentBalance.toFixed(2)}{" "}
                <span className={(paperReturnPct ?? 0) >= 0 ? "text-emerald-300" : "text-rose-300"}>
                  ({(paperReturnPct ?? 0) >= 0 ? "+" : ""}
                  {(paperReturnPct ?? 0).toFixed(1)}%)
                </span>
              </p>
            </div>
          )}
          <div className="flex items-center gap-1.5 rounded-full border border-[#28394b] bg-[#0a1017] p-1">
            {(["5m", "15m", "1h", "4h"] as Timeframe[]).map((tf) => (
              <button
                key={tf}
                onClick={() => setTimeframe(tf)}
                className={`rounded-full px-2.5 py-1 text-xs font-semibold transition ${
                  timeframe === tf ? "bg-fuchsia-400/20 text-fuchsia-200" : "text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {tf}
              </button>
            ))}
          </div>
        </div>
      </header>

      <div className="border-b border-[#1a2432] bg-[#0d1420] px-5 py-3 text-xs text-zinc-400 lg:px-7">
        롱: 저점 유동성 스윕 → 구조 전환(MSS) → FVG 되돌림 진입 · 숏: 고점 스윕 → MSS → FVG 되돌림 진입 (차트엔 참고용으로 둘 다 표시).
        150일 백테스트 결과 롱만 유효했어서(숏은 이 기간 내내 손실 — 상승장 편향일 수 있음),{" "}
        {isLive ? (
          <>
            아래는 <strong className="text-zinc-300">롱 신호만, 손절은 스윕 극값, 목표는 2R</strong>로 사용자 PC에서 상시 실행 중인 실거래
            봇(scripts/live-trade-ict.js)의 실제 체결 기록입니다. 실제 Bitget 계좌·double-bottom 봇과는 완전히 분리된 별도 OKX 계좌예요.
          </>
        ) : (
          <>
            아래 모의투자는 <strong className="text-zinc-300">롱 신호만, 손절은 스윕 극값, 목표는 2R</strong>로 GitHub Actions에서 5분마다
            자동 진행 중입니다. 실제 Bitget 계좌·double-bottom 봇과는 완전히 분리된 $100 가상 잔고예요.
          </>
        )}
      </div>

      <section className="border-b border-[#1a2432] bg-[#0b0f17] px-5 py-5 lg:px-7">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <StatPill label="유동성 스윕 → MSS/BOS → FVG (LONG only)" />
          <StatPill label="10x 레버리지" />
          <StatPill label="R=2 목표 (2R:1R)" />
          <StatPill
            label={winRatePct !== null ? `승률 ${winRatePct.toFixed(0)}% (${winCount}/${closedTrades.length})` : "승률 집계 전"}
            tone={winRatePct === null ? "neutral" : winRatePct >= 50 ? "good" : "warn"}
          />
        </div>

        <div className="mb-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">
            {isLive
              ? "Live trading · OKX 실계좌 · 유동성 스윕→MSS→FVG · 10x 레버리지 · R=2"
              : "$100 모의투자 · 유동성 스윕→MSS→FVG · R=2"}
          </p>
          <h2 className="mt-0.5 text-sm font-semibold text-zinc-400">{isLive ? "실전매매 현황 (Live)" : "모의투자 현황"}</h2>
          <p className="mt-2 text-[10px] font-semibold uppercase tracking-[0.1em] text-zinc-500">비트코인 현재가</p>
          <div className="mt-0.5">
            <span className={`text-3xl font-bold leading-none tracking-tight ${isLive ? "text-rose-200" : "text-amber-200"}`}>
              {currentPrice ? formatPrice(currentPrice) : "불러오는 중..."}
            </span>
          </div>
        </div>

        {paperState && (
          <div className="mb-4 flex gap-2.5">
            <StatTile label="시작 금액" value={formatBalance(paperState.startingBalance)} />
            <StatTile label="현재 금액" value={formatBalance(paperState.currentBalance)} tone={(paperReturnPct ?? 0) >= 0 ? "good" : "bad"} highlight />
            <StatTile
              label="총 손익률"
              value={`${(paperReturnPct ?? 0) >= 0 ? "+" : ""}${(paperReturnPct ?? 0).toFixed(2)}%`}
              tone={(paperReturnPct ?? 0) >= 0 ? "good" : "bad"}
            />
          </div>
        )}

        {!paperState ? (
          <p className="text-sm text-zinc-500">{isLive ? "실전매매 기록을 불러오는 중입니다..." : "모의투자 기록을 불러오는 중입니다..."}</p>
        ) : paperState.openPosition ? (
          <div className={`rounded-xl border px-4 py-3 ${isLive ? "border-rose-300/30 bg-rose-300/5" : "border-amber-300/30 bg-amber-300/5"}`}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-md px-2 py-1 text-[10px] font-bold text-[#061014] ${isLive ? "bg-rose-300/90" : "bg-amber-300/90"}`}>
                  {isLive ? "실전 보유중" : "모의 보유중"}
                </span>
                <span className="rounded-md bg-[#1c2733] px-2 py-1 text-[10px] font-bold text-zinc-300">{paperState.openPosition.leverage}x</span>
                <span className="text-xs text-zinc-400">
                  {paperState.openPosition.mssType} · 투입 {formatBalance(paperState.openPosition.size)} · {formatTime(paperState.openPosition.entryTime)}
                </span>
              </div>
              <span className={`text-sm font-semibold tabular-nums ${(openUnrealizedPct ?? 0) >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                {openUnrealizedPct !== null ? `${openUnrealizedPct >= 0 ? "+" : ""}${openUnrealizedPct.toFixed(2)}% 평가손익` : "-"}
              </span>
            </div>

            <div className="mt-3 grid grid-cols-3 gap-2 border-t border-white/10 pt-3">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-zinc-500">진입가</p>
                <p className="mt-0.5 text-lg font-bold tabular-nums text-amber-200">{formatPrice(paperState.openPosition.entryPrice)}</p>
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-zinc-500">TP 익절가</p>
                <p className="mt-0.5 text-lg font-bold tabular-nums text-emerald-300">{formatPrice(paperState.openPosition.takeProfit)}</p>
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-zinc-500">SL 손절가</p>
                <p className="mt-0.5 text-lg font-bold tabular-nums text-rose-300">{formatPrice(paperState.openPosition.stopLoss)}</p>
              </div>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-[#263545] bg-[#080d13] p-4 text-sm text-zinc-500">
            {isLive
              ? "현재 보유중인 실전 포지션이 없습니다. LONG 신호가 뜨면 OKX 봇(scripts/live-trade-ict.js)이 자동으로 진입합니다."
              : "현재 보유중인 모의 포지션이 없습니다. LONG 신호가 뜨면 GitHub Actions가 자동으로 진입시킵니다."}
          </div>
        )}
      </section>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[#1a2432] bg-[#0a0e15] px-5 py-3 text-[11px] lg:px-7">
        <span className="font-semibold text-zinc-500">차트 보는 법:</span>
        <span className="flex items-center gap-1.5 text-zinc-400">
          <span className="inline-block h-2.5 w-2.5 rounded-full border-2" style={{ borderColor: "#f472b6" }} />
          ①스윕 — 직전 저점/고점을 살짝 뚫고 다시 안으로 마감 (스탑헌팅)
        </span>
        <span className="flex items-center gap-1.5 text-zinc-400">
          <span className="inline-block h-0.5 w-3.5" style={{ backgroundColor: "#22d3ee" }} />
          ②MSS/BOS 점선 — 스윕 반대편 구조 레벨을 종가로 돌파 (MSS=추세 전환, BOS=추세 지속)
        </span>
        <span className="flex items-center gap-1.5 text-zinc-400">
          <span className="inline-block h-2.5 w-3.5 rounded-sm border border-dashed" style={{ borderColor: "#22d3ee", backgroundColor: "rgba(34,211,238,0.15)" }} />
          FVG 박스 — 3개 봉 사이 안 겹치는 빈 구간, 가격이 다시 채우러(되돌림) 오는 자리
        </span>
        <span className="flex items-center gap-1.5 text-zinc-400">
          <span className="inline-block h-2.5 w-2.5 rounded-full border-2" style={{ borderColor: "#22d3ee" }} />
          ③진입 — 가격이 FVG 안으로 되돌아온 순간 (시안=롱, 주황=숏)
        </span>
        <span className="ml-auto flex items-center gap-3 text-zinc-500">
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full border-2" style={{ borderColor: "#facc15" }} />B 모의진입
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-3.5" style={{ backgroundColor: "#4ade80" }} />TP
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-3.5" style={{ backgroundColor: "#f43f5e" }} />SL
          </span>
          <span className="flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-2.5 rounded-full border-2" style={{ borderColor: "#a78bfa" }} />청산
          </span>
        </span>
      </div>

      <div className="relative aspect-[1200/520] w-full bg-[#070a0f]">
        {loading && candles.length === 0 ? (
          <div className="flex h-full items-center justify-center text-zinc-500">불러오는 중...</div>
        ) : error ? (
          <div className="flex h-full items-center justify-center text-red-300">{error}</div>
        ) : (
          <svg viewBox={`0 0 ${CHART.width} ${CHART.height}`} className="h-full w-full">
            {/* Fair Value Gap zones — shaded from formation to where price (if ever) taps in */}
            {signals.map((signal) => {
              const x1 = xAt(signal.fvgFormedAt)
              const x2 = xAt(signal.index) + candleWidth
              const y1 = yAt(signal.fvgHigh)
              const y2 = yAt(signal.fvgLow)
              const boxHeight = Math.max(1, y2 - y1)
              const color = signal.direction === "LONG" ? "#22d3ee" : "#fb923c"
              return (
                <g key={`fvg-${signal.sweepIndex}-${signal.mssIndex}`}>
                  <rect
                    x={x1}
                    y={y1}
                    width={Math.max(1, x2 - x1)}
                    height={boxHeight}
                    fill={color}
                    fillOpacity="0.12"
                    stroke={color}
                    strokeOpacity="0.4"
                    strokeDasharray="4 4"
                  />
                  {/* Label the gap itself so it reads as "FVG" without needing to hover —
                      only when the box is tall enough on screen for text to fit inside. */}
                  {boxHeight >= 12 && (
                    <text x={x1 + 3} y={y1 + boxHeight / 2 + 3} fill={color} fillOpacity="0.85" fontSize="9" fontWeight="700">
                      FVG
                    </text>
                  )}
                </g>
              )
            })}

            {candles.map((candle, index) => {
              const up = candle.close >= candle.open
              const color = up ? "#34d399" : "#fb7185"
              const x = xAt(index)
              const bodyTop = yAt(Math.max(candle.open, candle.close))
              const bodyBottom = yAt(Math.min(candle.open, candle.close))
              return (
                <g key={candle.time}>
                  <line x1={x} x2={x} y1={yAt(candle.high)} y2={yAt(candle.low)} stroke={color} strokeWidth="1.2" />
                  <rect
                    x={x - bodyWidth / 2}
                    y={bodyTop}
                    width={bodyWidth}
                    height={Math.max(1, bodyBottom - bodyTop)}
                    fill={up ? "#0f5135" : "#6f1d2b"}
                    stroke={color}
                    strokeWidth="1"
                  />
                </g>
              )
            })}

            {/* Sweep + MSS + entry markers for each detected setup — labeled directly on
                the chart (1.스윕 2.구조전환 3.진입, matching the order things actually
                happen) rather than only on hover, so the 3-step story reads at a glance. */}
            {signals.map((signal) => {
              const color = signal.direction === "LONG" ? "#22d3ee" : "#fb923c"
              const sweepY = yAt(signal.sweepPrice)
              const sweepLabelY = signal.direction === "LONG" ? sweepY + 16 : sweepY - 10
              const mssMidX = (xAt(signal.sweepIndex) + xAt(signal.mssIndex)) / 2
              const mssLabelY = signal.direction === "LONG" ? yAt(signal.mssLevel) - 6 : yAt(signal.mssLevel) + 13
              const entryY = yAt(signal.direction === "LONG" ? signal.fvgLow : signal.fvgHigh)
              const entryLabelY = signal.direction === "LONG" ? entryY + 18 : entryY - 12
              return (
                <g key={`markers-${signal.sweepIndex}-${signal.mssIndex}`}>
                  <circle cx={xAt(signal.sweepIndex)} cy={sweepY} r="4" fill="#0b1118" stroke="#f472b6" strokeWidth="2">
                    <title>{`① 유동성 스윕 — 직전 스윙${signal.direction === "LONG" ? " 저점" : " 고점"} ${formatPrice(signal.sweepPrice)}을 꼬리로 뚫고 종가는 다시 안쪽으로 마감 (스탑헌팅)`}</title>
                  </circle>
                  <text x={xAt(signal.sweepIndex)} y={sweepLabelY} fill="#f472b6" fontSize="9" fontWeight="700" textAnchor="middle">
                    ①스윕
                  </text>
                  <line
                    x1={xAt(signal.sweepIndex)}
                    x2={xAt(signal.mssIndex)}
                    y1={yAt(signal.mssLevel)}
                    y2={yAt(signal.mssLevel)}
                    stroke={color}
                    strokeWidth="1.4"
                    strokeDasharray="3 3"
                  />
                  <text x={mssMidX} y={mssLabelY} fill={color} fontSize="9" fontWeight="700" textAnchor="middle">
                    ②{signal.mssType}
                  </text>
                  <circle cx={xAt(signal.index)} cy={entryY} r="6" fill="#0b1118" stroke={color} strokeWidth="2">
                    <title>{signal.detail}</title>
                  </circle>
                  <text x={xAt(signal.index)} y={entryLabelY} fill={color} fontSize="9" fontWeight="700" textAnchor="middle">
                    ③진입
                  </text>
                </g>
              )
            })}

            {/* $100 paper-trade state (scripts/paper-trade-ict.js) — same B/TP/SL
                convention as the double-bottom dashboard's live panel, in colors that
                don't collide with the sweep/MSS/FVG markers above (pink/cyan/orange). */}
            {paperState?.openPosition && (
              <g>
                {[
                  { price: paperState.openPosition.entryPrice, color: "#facc15", label: "B" },
                  { price: paperState.openPosition.takeProfit, color: "#4ade80", label: "TP" },
                  { price: paperState.openPosition.stopLoss, color: "#f43f5e", label: "SL" },
                ]
                  .filter((line) => line.price >= min && line.price <= max)
                  .map((line) => (
                    <g key={line.label}>
                      <line
                        x1={CHART.padding.left}
                        x2={CHART.width - CHART.padding.right}
                        y1={yAt(line.price)}
                        y2={yAt(line.price)}
                        stroke={line.color}
                        strokeDasharray="5 5"
                        strokeWidth="1.4"
                        strokeOpacity="0.85"
                      />
                      <text x={CHART.width - CHART.padding.right + 8} y={yAt(line.price) + 4} fill={line.color} fontSize="11" fontWeight="800">
                        {line.label} {formatPrice(line.price)}
                      </text>
                    </g>
                  ))}
                {paperEntryIndex >= 0 && (
                  <circle
                    cx={xAt(paperEntryIndex)}
                    cy={yAt(paperState.openPosition.entryPrice)}
                    r="8"
                    fill="#071017"
                    stroke="#facc15"
                    strokeWidth="2"
                  >
                    <title>{`모의 진입 ${formatPrice(paperState.openPosition.entryPrice)}`}</title>
                  </circle>
                )}
              </g>
            )}
            {paperState?.trades.slice(-20).map((trade) => {
              const entryIndex = indexAtTime(trade.entryTime)
              const exitIndex = indexAtTime(trade.exitTime)
              const won = trade.exitReason === "take-profit"
              return (
                <g key={`${trade.entryTime}-${trade.exitTime}`}>
                  {entryIndex >= 0 && (
                    <circle cx={xAt(entryIndex)} cy={yAt(trade.entryPrice)} r="6" fill="#071017" stroke="#facc15" strokeWidth="1.6">
                      <title>{`모의 진입 ${formatPrice(trade.entryPrice)}`}</title>
                    </circle>
                  )}
                  {exitIndex >= 0 && (
                    <circle cx={xAt(exitIndex)} cy={yAt(trade.exitPrice)} r="7" fill="#071017" stroke="#a78bfa" strokeWidth="1.6">
                      <title>{`모의 청산(${won ? "익절" : "손절"}) ${formatPrice(trade.exitPrice)}`}</title>
                    </circle>
                  )}
                </g>
              )
            })}
          </svg>
        )}
      </div>

      <section className="border-t border-[#1a2432] bg-[#0a0e15] px-5 py-5 lg:px-7">
        <h2 className="mb-3 text-sm font-semibold text-zinc-200">최근 후보 신호</h2>
        {recentSignals.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[#263545] bg-[#080d13] p-5 text-sm text-zinc-500">
            최근 확정 봉에서 조건을 만족하는 후보 신호가 없습니다.
          </div>
        ) : (
          <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
            {[...recentSignals].reverse().map((signal) => (
              <div
                key={`${signal.sweepIndex}-${signal.mssIndex}`}
                className={`rounded-xl border p-3 text-xs ${
                  signal.direction === "LONG" ? "border-cyan-400/30 bg-cyan-300/5" : "border-orange-400/30 bg-orange-300/5"
                }`}
              >
                <div className="mb-1 flex items-center justify-between">
                  <span className={`font-bold ${signal.direction === "LONG" ? "text-cyan-300" : "text-orange-300"}`}>{signal.direction}</span>
                  <span className="text-zinc-500">③진입 {formatTime(closedCandles[signal.index].time)}</span>
                </div>
                <p className="text-zinc-400">{signal.detail}</p>
                <div className="mt-1.5 space-y-0.5 text-zinc-500">
                  <p>
                    <span className="text-[#f472b6]">①스윕</span> {formatTime(closedCandles[signal.sweepIndex].time)} · {formatPrice(signal.sweepPrice)}
                  </p>
                  <p>
                    <span className={signal.direction === "LONG" ? "text-cyan-300" : "text-orange-300"}>②{signal.mssType}</span>{" "}
                    {formatTime(closedCandles[signal.mssIndex].time)} · {formatPrice(signal.mssLevel)}
                  </p>
                  <p>FVG 구간 {formatPrice(signal.fvgLow)} ~ {formatPrice(signal.fvgHigh)}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="border-t border-[#1a2432] bg-[#0b0f17] px-5 py-5 lg:px-7">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Trade history</p>
            <h2 className="mt-1 text-base font-semibold text-zinc-50">{isLive ? "실거래 결과 (OKX, LONG only)" : "모의투자 기록 ($100 시작, LONG only)"}</h2>
          </div>
          {paperState && (
            <span className="text-xs text-zinc-500">
              시작 {formatTime(paperState.startedAt)} · {paperState.trades.length}건 체결
            </span>
          )}
        </div>
        {!paperState ? (
          <div className="rounded-xl border border-dashed border-[#263545] bg-[#080d13] p-5 text-sm text-zinc-500">
            {isLive ? "실거래 기록을 불러오는 중입니다..." : "모의투자 기록을 불러오는 중입니다..."}
          </div>
        ) : paperState.trades.length === 0 && !paperState.openPosition ? (
          <div className="rounded-xl border border-dashed border-[#263545] bg-[#080d13] p-5 text-sm text-zinc-500">
            {isLive
              ? "아직 체결된 실거래 기록이 없습니다. LONG 신호가 뜨면 OKX 봇(scripts/live-trade-ict.js)이 30초 내로 자동 진입합니다."
              : "아직 체결된 모의 트레이드가 없습니다. LONG 신호가 뜨면 GitHub Actions가 5분 내로 자동 진입시킵니다."}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-[#1c2733] text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-zinc-500">
                  <th className="py-2 pr-3">상태</th>
                  <th className="py-2 pr-3">진입</th>
                  <th className="py-2 pr-3">청산</th>
                  <th className="py-2 pr-3">손익</th>
                  <th className="py-2">MSS/BOS</th>
                </tr>
              </thead>
              <tbody>
                {paperState.openPosition && (
                  <tr className="border-b border-[#161f29] text-amber-200">
                    <td className="py-2.5 pr-3 font-semibold">보유중</td>
                    <td className="py-2.5 pr-3 tabular-nums text-zinc-300">
                      {formatPrice(paperState.openPosition.entryPrice)}
                      <span className="ml-1 text-zinc-600">{formatTime(paperState.openPosition.entryTime)}</span>
                    </td>
                    <td className="py-2.5 pr-3 text-zinc-600">-</td>
                    <td className="py-2.5 pr-3 text-zinc-600">-</td>
                    <td className="py-2.5 text-zinc-400">{paperState.openPosition.mssType}</td>
                  </tr>
                )}
                {[...paperState.trades].reverse().map((trade) => {
                  const won = trade.exitReason === "take-profit"
                  return (
                    <tr key={`${trade.entryTime}-${trade.exitTime}`} className="border-b border-[#161f29] last:border-0">
                      <td className="py-2.5 pr-3">
                        <span
                          className={`rounded-md px-2 py-0.5 text-[10px] font-bold ${won ? "bg-emerald-300/15 text-emerald-300" : "bg-rose-300/15 text-rose-300"}`}
                        >
                          {won ? "익절" : "손절"}
                        </span>
                      </td>
                      <td className="py-2.5 pr-3 tabular-nums text-zinc-400">
                        {formatPrice(trade.entryPrice)}
                        <span className="ml-1 text-zinc-600">{formatTime(trade.entryTime)}</span>
                      </td>
                      <td className="py-2.5 pr-3 tabular-nums text-zinc-400">
                        {formatPrice(trade.exitPrice)}
                        <span className="ml-1 text-zinc-600">{formatTime(trade.exitTime)}</span>
                      </td>
                      <td className={`py-2.5 pr-3 tabular-nums font-semibold ${trade.pnlPct >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                        {trade.pnlPct >= 0 ? "+" : ""}
                        {trade.pnlPct.toFixed(2)}%
                      </td>
                      <td className="py-2.5 text-zinc-500">{trade.mssType}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="border-t border-[#1a2432] bg-[#0a0e15] px-5 py-5 lg:px-7">
        <h2 className="mb-1 text-sm font-semibold text-zinc-200">ICT 용어 설명 — 왜 이 자리에서 진입하는가</h2>
        <p className="mb-4 text-xs text-zinc-500">
          위 차트의 ①②③ 번호, &ldquo;최근 후보 신호&rdquo; 카드, 모의투자 표에 나오는 용어들을 하나씩 풀어서 설명합니다.
        </p>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-xl border p-4 text-xs" style={{ borderColor: "#f472b680", backgroundColor: "rgba(244,114,182,0.05)" }}>
            <p className="mb-1.5 text-sm font-bold" style={{ color: "#f472b6" }}>
              ① 유동성 스윕 (Liquidity Sweep)
            </p>
            <p className="text-zinc-400">
              직전 저점/고점 바로 아래·위에는 손절 주문과 돌파 매매 주문이 몰려 있습니다(&ldquo;유동성 풀&rdquo;). 가격이 그 레벨을 <strong className="text-zinc-300">꼬리로 살짝 뚫었다가 종가는 다시 안으로 들어오면</strong>, 그 주문들만 체결시키고(스탑헌팅) 방향을 트는 전형적인 움직임으로 봅니다.
            </p>
            <p className="mt-1.5 text-zinc-500">
              → 이 레벨 아래(위)에 있던 매도(숏) 물량이 소진되고, 그걸 누군가 받아내며 반대 포지션을 만들었을 가능성 — 여기서 &ldquo;왜 반전 후보인지&rdquo;가 시작됩니다.
            </p>
          </div>

          <div className="rounded-xl border p-4 text-xs" style={{ borderColor: "#22d3ee80", backgroundColor: "rgba(34,211,238,0.05)" }}>
            <p className="mb-1.5 text-sm font-bold text-cyan-300">② 구조 전환 MSS(CHoCH) / BOS</p>
            <p className="text-zinc-400">
              <strong className="text-zinc-300">MSS(Market Structure Shift, = CHoCH)</strong>: 지금까지의 추세가 만들어온 마지막 고점(또는 저점)을 <strong className="text-zinc-300">종가로</strong> 넘어서는 것 — 추세가 실제로 꺾였다는 확인.
              <br />
              <strong className="text-zinc-300">BOS(Break of Structure)</strong>: 이미 진행 중이던 방향으로 구조를 한 번 더 갱신 — 추세가 아직 살아있다는 확인.
            </p>
            <p className="mt-1.5 text-zinc-500">
              → 스윕만으론 &ldquo;잠깐 흔들린 것&rdquo;인지 &ldquo;진짜 반전/지속&rdquo;인지 알 수 없습니다. 종가로 구조가 실제로 깨져야 시장 참여자들도 그 방향을 인정한 것으로 봅니다.
            </p>
          </div>

          <div className="rounded-xl border p-4 text-xs" style={{ borderColor: "#22d3ee80", backgroundColor: "rgba(34,211,238,0.05)" }}>
            <p className="mb-1.5 text-sm font-bold text-cyan-300">FVG (Fair Value Gap, 공정가치 갭)</p>
            <p className="text-zinc-400">
              연속된 3개 캔들에서 <strong className="text-zinc-300">1번째 캔들과 3번째 캔들 사이에 가격이 아예 거래되지 않은 빈 구간</strong>이 생기는 경우 — 가운데 캔들이 그만큼 강하고 급하게 한 방향으로 튀었다는 뜻입니다.
            </p>
            <p className="mt-1.5 text-zinc-500">
              → 너무 급하게 지나가서 매수/매도 주문이 제대로 안 채워진 자리라, 시장이 나중에 그 구간을 &ldquo;메우러&rdquo; 되돌아오는 경우가 많습니다. 그 순간이 추세에 올라타면서도 손절은 가깝게 둘 수 있는 진입가입니다.
            </p>
          </div>

          <div className="rounded-xl border border-[#263545] bg-[#080d13] p-4 text-xs">
            <p className="mb-1.5 text-sm font-bold text-amber-200">R배수 / 손절·목표가</p>
            <p className="text-zinc-400">
              <strong className="text-zinc-300">R</strong> = 진입가와 손절가(스윕 극값) 사이의 거리, 즉 이 트레이드에서 감수하는 위험 1단위. <strong className="text-zinc-300">&ldquo;목표 2R&rdquo;</strong>은 그 위험폭의 2배만큼 이익을 목표로 잡는다는 뜻입니다.
            </p>
            <p className="mt-1.5 text-zinc-500">
              → 승률이 50%가 안 돼도(백테스트 기준 약 44%) 이길 때 2배씩 벌기 때문에 장기적으로는 기대값이 플러스가 될 수 있습니다. 승률만 보면 낮아 보여도 정상입니다.
            </p>
          </div>
        </div>

        <div className="mt-3 rounded-xl border border-[#263545] bg-[#080d13] p-4 text-xs text-zinc-400">
          <p className="mb-1 text-sm font-bold text-zinc-200">왜 셋 다 확인돼야 진입하는가</p>
          <p>
            <span style={{ color: "#f472b6" }}>①스윕</span>은 &ldquo;여기서 뭔가 큰 게 일어났다&rdquo;는 신호일 뿐이고, 되돌림일 수도 그냥 소음일 수도 있습니다.{" "}
            <span className="text-cyan-300">②구조 전환</span>이 종가로 확인돼야 그 스윕이 진짜 방향 전환(또는 지속)으로 이어졌다는 게 검증됩니다. 그 다음{" "}
            <span className="text-cyan-300">③FVG 되돌림</span>을 기다리는 이유는, 이미 다 오른(내린) 가격에 뒤늦게 뛰어드는 대신 <strong className="text-zinc-300">손절은 가깝고(스윕 극값) 목표는 먼(2R)</strong> — 위험 대비 보상이 좋은 자리까지 가격이 돌아오길 기다리기 위해서입니다.
            셋 중 하나라도 안 나오면(예: 스윕은 있는데 구조가 안 깨짐) 진입하지 않습니다 — &ldquo;그냥 잠깐 흔들린 것&rdquo;일 가능성이 더 크기 때문입니다.
          </p>
        </div>
      </section>
    </div>
  )
}
