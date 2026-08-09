"use client"

import { useEffect, useMemo, useState } from "react"

type Timeframe = "1m" | "5m" | "15m" | "1h"
type Direction = "LONG" | "WAIT"
type Pattern = "panic" | "double-bottom" | "divergence" | "slow-bottom" | "avoid"

interface Candle {
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

interface PivotLow {
  index: number
  price: number
  momentum: number
  volume: number
}

interface EntrySignal {
  index: number
  direction: Direction
  score: number
  pattern: Pattern
  label: string
  detail: string
}

interface SupportLevel {
  price: number
  kind: "pivot" | "round"
}

const TIMEFRAMES: Timeframe[] = ["1m", "5m", "15m", "1h"]
const CANDLE_LIMIT = 121
const MAX_EVENT_CARDS = 10

function KakaoAd({ unit, width, height }: { unit: string; width: number; height: number }) {
  return (
    <div className="flex min-h-[120px] items-center justify-center border border-[#1b2938] bg-[#080d13] p-2">
      <ins
        className="kakao_ad_area"
        style={{ display: "none" }}
        data-ad-unit={unit}
        data-ad-width={width}
        data-ad-height={height}
      />
    </div>
  )
}

function toCandle(item: unknown[]): Candle {
  return {
    time: Number(item[0]),
    open: Number(item[1]),
    high: Number(item[2]),
    low: Number(item[3]),
    close: Number(item[4]),
    volume: Number(item[5]),
  }
}

function average(values: number[]) {
  if (!values.length) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function priceY(price: number, min: number, max: number, height: number) {
  if (max === min) return height / 2
  return ((max - price) / (max - min)) * height
}

function bodySize(candle: Candle) {
  return Math.abs(candle.close - candle.open)
}

function rangeSize(candle: Candle) {
  return Math.max(candle.high - candle.low, 1)
}

function lowerWickRatio(candle: Candle) {
  return (Math.min(candle.open, candle.close) - candle.low) / rangeSize(candle)
}

function momentumAt(candles: Candle[], index: number) {
  const lookback = Math.max(0, index - 5)
  return candles[index].close - candles[lookback].close
}

function getPivotLows(candles: Candle[], endIndex = candles.length - 1): PivotLow[] {
  const pivots: PivotLow[] = []

  for (let index = 3; index <= endIndex - 3; index += 1) {
    const candle = candles[index]
    const left = candles.slice(index - 3, index)
    const right = candles.slice(index + 1, index + 4)
    const isPivot = [...left, ...right].every((item) => candle.low <= item.low)

    if (isPivot) {
      pivots.push({
        index,
        price: candle.low,
        momentum: momentumAt(candles, index),
        volume: candle.volume,
      })
    }
  }

  return pivots
}

function roundStep(price: number) {
  if (price >= 100_000) return 5_000
  if (price >= 30_000) return 1_000
  if (price >= 10_000) return 500
  return 100
}

function getSupportLevels(candles: Candle[]): SupportLevel[] {
  if (!candles.length) return []

  const pivots = getPivotLows(candles).slice(-5).map((pivot) => ({
    price: pivot.price,
    kind: "pivot" as const,
  }))
  const current = candles.at(-1)?.close ?? 0
  const step = roundStep(current)
  const round = Math.floor(current / step) * step
  const roundLevels = [round - step, round, round + step]
    .filter((price) => price > 0)
    .map((price) => ({ price, kind: "round" as const }))

  return [...pivots, ...roundLevels]
}

function isNearSupport(price: number, supports: SupportLevel[], tolerance = 0.006) {
  return supports.some((support) => Math.abs(price - support.price) / support.price <= tolerance)
}

function detectSignals(candles: Candle[]): EntrySignal[] {
  const signals: EntrySignal[] = []

  for (let index = 16; index < candles.length; index += 1) {
    const current = candles[index]
    const recent = candles.slice(index - 10, index)
    const lastFour = candles.slice(index - 3, index + 1)
    const avgVolume = average(recent.map((candle) => candle.volume))
    const avgBody = average(recent.map(bodySize))
    const avgRange = average(recent.map(rangeSize))
    const volumeSpike = avgVolume > 0 ? current.volume / avgVolume : 0
    const bodyExpansion = avgBody > 0 ? bodySize(current) / avgBody : 0
    const rangeExpansion = avgRange > 0 ? rangeSize(current) / avgRange : 0
    const freshLow = current.low <= Math.min(...recent.map((candle) => candle.low))
    const lastBody = bodySize(current)
    const firstBody = bodySize(lastFour[0])
    const fallingCloses = lastFour.every((candle, candleIndex) => {
      if (candleIndex === 0) return true
      return candle.close <= lastFour[candleIndex - 1].close
    })
    const firstCandleDominates = firstBody > avgBody * 1.7 && firstBody > lastBody * 1.25
    const highSellVolumeIntoRetest = lastFour.every((candle) => candle.close < candle.open && candle.volume > avgVolume * 1.15)
    const supports = getSupportLevels(candles.slice(0, index + 1))
    const supportNearby = isNearSupport(current.low, supports)
    const pivots = getPivotLows(candles, index - 1)
    const previousPivot = pivots.at(-1)
    const nearPreviousLow = previousPivot
      ? Math.abs(current.low - previousPivot.price) / previousPivot.price <= 0.007
      : false
    const slightlyBrokenDoubleBottom = previousPivot
      ? current.low < previousPivot.price && (previousPivot.price - current.low) / previousPivot.price <= 0.012
      : false
    const currentMomentum = momentumAt(candles, index)
    const bullishDivergence = previousPivot
      ? current.low <= previousPivot.price * 1.004 && currentMomentum > previousPivot.momentum
      : false
    const retestVolumeOk = previousPivot ? current.volume <= previousPivot.volume * 1.15 || volumeSpike <= 1.35 : false
    const wickOk = lowerWickRatio(current) >= 0.34
    const sellingSlows =
      current.volume < avgVolume * 0.95 &&
      bodySize(current) < avgBody * 0.9 &&
      rangeSize(current) < avgRange * 0.95

    if ((firstCandleDominates && fallingCloses) || highSellVolumeIntoRetest) {
      signals.push({
        index,
        direction: "WAIT",
        score: 35,
        pattern: "avoid",
        label: "WAIT",
        detail: "첫 장대봉이 지배적이거나 저점 재방문까지 매도 거래량이 과합니다. 빠른 롱 금지.",
      })
      continue
    }

    if (freshLow && volumeSpike >= 2.0 && rangeExpansion >= 1.45 && bodyExpansion >= 1.1 && (wickOk || supportNearby)) {
      signals.push({
        index,
        direction: "LONG",
        score: clamp(70 + volumeSpike * 5 + rangeExpansion * 4 + bodyExpansion * 3 + (supportNearby ? 6 : 0), 70, 96),
        pattern: "panic",
        label: "PANIC",
        detail: "마지막 장대봉, 거래량 폭발, 지지/꼬리 조건이 겹친 패닉셀 반등 후보.",
      })
      continue
    }

    if ((nearPreviousLow || slightlyBrokenDoubleBottom) && retestVolumeOk && (wickOk || bullishDivergence)) {
      signals.push({
        index,
        direction: "LONG",
        score: clamp(66 + (bullishDivergence ? 10 : 0) + (wickOk ? 6 : 0) + (supportNearby ? 5 : 0), 66, 92),
        pattern: "double-bottom",
        label: "DOUBLE",
        detail: "직전 저점 부근 재방문. 거래량이 과하지 않고 꼬리/다이버전스가 붙은 쌍바닥 후보.",
      })
      continue
    }

    if (freshLow && bullishDivergence && supportNearby) {
      signals.push({
        index,
        direction: "LONG",
        score: 72,
        pattern: "divergence",
        label: "DIV",
        detail: "저점은 낮거나 비슷하지만 모멘텀은 덜 빠지는 상승 다이버전스 후보.",
      })
      continue
    }

    if (freshLow && sellingSlows && (wickOk || current.close >= current.open)) {
      signals.push({
        index,
        direction: "LONG",
        score: 58,
        pattern: "slow-bottom",
        label: "SLOW",
        detail: "하락 폭과 거래량이 줄어드는 바닥 다지기 후보. 반등은 느릴 수 있음.",
      })
    }
  }

  return signals
}

function formatPrice(price: number) {
  return `$${Math.round(price).toLocaleString()}`
}

function formatTime(time: number, timeframe: Timeframe) {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    month: timeframe === "1h" ? "2-digit" : undefined,
    day: timeframe === "1h" ? "2-digit" : undefined,
  }).format(new Date(time))
}

function signalKey(signal: EntrySignal) {
  return `${signal.index}-${signal.pattern}`
}

function signalTitle(signal?: EntrySignal) {
  if (!signal) return "관망"

  const names: Record<Pattern, string> = {
    panic: "패닉셀 반등 후보",
    "double-bottom": "쌍바닥 후보",
    divergence: "상승 다이버전스 후보",
    "slow-bottom": "바닥 다지기 후보",
    avoid: "빠른 진입 금지",
  }

  return names[signal.pattern]
}

function signalReasons(signal?: EntrySignal) {
  if (!signal) {
    return ["확실한 거래량 폭발이 없습니다.", "쌍바닥이나 지지선 반응이 아직 약합니다.", "무리한 진입보다 관망이 우선입니다."]
  }

  const reasons: Record<Pattern, string[]> = {
    panic: ["최근 저점을 새로 만들었습니다.", "평균보다 거래량이 크게 늘었습니다.", "긴 봉 또는 아래꼬리로 매수 반응이 보입니다."],
    "double-bottom": ["직전 저점 부근을 다시 테스트했습니다.", "재하락 거래량이 과하지 않습니다.", "아래꼬리 또는 다이버전스가 붙었습니다."],
    divergence: ["가격은 저점 부근인데 하락 힘은 약해졌습니다.", "최근 지지선 근처에서 버티는 흐름입니다.", "추격보다 반등 확인용 포인트입니다."],
    "slow-bottom": ["하락 폭이 점점 줄어듭니다.", "거래량도 같이 줄어 매도 압력이 둔해졌습니다.", "반등은 느릴 수 있어 확인이 필요합니다."],
    avoid: ["첫 장대봉이 너무 강합니다.", "저점까지 매도 거래량이 계속 큽니다.", "PDF 기준 빠른 롱을 피하는 자리입니다."],
  }

  return reasons[signal.pattern]
}

function getDisplaySignals(signals: EntrySignal[]) {
  const recentCandidates = signals
    .filter((signal) => signal.score >= 64 || signal.pattern === "avoid")
    .sort((a, b) => b.index - a.index)

  const picked: EntrySignal[] = []

  for (const signal of recentCandidates) {
    const tooClose = picked.some((item) => Math.abs(item.index - signal.index) < 9)
    if (!tooClose) {
      picked.push(signal)
    }
    if (picked.length >= MAX_EVENT_CARDS) break
  }

  return picked.sort((a, b) => a.index - b.index)
}

function shortReason(signal: EntrySignal) {
  const reasons: Record<Pattern, string> = {
    panic: "거래량 폭발 + 마지막 장대봉",
    "double-bottom": "직전 저점 재방문",
    divergence: "저점 대비 하락 힘 둔화",
    "slow-bottom": "거래량/하락폭 감소",
    avoid: "첫 장대봉 과열",
  }

  return reasons[signal.pattern]
}

function formatCardTime(time: number) {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(time))
}

export default function BitcoinEntryChart() {
  const [timeframe, setTimeframe] = useState<Timeframe>("15m")
  const [candles, setCandles] = useState<Candle[]>([])
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const [selectedSignalKey, setSelectedSignalKey] = useState("")

  useEffect(() => {
    const scriptId = "kakao-ad-script"
    if (document.getElementById(scriptId)) return

    const script = document.createElement("script")
    script.id = scriptId
    script.async = true
    script.src = "https://t1.kakaocdn.net/kas/static/ba.min.js"
    document.body.appendChild(script)
  }, [])

  useEffect(() => {
    let cancelled = false

    async function loadCandles() {
      setLoading(true)
      setError("")

      try {
        const response = await fetch(
          `https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=${timeframe}&limit=${CANDLE_LIMIT}`,
          { cache: "no-store" },
        )

        if (!response.ok) {
          throw new Error(`Binance API ${response.status}`)
        }

        const data = (await response.json()) as unknown[][]
        const nextCandles = data.map(toCandle).filter((candle) => Number.isFinite(candle.close))

        if (!cancelled) {
          setCandles(nextCandles)
        }
      } catch {
        if (!cancelled) {
          setError("시세 데이터를 불러오지 못했습니다.")
        }
      } finally {
        if (!cancelled) {
          setLoading(false)
        }
      }
    }

    loadCandles()
    const interval = window.setInterval(loadCandles, 30_000)

    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [timeframe])

  // The final Binance candle is still forming. Signals use only closed candles,
  // while the chart keeps the live candle visible for price context.
  const closedCandles = useMemo(() => candles.slice(0, -1), [candles])
  const signals = useMemo(() => detectSignals(closedCandles), [closedCandles])
  const displaySignals = useMemo(() => getDisplaySignals(signals), [signals])
  const latestSignal = displaySignals.at(-1)
  const selectedSignal = displaySignals.find((signal) => signalKey(signal) === selectedSignalKey) ?? latestSignal
  const supportLevels = useMemo(() => getSupportLevels(candles), [candles])
  const chart = useMemo(() => {
    const width = 1200
    const priceHeight = 590
    const volumeHeight = 130
    const gap = 18
    const height = priceHeight + volumeHeight + gap
    const padding = { top: 18, right: 76, bottom: 28, left: 10 }
    const innerWidth = width - padding.left - padding.right
    const prices = candles.flatMap((candle) => [candle.high, candle.low])
    const minPrice = Math.min(...prices)
    const maxPrice = Math.max(...prices)
    const pricePadding = (maxPrice - minPrice) * 0.08 || 1
    const min = minPrice - pricePadding
    const max = maxPrice + pricePadding
    const candleWidth = innerWidth / Math.max(candles.length, 1)
    const bodyWidth = Math.max(3, candleWidth * 0.58)
    const maxVolume = Math.max(...candles.map((candle) => candle.volume), 1)
    const levels = Array.from({ length: 6 }, (_, index) => {
      const price = min + ((max - min) / 5) * index
      return {
        price,
        y: padding.top + priceY(price, min, max, priceHeight),
      }
    })

    return {
      width,
      height,
      priceHeight,
      volumeHeight,
      gap,
      padding,
      min,
      max,
      candleWidth,
      bodyWidth,
      maxVolume,
      levels,
    }
  }, [candles])

  const currentPrice = candles.at(-1)?.close
  const previousPrice = candles.at(-2)?.close
  const priceMove = currentPrice && previousPrice ? ((currentPrice - previousPrice) / previousPrice) * 100 : 0
  const latestVolume = candles.at(-1)?.volume ?? 0
  const baselineVolume = average(candles.slice(-21, -1).map((candle) => candle.volume))
  const volumeRatio = baselineVolume > 0 ? latestVolume / baselineVolume : 0
  const selectedCandle = selectedSignal ? candles[selectedSignal.index] : undefined
  const selectedSignalNumber = selectedSignal
    ? displaySignals.findIndex((signal) => signalKey(signal) === signalKey(selectedSignal)) + 1
    : 0
  const updateTime = candles.at(-1)?.time
  const signalTone = selectedSignal?.direction === "LONG" ? "text-cyan-200" : "text-amber-200"

  useEffect(() => {
    if (!displaySignals.length) {
      setSelectedSignalKey("")
      return
    }

    const selectedStillExists = displaySignals.some((signal) => signalKey(signal) === selectedSignalKey)
    if (!selectedSignalKey || !selectedStillExists) {
      setSelectedSignalKey(signalKey(displaySignals[displaySignals.length - 1]))
    }
  }, [displaySignals, selectedSignalKey])

  return (
    <main className="min-h-screen bg-[#06080c] text-zinc-100">
      <div className="mx-auto flex min-h-screen max-w-[1680px] flex-col border-x border-[#182330] bg-[#080b10] shadow-[0_0_80px_rgba(0,0,0,0.35)]">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-[#1d2a38] bg-[#0b1017] px-4 py-4 lg:px-6">
          <div className="flex items-center gap-4">
            <div className="grid h-11 w-11 place-items-center border border-cyan-300/50 bg-cyan-300/10 text-sm font-black text-cyan-200">B</div>
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-cyan-300/75">BTCUSDT / Binance</p>
              <h1 className="mt-0.5 text-xl font-semibold text-zinc-50">Bitcoin Entry Radar</h1>
            </div>
            <div className="hidden border-l border-[#263545] pl-4 sm:block">
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-zinc-500">Live move</p>
              <p className={`mt-0.5 text-sm font-semibold ${priceMove >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                {priceMove >= 0 ? "+" : ""}{priceMove.toFixed(2)}%
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden text-right md:block">
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-zinc-500">Last update</p>
              <p className="mt-0.5 text-xs text-zinc-300">{updateTime ? formatCardTime(updateTime) : "--:--"}</p>
            </div>
            <div className="flex rounded-md border border-[#263545] bg-[#070b10] p-1">
            {TIMEFRAMES.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setTimeframe(item)}
                className={`h-8 min-w-11 rounded px-3 text-sm font-semibold transition ${
                  timeframe === item
                    ? "bg-cyan-300 text-[#061014] shadow-[0_0_18px_rgba(103,232,249,0.22)]"
                    : "text-zinc-500 hover:bg-[#141d28] hover:text-zinc-100"
                }`}
              >
                {item}
              </button>
            ))}
            </div>
          </div>
        </header>

        <section className="border-b border-[#1d2a38] bg-[#090e14] px-4 py-5 lg:px-6">
          <div className="mb-4 flex items-end justify-between gap-4">
            <div>
              <p className="text-[11px] font-bold uppercase tracking-[0.16em] text-zinc-500">Signal timeline</p>
              <h2 className="mt-1 text-lg font-semibold text-zinc-50">최근 확정 신호</h2>
            </div>
            <div className="hidden items-center gap-2 text-xs text-zinc-500 md:flex"><span className="h-2 w-2 rounded-full bg-emerald-400" />30초마다 시세 갱신</div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
            {displaySignals.length === 0 ? (
              <div className="border border-dashed border-[#263545] bg-[#080d13] p-5 text-sm text-zinc-500 xl:col-span-5">
                최근 확정 봉에서 기준을 만족하는 진입 참고 신호가 없습니다.
              </div>
            ) : (
              [...displaySignals].reverse().map((signal) => {
                const candle = candles[signal.index]
                const selected = selectedSignal ? signalKey(signal) === signalKey(selectedSignal) : false
                const eventNumber = displaySignals.findIndex((item) => signalKey(item) === signalKey(signal)) + 1
                const accent = signal.direction === "LONG" ? "cyan" : "amber"

                return (
                  <button
                    key={signalKey(signal)}
                    type="button"
                    onClick={() => setSelectedSignalKey(signalKey(signal))}
                    className={`group relative min-h-[154px] overflow-hidden border p-4 text-left transition ${
                      selected
                        ? accent === "cyan"
                          ? "border-cyan-300/80 bg-[#0d1b23] shadow-[inset_3px_0_0_#67e8f9,0_0_28px_rgba(103,232,249,0.1)]"
                          : "border-amber-300/80 bg-[#1a160c] shadow-[inset_3px_0_0_#fbbf24,0_0_28px_rgba(251,191,36,0.08)]"
                        : "border-[#202d3b] bg-[#0b1119] hover:border-[#3b5065] hover:bg-[#101822]"
                    }`}
                  >
                    <div className="mb-4 flex items-center justify-between">
                      <span
                        className={`grid h-7 w-7 place-items-center rounded-sm text-xs font-black ${
                          signal.direction === "LONG" ? "bg-cyan-300 text-[#061014]" : "bg-amber-300 text-[#1a1202]"
                        }`}
                      >
                        {eventNumber}
                      </span>
                      <span className="text-xs text-zinc-500">{candle ? formatCardTime(candle.time) : "--:--"}</span>
                    </div>
                    <p className={`text-[11px] font-bold uppercase tracking-[0.12em] ${signal.direction === "LONG" ? "text-cyan-200" : "text-amber-200"}`}>
                      {signalTitle(signal)}
                    </p>
                    <p className="mt-1 text-xl font-semibold tracking-tight text-zinc-50">{candle ? formatPrice(candle.close) : "-"}</p>
                    <p className="mt-2 line-clamp-1 text-xs leading-5 text-zinc-400">{shortReason(signal)}</p>
                    <div className="mt-4 h-1.5 rounded-full bg-[#17202b]">
                      <div
                        className={signal.direction === "LONG" ? "h-full bg-cyan-300" : "h-full bg-amber-300"}
                        style={{ width: `${signal.score}%` }}
                      />
                    </div>
                  </button>
                )
              })
            )}
          </div>
        </section>

        <section className="border-b border-[#1d2a38] bg-[#070b10] px-4 py-4">
          <div className="mx-auto w-full max-w-[640px]">
            <KakaoAd unit="DAN-0A1Dxif5Rgz57Nwg" width={320} height={100} />
          </div>
        </section>

        <section className="grid flex-1 grid-rows-[1fr_auto] bg-[#070b10] px-4 py-5 lg:px-6">
          <div className="relative min-h-[560px] overflow-hidden border border-[#1d2a38] bg-[#080d13] shadow-[0_24px_55px_rgba(0,0,0,0.22)]">
            <div className="pointer-events-none absolute inset-0 opacity-70 [background-image:linear-gradient(rgba(255,255,255,0.025)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.025)_1px,transparent_1px)] [background-size:40px_40px]" />
            <div className="pointer-events-none absolute left-4 top-4 z-10 flex flex-wrap items-center gap-2 text-[10px] font-bold uppercase tracking-[0.1em]">
              <span className="border border-[#2b3c4e] bg-[#0a1017]/90 px-2 py-1 text-zinc-400">가격</span>
              <span className="border border-[#2b3c4e] bg-[#0a1017]/90 px-2 py-1 text-zinc-400">거래량</span>
              <span className="border border-cyan-400/40 bg-cyan-300/10 px-2 py-1 text-cyan-200">진입 후보</span>
              <span className="border border-amber-400/40 bg-amber-300/10 px-2 py-1 text-amber-200">주의</span>
            </div>
            {loading && candles.length === 0 ? (
              <div className="relative flex h-full items-center justify-center text-zinc-500">Loading chart...</div>
            ) : error ? (
              <div className="relative flex h-full items-center justify-center text-red-300">{error}</div>
            ) : (
              <svg viewBox={`0 0 ${chart.width} ${chart.height}`} className="relative h-full w-full">
                <defs>
                  <filter id="signalGlow" x="-80%" y="-80%" width="260%" height="260%">
                    <feGaussianBlur stdDeviation="3" result="blur" />
                    <feMerge>
                      <feMergeNode in="blur" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                </defs>
                <rect width={chart.width} height={chart.height} fill="#070a0f" />

                {chart.levels.map((level) => (
                  <g key={level.price}>
                    <line
                      x1={chart.padding.left}
                      x2={chart.width - chart.padding.right}
                      y1={level.y}
                      y2={level.y}
                      stroke="#1a2330"
                      strokeWidth="1"
                    />
                    <text x={chart.width - 66} y={level.y + 4} fill="#64748b" fontSize="12">
                      {formatPrice(level.price)}
                    </text>
                  </g>
                ))}

                {supportLevels.map((support) => {
                  if (support.price < chart.min || support.price > chart.max) return null
                  const y = chart.padding.top + priceY(support.price, chart.min, chart.max, chart.priceHeight)
                  return (
                    <g key={`${support.kind}-${support.price}`}>
                      <line
                        x1={chart.padding.left}
                        x2={chart.width - chart.padding.right}
                        y1={y}
                        y2={y}
                        stroke={support.kind === "round" ? "#7c6f35" : "#0e7490"}
                        strokeDasharray={support.kind === "round" ? "6 8" : "3 5"}
                        strokeOpacity={support.kind === "round" ? "0.45" : "0.55"}
                        strokeWidth="1.3"
                      />
                    </g>
                  )
                })}

                {candles.map((candle, index) => {
                  const x = chart.padding.left + index * chart.candleWidth + chart.candleWidth / 2
                  const openY = chart.padding.top + priceY(candle.open, chart.min, chart.max, chart.priceHeight)
                  const closeY = chart.padding.top + priceY(candle.close, chart.min, chart.max, chart.priceHeight)
                  const highY = chart.padding.top + priceY(candle.high, chart.min, chart.max, chart.priceHeight)
                  const lowY = chart.padding.top + priceY(candle.low, chart.min, chart.max, chart.priceHeight)
                  const bodyY = Math.min(openY, closeY)
                  const bodyHeight = Math.max(1, Math.abs(closeY - openY))
                  const up = candle.close >= candle.open
                  const color = up ? "#34d399" : "#fb7185"
                  const volumeHeight = (candle.volume / chart.maxVolume) * chart.volumeHeight
                  const volumeY = chart.priceHeight + chart.gap + chart.volumeHeight - volumeHeight

                  return (
                    <g key={candle.time}>
                      <line x1={x} x2={x} y1={highY} y2={lowY} stroke={color} strokeWidth="1.5" />
                      <rect
                        x={x - chart.bodyWidth / 2}
                        y={bodyY}
                        width={chart.bodyWidth}
                        height={bodyHeight}
                        fill={up ? "#0f5135" : "#6f1d2b"}
                        stroke={color}
                        strokeWidth="1"
                      />
                      <rect
                        x={x - chart.bodyWidth / 2}
                        y={volumeY}
                        width={chart.bodyWidth}
                        height={volumeHeight}
                        fill={up ? "rgba(52,211,153,0.32)" : "rgba(251,113,133,0.32)"}
                      />
                    </g>
                  )
                })}

                {displaySignals.map((signal, markerIndex) => {
                  const candle = candles[signal.index]
                  const x = chart.padding.left + signal.index * chart.candleWidth + chart.candleWidth / 2
                  const y =
                    signal.direction === "LONG"
                      ? chart.padding.top + priceY(candle.low, chart.min, chart.max, chart.priceHeight) + 18
                      : chart.padding.top + priceY(candle.high, chart.min, chart.max, chart.priceHeight) - 14
                  const color = signal.direction === "LONG" ? "#67e8f9" : "#fbbf24"
                  const selected = selectedSignal ? signalKey(signal) === signalKey(selectedSignal) : false

                  return (
                    <g
                      key={`${signal.index}-${signal.pattern}`}
                      filter={selected ? "url(#signalGlow)" : undefined}
                      onClick={() => setSelectedSignalKey(signalKey(signal))}
                      className="cursor-pointer"
                    >
                      {selected && (
                        <line
                          x1={x}
                          x2={x}
                          y1={chart.padding.top}
                          y2={chart.priceHeight + chart.gap + chart.volumeHeight}
                          stroke={color}
                          strokeDasharray="8 8"
                          strokeOpacity="0.38"
                          strokeWidth="1.4"
                        />
                      )}
                      <circle cx={x} cy={y} r={selected ? "10" : "8"} fill="#071017" stroke={color} strokeWidth="2" />
                      <circle cx={x} cy={y} r={selected ? "4" : "3"} fill={color} />
                      <text x={x} y={y + 22} fill={color} fontSize="11" fontWeight="800" textAnchor="middle">
                        {markerIndex + 1}
                      </text>
                    </g>
                  )
                })}

                {selectedSignal && selectedCandle && (() => {
                  const markerX = chart.padding.left + selectedSignal.index * chart.candleWidth + chart.candleWidth / 2
                  const markerY =
                    selectedSignal.direction === "LONG"
                      ? chart.padding.top + priceY(selectedCandle.low, chart.min, chart.max, chart.priceHeight) + 18
                      : chart.padding.top + priceY(selectedCandle.high, chart.min, chart.max, chart.priceHeight) - 14
                  const boxWidth = 290
                  const boxHeight = 118
                  const boxX = markerX < chart.width * 0.58 ? markerX + 42 : markerX - boxWidth - 42
                  const boxY = clamp(markerY - 62, 24, chart.priceHeight - boxHeight - 12)
                  const color = selectedSignal.direction === "LONG" ? "#67e8f9" : "#fbbf24"
                  const reasons = signalReasons(selectedSignal)

                  return (
                    <g>
                      <line
                        x1={markerX}
                        y1={markerY}
                        x2={boxX + (markerX < chart.width * 0.58 ? 0 : boxWidth)}
                        y2={boxY + boxHeight / 2}
                        stroke={color}
                        strokeDasharray="7 7"
                        strokeWidth="1.8"
                        strokeOpacity="0.9"
                      />
                      <rect
                        x={boxX}
                        y={boxY}
                        width={boxWidth}
                        height={boxHeight}
                        rx="6"
                        fill="#0b1118"
                        stroke={color}
                        strokeOpacity="0.85"
                      />
                      <text x={boxX + 16} y={boxY + 25} fill={color} fontSize="14" fontWeight="800">
                        {selectedSignalNumber}. {signalTitle(selectedSignal)} {Math.round(selectedSignal.score)}점
                      </text>
                      {reasons.map((reason, reasonIndex) => (
                        <text key={reason} x={boxX + 16} y={boxY + 50 + reasonIndex * 19} fill="#cbd5e1" fontSize="12">
                          - {reason}
                        </text>
                      ))}
                    </g>
                  )
                })()}

                {candles.filter((_, index) => index % 20 === 0).map((candle, index) => {
                  const candleIndex = index * 20
                  const x = chart.padding.left + candleIndex * chart.candleWidth
                  return (
                    <text key={candle.time} x={x} y={chart.height - 8} fill="#475569" fontSize="11">
                      {formatTime(candle.time, timeframe)}
                    </text>
                  )
                })}
              </svg>
            )}
          </div>

          <div className="grid gap-4 border-x border-b border-[#1d2a38] bg-[#0b1119] p-4 lg:grid-cols-[210px_1fr_250px] lg:items-center">
            <div className="border-l-2 border-cyan-300 pl-4">
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">Last price</p>
              <p className="mt-1 text-3xl font-semibold tracking-tight text-zinc-50">{currentPrice ? formatPrice(currentPrice) : "-"}</p>
              <p className={`mt-1 text-xs font-semibold ${priceMove >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{priceMove >= 0 ? "+" : ""}{priceMove.toFixed(2)}% 현재 진행 봉</p>
            </div>

            <div className="min-w-0 border-y border-[#202d3b] py-3 lg:border-y-0 lg:border-x lg:px-5 lg:py-0">
              <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">Selected signal</p>
              <p
                className={`mt-1 text-xl font-semibold ${signalTone}`}
              >
                {selectedSignal ? `${selectedSignalNumber}. ${signalTitle(selectedSignal)} ${Math.round(selectedSignal.score)}점` : "관망"}
              </p>
              <p className="mt-1 text-sm leading-6 text-zinc-400">
                {selectedSignal?.detail ?? "거래량, 지지선, 쌍바닥, 다이버전스 조건이 아직 뚜렷하지 않습니다."}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4 text-right">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">Volume</p>
                <p className={`mt-1 text-lg font-semibold ${volumeRatio >= 1.5 ? "text-amber-300" : "text-zinc-200"}`}>
                  {volumeRatio ? `${volumeRatio.toFixed(2)}x` : "-"}
                </p>
              </div>
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">Mode</p>
                <p className={`mt-1 text-lg font-semibold ${signalTone}`}>{selectedSignal?.direction ?? "WAIT"}</p>
              </div>
            </div>
          </div>

          <div className="border-x border-b border-[#1d2a38] bg-[#080d13] px-4 py-5">
            <div className="mx-auto w-full max-w-[300px]">
              <KakaoAd unit="DAN-6jUyeCB09Hw8CGmH" width={300} height={250} />
            </div>
          </div>
        </section>
      </div>
    </main>
  )
}
