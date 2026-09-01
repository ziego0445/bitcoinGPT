"use client"

import { useEffect, useMemo, useState } from "react"

// ICT (Inner Circle Trader) concept-based signal detection: Liquidity Sweep -> Market
// Structure Shift (MSS) -> Fair Value Gap (FVG) entry. Mirrors scripts/lib/ict-signals.js
// — see that file's header comment for the full rationale and current status. Same
// "keep both copies in sync" convention as signals.js / BitcoinEntryChart.tsx.
//
// STATUS: first structural pass, NOT backtested, NOT connected to any live trading. This
// component is a read-only reference/visualization tool so the detection logic can be
// eyeballed against real charts before anyone considers wiring it up for real orders.

type Timeframe = "5m" | "15m" | "1h" | "4h"
type Direction = "LONG" | "SHORT"

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

function findLiquiditySweep(swingLows: SwingPoint[], swingHighs: SwingPoint[], candles: Candle[], index: number) {
  const candle = candles[index]
  const priorLow = [...swingLows].reverse().find((p) => p.index < index)
  if (priorLow && candle.low < priorLow.price && candle.close > priorLow.price) {
    return { direction: "bullish" as const, sweptIndex: priorLow.index, sweptPrice: priorLow.price, extreme: candle.low }
  }
  const priorHigh = [...swingHighs].reverse().find((p) => p.index < index)
  if (priorHigh && candle.high > priorHigh.price && candle.close < priorHigh.price) {
    return { direction: "bearish" as const, sweptIndex: priorHigh.index, sweptPrice: priorHigh.price, extreme: candle.high }
  }
  return null
}

function findStructureBreak(
  swingHighs: SwingPoint[],
  swingLows: SwingPoint[],
  candles: Candle[],
  fromIndex: number,
  toIndex: number,
  direction: "bullish" | "bearish",
) {
  if (direction === "bullish") {
    const swingHigh = [...swingHighs].reverse().find((p) => p.index > fromIndex && p.index < toIndex)
    if (swingHigh && candles[toIndex].close > swingHigh.price) return { index: toIndex, brokenLevel: swingHigh.price }
  } else {
    const swingLow = [...swingLows].reverse().find((p) => p.index > fromIndex && p.index < toIndex)
    if (swingLow && candles[toIndex].close < swingLow.price) return { index: toIndex, brokenLevel: swingLow.price }
  }
  return null
}

function findFairValueGap(candles: Candle[], index: number, direction: "bullish" | "bearish") {
  if (index < 2) return null
  const first = candles[index - 2]
  const third = candles[index]
  if (direction === "bullish" && first.high < third.low) return { low: first.high, high: third.low, formedAt: index }
  if (direction === "bearish" && first.low > third.high) return { low: third.high, high: first.low, formedAt: index }
  return null
}

function detectIctSignals(candles: Candle[]): IctSignal[] {
  const { highs: swingHighs, lows: swingLows } = getSwingPoints(candles)
  const signals: IctSignal[] = []
  const firedSetups = new Set<string>()

  for (let index = SWING_STRENGTH * 2 + 5; index < candles.length; index += 1) {
    for (let sweepIndex = index; sweepIndex >= Math.max(0, index - SWEEP_LOOKBACK); sweepIndex -= 1) {
      const sweep = findLiquiditySweep(swingLows, swingHighs, candles, sweepIndex)
      if (!sweep) continue

      let mss: { index: number; brokenLevel: number } | null = null
      let fvg: { low: number; high: number; formedAt: number } | null = null
      for (let k = sweepIndex + 1; k <= Math.min(index, sweepIndex + MSS_MAX_GAP); k += 1) {
        if (!mss) mss = findStructureBreak(swingHighs, swingLows, candles, sweepIndex, k, sweep.direction)
        if (mss && !fvg) {
          for (let f = mss.index; f >= sweepIndex + 2; f -= 1) {
            fvg = findFairValueGap(candles, f, sweep.direction)
            if (fvg) break
          }
        }
        if (mss && fvg) break
      }
      if (!mss || !fvg) continue

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

function formatPrice(price: number) {
  return `$${price.toLocaleString("en-US", { maximumFractionDigits: price >= 1000 ? 0 : 2 })}`
}

function formatTime(time: number) {
  return new Intl.DateTimeFormat("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(time))
}

const CHART = { width: 1200, height: 520, padding: { top: 16, right: 64, bottom: 24, left: 8 } }

export default function IctStrategyChart() {
  const [timeframe, setTimeframe] = useState<Timeframe>("15m")
  const [candles, setCandles] = useState<Candle[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")

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

  return (
    <div className="mx-auto flex max-w-[1360px] flex-col overflow-hidden rounded-2xl border border-[#1b2534] bg-[#0a0e15] shadow-[0_30px_90px_rgba(0,0,0,0.5)]">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-[#1a2432] bg-[#0c1119] px-5 py-4 lg:px-7">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-fuchsia-300/60">BTCUSDT · ICT Concepts</p>
          <div className="mt-0.5 flex items-baseline gap-2">
            <h1 className="text-lg font-semibold text-zinc-50">유동성 스윕 · MSS · FVG</h1>
            <span className="rounded-full border border-amber-400/40 bg-amber-300/10 px-2 py-0.5 text-[10px] font-semibold text-amber-200">
              실험적 · 백테스트 전 · 실거래 미연결
            </span>
          </div>
        </div>
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
      </header>

      <div className="border-b border-[#1a2432] bg-[#0d1420] px-5 py-3 text-xs text-zinc-400 lg:px-7">
        롱: 저점 유동성 스윕 → 구조 전환(MSS) → FVG 되돌림 진입 · 숏: 고점 스윕 → MSS → FVG 되돌림 진입.
        아직 백테스트/파라미터 튜닝 전이라 참고용으로만 봐주세요 — double-bottom 실거래 봇과는 별개로 동작합니다.
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
              const color = signal.direction === "LONG" ? "#22d3ee" : "#fb923c"
              return (
                <rect
                  key={`fvg-${signal.sweepIndex}-${signal.mssIndex}`}
                  x={x1}
                  y={y1}
                  width={Math.max(1, x2 - x1)}
                  height={Math.max(1, y2 - y1)}
                  fill={color}
                  fillOpacity="0.12"
                  stroke={color}
                  strokeOpacity="0.4"
                  strokeDasharray="4 4"
                />
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

            {/* Sweep + MSS + entry markers for each detected setup */}
            {signals.map((signal) => {
              const color = signal.direction === "LONG" ? "#22d3ee" : "#fb923c"
              return (
                <g key={`markers-${signal.sweepIndex}-${signal.mssIndex}`}>
                  <circle cx={xAt(signal.sweepIndex)} cy={yAt(signal.sweepPrice)} r="4" fill="#0b1118" stroke="#f472b6" strokeWidth="2">
                    <title>{`유동성 스윕 ${formatPrice(signal.sweepPrice)}`}</title>
                  </circle>
                  <line
                    x1={xAt(signal.sweepIndex)}
                    x2={xAt(signal.mssIndex)}
                    y1={yAt(signal.mssLevel)}
                    y2={yAt(signal.mssLevel)}
                    stroke={color}
                    strokeWidth="1.4"
                    strokeDasharray="3 3"
                  />
                  <circle cx={xAt(signal.index)} cy={yAt(signal.direction === "LONG" ? signal.fvgLow : signal.fvgHigh)} r="6" fill="#0b1118" stroke={color} strokeWidth="2">
                    <title>{signal.detail}</title>
                  </circle>
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
                  <span className="text-zinc-500">{formatTime(closedCandles[signal.index].time)}</span>
                </div>
                <p className="text-zinc-400">{signal.detail}</p>
                <p className="mt-1.5 text-zinc-500">
                  스윕 {formatPrice(signal.sweepPrice)} · MSS {formatPrice(signal.mssLevel)} · FVG {formatPrice(signal.fvgLow)}~{formatPrice(signal.fvgHigh)}
                </p>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
