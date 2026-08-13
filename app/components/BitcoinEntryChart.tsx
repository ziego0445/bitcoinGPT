"use client"

import { useEffect, useMemo, useState } from "react"

type Timeframe = "5m" | "15m" | "1h" | "4h"
type Direction = "LONG" | "WAIT"
// "panic"/"recovered" are kept for backward-compat display of historical trade records
// (data/live-trades.json can contain them from before this pattern set changed, or from
// scripts/live-trade.js's startup-reconciliation recovery path) — detectSignals() below
// no longer generates either.
type Pattern = "key-candle" | "double-bottom" | "avoid" | "panic" | "recovered"

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

interface PaperOpenPosition {
  pattern: Pattern
  score: number
  leverage: number
  size: number
  entryTime: number
  entryPrice: number
  takeProfit: number
  stopLoss: number
  orderId?: string
}

interface PaperTrade {
  pattern: Pattern
  score: number
  leverage: number
  entryTime: number
  entryPrice: number
  exitTime: number
  exitPrice: number
  exitReason: "take-profit" | "stop-loss"
  pnlPct: number
  balanceBefore: number
  balanceAfter: number
  orderId?: string
  exitOrderId?: string
}

// Shared by both the paper simulator (data/paper-trades.json) and the real Bitget bot
// (data/live-trades.json, see scripts/live-trade.js) — `mode` distinguishes them when a
// single render helper needs to know which one it's drawing.
interface PaperTradeState {
  mode?: "demo" | "live"
  startingBalance: number
  currentBalance: number
  openPosition: PaperOpenPosition | null
  trades: PaperTrade[]
}

const TIMEFRAMES: Timeframe[] = ["5m", "15m", "1h", "4h"]
const CANDLE_LIMIT = 121
const MAX_EVENT_CARDS = 10
const MAX_TRADE_ROWS = 12
// Mirrors scripts/live-trade.js's ALERT_MIN_SCORE/LEVERAGE — separate files (browser vs
// Node) can't share a module, so keep these in sync by hand if the bot's values change.
const ALERT_MIN_SCORE = 85
const LEVERAGE = 10
// Written by scripts/live-trade.js, which runs on a local always-on PC (not GitHub
// Actions) and places real Bitget orders — see that file for details.
const LIVE_TRADE_STATE_URL =
  "https://raw.githubusercontent.com/ziego0445/bitcoinGPT/main/data/live-trades.json"
const LIVE_MARKER_COLORS = { entry: "#fbbf24", win: "#4ade80", loss: "#f43f5e" }

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
  const base = candles[lookback].close
  if (!base) return 0
  // Normalized to a % move so momentum at two different price/volatility regimes
  // (e.g. two separate pivot lows) is comparable — a raw dollar diff isn't.
  return (candles[index].close - base) / base
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

// The "previous low" a double-bottom retests should be the one the market actually
// remembers — the candle where selling climaxed on volume — not just whichever pivot
// happens to be most recent. getPivotLows() picks pivots by price geometry alone, so a
// quiet, insignificant wiggle can outrank the real capitulation candle just for being
// newer. Pick the highest-volume pivot among the last few instead of blindly using the
// last one; capped to a small recent window so this still means "the recent low", not
// "the biggest low in the whole fetched history".
function selectPreviousPivot(pivots: PivotLow[], lookback = 3): PivotLow | undefined {
  const recent = pivots.slice(-lookback)
  if (!recent.length) return undefined
  return recent.reduce((best, pivot) => (pivot.volume > best.volume ? pivot : best), recent[0])
}

function detectSignals(candles: Candle[]): EntrySignal[] {
  const signals: EntrySignal[] = []

  for (let index = 16; index < candles.length; index += 1) {
    const current = candles[index]
    const recent = candles.slice(index - 10, index)
    const lastFour = candles.slice(index - 3, index + 1)
    const avgVolume = average(recent.map((candle) => candle.volume))
    const avgBody = average(recent.map(bodySize))
    const volumeSpike = avgVolume > 0 ? current.volume / avgVolume : 0
    const lastBody = bodySize(current)
    const firstCandle = lastFour[0]
    const firstBody = bodySize(firstCandle)
    // Chapter 2 (첫봉이 가장 길 때) shows *stepped* declines with intermittent bounces,
    // not an unbroken run of lower closes — requiring every close to fall in a row missed
    // that pattern entirely. Instead: net move over the window is still down, and no bounce
    // has erased the origin candle's move.
    const steppedDecline =
      current.close < firstCandle.close &&
      lastFour.slice(1).every((candle) => candle.close <= firstCandle.open)
    // The PDF's criterion for "first candle dominates" is volume, not just body size —
    // a big-bodied first candle without matching volume dominance isn't the pattern described.
    const firstVolumeDominates =
      firstCandle.volume > avgVolume * 1.3 &&
      firstCandle.volume >= Math.max(...lastFour.slice(1).map((candle) => candle.volume))
    const firstCandleDominates = firstBody > avgBody * 1.7 && firstBody > lastBody * 1.25 && firstVolumeDominates
    const supports = getSupportLevels(candles.slice(0, index + 1))
    const supportNearby = isNearSupport(current.low, supports)
    const pivots = getPivotLows(candles, index - 1)
    const previousPivot = selectPreviousPivot(pivots)
    const nearPreviousLow = previousPivot
      ? Math.abs(current.low - previousPivot.price) / previousPivot.price <= 0.007
      : false
    const slightlyBrokenDoubleBottom = previousPivot
      ? current.low < previousPivot.price && (previousPivot.price - current.low) / previousPivot.price <= 0.012
      : false
    // Only a genuine retest (price revisiting a prior pivot low) qualifies for the "heavy
    // sell volume grinding into the retest" warning — applying it to any 4 red candles also
    // caught first-time capitulation flushes, which is exactly the Chapter 1 "best entry"
    // pattern this was wrongly overriding.
    const inRetestZone = previousPivot
      ? Math.abs(current.low - previousPivot.price) / previousPivot.price <= 0.02
      : false
    const highSellVolumeIntoRetest =
      inRetestZone && lastFour.every((candle) => candle.close < candle.open && candle.volume > avgVolume * 1.15)
    const currentMomentum = momentumAt(candles, index)
    const bullishDivergence = previousPivot
      ? current.low <= previousPivot.price * 1.004 && currentMomentum > previousPivot.momentum
      : false
    // Both volume frames (vs. the original pivot candle, and vs. the recent baseline) must
    // agree the retest isn't overloaded with sell volume — an OR here let heavy-volume
    // retests through whenever the recent baseline was itself already elevated.
    const retestVolumeOk = previousPivot
      ? current.volume <= previousPivot.volume * 1.15 && volumeSpike <= 1.6
      : false
    const wickOk = lowerWickRatio(current) >= 0.34

    if ((firstCandleDominates && steppedDecline) || highSellVolumeIntoRetest) {
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

    // "키캔들" 3봉 패턴 (index-2, index-1, index=current):
    //   1. 장대봉: 거래량 실린 과매도권 음봉 (장대 + 거래량 많이 + 과매도)
    //   2. 컨펌봉: 도지 또는 작은 양봉으로 매수 반응
    //   3. 진입봉(현재): 아래꼬리로 지지를 재확인 — 여기서 진입
    const keyCandle = candles[index - 2]
    const confirmCandle = candles[index - 1]
    const keyCandleIsLong = bodySize(keyCandle) > avgBody * 1.5
    const keyCandleHeavyVolume = keyCandle.volume > avgVolume * 1.5
    const keyCandleIsBearish = keyCandle.close < keyCandle.open
    const keyCandleOversold = keyCandle.low <= Math.min(...recent.map((candle) => candle.low))
    const confirmBody = bodySize(confirmCandle)
    const confirmIsDojiOrSmallBull =
      confirmBody <= avgBody * 0.6 || (confirmCandle.close > confirmCandle.open && confirmBody <= avgBody * 0.9)

    if (
      keyCandleIsLong &&
      keyCandleHeavyVolume &&
      keyCandleIsBearish &&
      keyCandleOversold &&
      confirmIsDojiOrSmallBull &&
      wickOk
    ) {
      signals.push({
        index,
        direction: "LONG",
        score: clamp(
          78 +
            (avgVolume > 0 ? (keyCandle.volume / avgVolume) * 2 : 0) +
            (confirmCandle.close > confirmCandle.open ? 5 : 0) +
            (supportNearby ? 6 : 0),
          78,
          96,
        ),
        pattern: "key-candle",
        label: "KEY",
        detail: "장대 음봉+거래량 폭발 후 도지/양봉 컨펌, 다음 봉 아래꼬리로 지지 재확인.",
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
    }
  }

  return signals
}

function formatPrice(price: number) {
  return `$${Math.round(price).toLocaleString()}`
}

// Account-balance figures (as opposed to BTC price levels) are small dollar amounts on a
// live account — rounding to the nearest whole dollar hides essentially all the signal
// (e.g. $12.36 -> $12.26 both round to "$12"), so these always show cents.
function formatBalance(value: number) {
  return `$${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

// Small status-style badge for the fixed strategy parameters (score threshold, leverage,
// win rate) — "good"/"warn" are reserved for win-rate direction, never reused elsewhere.
function StatPill({ label, tone = "neutral" }: { label: string; tone?: "good" | "warn" | "neutral" }) {
  const toneClass =
    tone === "good"
      ? "border-emerald-400/30 bg-emerald-300/10 text-emerald-200"
      : tone === "warn"
        ? "border-rose-400/30 bg-rose-300/10 text-rose-200"
        : "border-[#28394b] bg-[#0a1017] text-zinc-300"

  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold ${toneClass}`}>
      {label}
    </span>
  )
}

// value + label stat tile — same contract used for 시작/현재 금액/총손익률.
function StatTile({
  label,
  value,
  tone = "neutral",
  highlight = false,
}: {
  label: string
  value: string
  tone?: "good" | "bad" | "neutral"
  highlight?: boolean
}) {
  const valueClass = tone === "good" ? "text-emerald-300" : tone === "bad" ? "text-rose-300" : "text-zinc-200"

  return (
    <div
      className={`flex-1 rounded-xl border px-3 py-2.5 text-center ${
        highlight ? "border-amber-400/40 bg-amber-300/5" : "border-[#1c2733] bg-[#080d13]"
      }`}
    >
      <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-zinc-500">{label}</p>
      <p className={`mt-1 text-lg font-bold tabular-nums ${valueClass}`}>{value}</p>
    </div>
  )
}

function formatTime(time: number, timeframe: Timeframe) {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    month: timeframe === "1h" || timeframe === "4h" ? "2-digit" : undefined,
    day: timeframe === "1h" || timeframe === "4h" ? "2-digit" : undefined,
  }).format(new Date(time))
}

function signalKey(signal: EntrySignal) {
  return `${signal.index}-${signal.pattern}`
}

const PATTERN_LABELS: Record<Pattern, string> = {
  "key-candle": "장대+거래량 컨펌 후보",
  "double-bottom": "쌍바닥 후보",
  avoid: "빠른 진입 금지",
  panic: "패닉셀 반등 후보 (구)",
  recovered: "재시작 중 복구된 포지션",
}

function patternLabel(pattern: Pattern) {
  return PATTERN_LABELS[pattern]
}

function signalTitle(signal?: EntrySignal) {
  return signal ? patternLabel(signal.pattern) : "관망"
}

function signalReasons(signal?: EntrySignal) {
  if (!signal) {
    return ["확실한 거래량 폭발이 없습니다.", "쌍바닥이나 지지선 반응이 아직 약합니다.", "무리한 진입보다 관망이 우선입니다."]
  }

  const reasons: Record<Pattern, string[]> = {
    "key-candle": [
      "직전 장대봉이 거래량을 동반한 과매도권 음봉이었습니다.",
      "그다음 봉이 도지 또는 작은 양봉으로 매수 반응을 보였습니다.",
      "이번 봉의 아래꼬리가 지지를 다시 확인해줍니다.",
    ],
    "double-bottom": ["직전 저점 부근을 다시 테스트했습니다.", "재하락 거래량이 과하지 않습니다.", "아래꼬리 또는 다이버전스가 붙었습니다."],
    avoid: ["첫 장대봉이 너무 강합니다.", "저점까지 매도 거래량이 계속 큽니다.", "PDF 기준 빠른 롱을 피하는 자리입니다."],
    panic: ["최근 저점을 새로 만들었습니다.", "평균보다 거래량이 크게 늘었습니다.", "긴 봉 또는 아래꼬리로 매수 반응이 보입니다."],
    recovered: ["봇이 재시작하는 동안 실제 거래소에 열려있던 포지션을 그대로 인식했습니다."],
  }

  return reasons[signal.pattern]
}

function getDisplaySignals(signals: EntrySignal[]) {
  const recentCandidates = signals
    .filter((signal) => signal.score >= ALERT_MIN_SCORE || signal.pattern === "avoid")
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
    "key-candle": "장대+거래량 후 도지/양봉 컨펌",
    "double-bottom": "직전 저점 재방문",
    avoid: "첫 장대봉 과열",
    panic: "거래량 폭발 + 마지막 장대봉",
    recovered: "재시작 중 포지션 복구",
  }

  return reasons[signal.pattern]
}

function formatCardTime(time: number) {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(time))
}

function formatDateTime(time: number) {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(time))
}

// Polls a JSON file (paper-trades.json / live-trades.json, both fetched straight from
// GitHub's raw content host) on an interval, keeping the last known value on transient
// fetch failures — those files only change every few minutes at most, so a stale read is
// preferable to a blank panel. Returns null before the first successful load, which also
// covers the case where the file doesn't exist yet (e.g. live-trades.json before
// scripts/live-trade.js has ever run) — callers use that to hide the panel entirely.
function openUnrealizedPct(state: PaperTradeState | null, currentPrice: number | undefined) {
  if (!state?.openPosition || !currentPrice) return null
  return (
    ((currentPrice - state.openPosition.entryPrice) / state.openPosition.entryPrice) *
    state.openPosition.leverage *
    100
  )
}

function totalReturnPct(state: PaperTradeState | null) {
  if (!state) return 0
  return ((state.currentBalance - state.startingBalance) / state.startingBalance) * 100
}

interface TradePanelConfig {
  title: string
  subtitleLabel: string
  accent: "cyan" | "amber"
  badgeText: string
  emptyText: string
  loadingText: string
}

const ACCENT = {
  cyan: { priceText: "text-cyan-200", openBorder: "border-cyan-300/30 bg-cyan-300/5", badgeBg: "bg-cyan-300/90" },
  amber: { priceText: "text-amber-200", openBorder: "border-amber-300/30 bg-amber-300/5", badgeBg: "bg-amber-300/90" },
} as const

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
        // see comment above — swallow and keep the last known value
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

export default function BitcoinEntryChart() {
  const [timeframe, setTimeframe] = useState<Timeframe>("15m")
  const [candles, setCandles] = useState<Candle[]>([])
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(true)
  const [selectedSignalKey, setSelectedSignalKey] = useState("")
  const [hoverIndex, setHoverIndex] = useState<number | null>(null)
  const liveState = usePolledJson<PaperTradeState>(LIVE_TRADE_STATE_URL, 60_000)

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
    const priceHeight = 360
    const volumeHeight = 85
    const gap = 16
    const height = priceHeight + volumeHeight + gap
    const padding = { top: 16, right: 68, bottom: 24, left: 8 }
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

  // Unrealized/return % are recomputed inside renderTradeStatusPanel/renderEntryPill
  // (they need the same values per-state) — only the recent-trades slice is needed here.
  const liveRecentTrades = liveState ? [...liveState.trades].reverse().slice(0, MAX_TRADE_ROWS) : []

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

  // Balance/open-position header + status banner — shared between the paper simulator
  // and the real Bitget bot, only differing in copy/accent color (config).
  function renderTradeStatusPanel(state: PaperTradeState | null, config: TradePanelConfig) {
    const unrealizedPct = openUnrealizedPct(state, currentPrice)
    const returnPct = totalReturnPct(state)
    const accent = ACCENT[config.accent]
    const closedTrades = state?.trades ?? []
    const wins = closedTrades.filter((trade) => trade.exitReason === "take-profit").length
    const winRatePct = closedTrades.length ? (wins / closedTrades.length) * 100 : null

    return (
      <section className="border-b border-[#1a2432] bg-[#0b0f17] px-5 py-5 lg:px-7">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <StatPill label={`${ALERT_MIN_SCORE}점 이상 신호`} />
          <StatPill label={`${LEVERAGE}x 레버리지`} />
          <StatPill
            label={winRatePct !== null ? `승률 ${winRatePct.toFixed(0)}% (${wins}/${closedTrades.length})` : "승률 집계 전"}
            tone={winRatePct === null ? "neutral" : winRatePct >= 50 ? "good" : "warn"}
          />
        </div>

        <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">{config.subtitleLabel}</p>
            <h2 className="mt-0.5 text-sm font-semibold text-zinc-400">{config.title}</h2>
            {/* The one hero figure on this page — proportional (not tabular) figures at
                display size, per the big-number convention: tabular-nums is for columns
                that must align, not a single large standalone value. */}
            <div className="mt-1 flex flex-wrap items-baseline gap-3">
              <span className={`text-5xl font-bold leading-none tracking-tight ${accent.priceText}`}>
                {currentPrice ? formatPrice(currentPrice) : "불러오는 중..."}
              </span>
              <span className={`text-sm font-semibold tabular-nums ${priceMove >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                {priceMove >= 0 ? "+" : ""}{priceMove.toFixed(2)}%
              </span>
            </div>
          </div>
        </div>

        {state && (
          <div className="mb-4 flex gap-2.5">
            <StatTile label="시작 금액" value={formatBalance(state.startingBalance)} />
            <StatTile label="현재 금액" value={formatBalance(state.currentBalance)} tone={returnPct >= 0 ? "good" : "bad"} highlight />
            <StatTile
              label="총 손익률"
              value={`${returnPct >= 0 ? "+" : ""}${returnPct.toFixed(2)}%`}
              tone={returnPct >= 0 ? "good" : "bad"}
            />
          </div>
        )}

        {!state ? (
          <p className="text-sm text-zinc-500">{config.loadingText}</p>
        ) : state.openPosition ? (
          <div className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 ${accent.openBorder}`}>
            <div className="flex flex-wrap items-center gap-3">
              <span className={`rounded-md px-2 py-1 text-[10px] font-bold text-[#061014] ${accent.badgeBg}`}>{config.badgeText}</span>
              <span className="rounded-md bg-[#1c2733] px-2 py-1 text-[10px] font-bold text-zinc-300">{state.openPosition.leverage}x</span>
              <span className="text-sm text-zinc-200">
                {patternLabel(state.openPosition.pattern)} · 투입 {formatBalance(state.openPosition.size)} · 진입{" "}
                {formatPrice(state.openPosition.entryPrice)} ({formatDateTime(state.openPosition.entryTime)})
              </span>
              <span className="text-xs text-zinc-500">
                익절가 {formatPrice(state.openPosition.takeProfit)} · 손절가 {formatPrice(state.openPosition.stopLoss)}
              </span>
            </div>
            <span
              className={`text-sm font-semibold tabular-nums ${(unrealizedPct ?? 0) >= 0 ? "text-emerald-300" : "text-rose-300"}`}
            >
              {unrealizedPct !== null ? `${unrealizedPct >= 0 ? "+" : ""}${unrealizedPct.toFixed(2)}% 평가손익` : "-"}
            </span>
          </div>
        ) : (
          <div className="rounded-xl border border-dashed border-[#263545] bg-[#080d13] p-4 text-sm text-zinc-500">
            {config.emptyText}
          </div>
        )}
      </section>
    )
  }

  // Compact "still open" pill overlaid on the chart — offsetClass stacks the live pill
  // below the paper one so both can be visible at once without overlapping.
  function renderEntryPill(state: PaperTradeState | null, colors: { entry: string }, offsetClass: string) {
    if (!state?.openPosition) return null
    const unrealizedPct = openUnrealizedPct(state, currentPrice)

    return (
      <div className={`pointer-events-none absolute left-1/2 z-10 -translate-x-1/2 ${offsetClass}`}>
        <div
          className="flex items-center gap-2 whitespace-nowrap rounded-full border bg-[#0a1017]/95 px-3.5 py-1.5 text-xs font-semibold shadow-[0_10px_24px_rgba(0,0,0,0.4)]"
          style={{ borderColor: `${colors.entry}66` }}
        >
          <span className="rounded-full px-1.5 py-0.5 text-[10px] font-bold text-[#061014]" style={{ backgroundColor: colors.entry }}>
            B
          </span>
          <span className="text-zinc-300">진입 {formatPrice(state.openPosition.entryPrice)}</span>
          <span className="text-zinc-600">·</span>
          <span className={`tabular-nums ${(unrealizedPct ?? 0) >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
            {unrealizedPct !== null ? `${unrealizedPct >= 0 ? "+" : ""}${unrealizedPct.toFixed(2)}%` : "-"}
          </span>
          <span className="text-zinc-500">({state.openPosition.leverage}x)</span>
        </div>
      </div>
    )
  }

  // Chart B/S markers (entry, TP/SL lines, closed-trade markers). Colors distinguish the
  // paper simulator from the real bot so the two are never confused on the same chart.
  function renderTradeMarkers(state: PaperTradeState | null, colors: { entry: string; win: string; loss: string }) {
    if (!state) return null
    const spacing = candles.length > 1 ? candles[1].time - candles[0].time : Infinity

    // Maps a real trade timestamp onto the currently displayed candle set — works
    // regardless of which timeframe the chart is showing, since trades always run on 5m
    // data but the chart can be on 15m/1h/4h.
    const indexAtTime = (time: number) => {
      if (!candles.length || time < candles[0].time) return -1
      let found = -1
      for (let i = 0; i < candles.length; i += 1) {
        if (candles[i].time <= time) found = i
        else break
      }
      if (found === candles.length - 1 && time - candles[found].time > spacing * 2) return -1
      return found
    }

    const xAt = (index: number) => chart.padding.left + index * chart.candleWidth + chart.candleWidth / 2
    const yAt = (price: number) => chart.padding.top + priceY(price, chart.min, chart.max, chart.priceHeight)

    const openPosition = state.openPosition
    const openEntryIndex = openPosition ? indexAtTime(openPosition.entryTime) : -1

    return (
      <g>
        {openPosition && (
          <>
            {/* Entry price gets the same full-width reference line as TP/SL so it's
                readable at a glance regardless of where the entry candle has scrolled to
                — the candle-anchored B marker below still pins down the exact candle. */}
            {openPosition.entryPrice >= chart.min && openPosition.entryPrice <= chart.max && (
              <g>
                <line
                  x1={chart.padding.left}
                  x2={chart.width - chart.padding.right}
                  y1={yAt(openPosition.entryPrice)}
                  y2={yAt(openPosition.entryPrice)}
                  stroke={colors.entry}
                  strokeDasharray="5 5"
                  strokeWidth="1.4"
                  strokeOpacity="0.85"
                />
                <text x={chart.width - chart.padding.right + 8} y={yAt(openPosition.entryPrice) + 4} fill={colors.entry} fontSize="11" fontWeight="800">
                  B {formatPrice(openPosition.entryPrice)}
                </text>
              </g>
            )}
            {openPosition.takeProfit >= chart.min && openPosition.takeProfit <= chart.max && (
              <g>
                <line
                  x1={chart.padding.left}
                  x2={chart.width - chart.padding.right}
                  y1={yAt(openPosition.takeProfit)}
                  y2={yAt(openPosition.takeProfit)}
                  stroke={colors.win}
                  strokeDasharray="5 5"
                  strokeWidth="1.4"
                  strokeOpacity="0.85"
                />
                <text x={chart.width - chart.padding.right + 8} y={yAt(openPosition.takeProfit) + 4} fill={colors.win} fontSize="11" fontWeight="800">
                  TP {formatPrice(openPosition.takeProfit)}
                </text>
              </g>
            )}
            {openPosition.stopLoss >= chart.min && openPosition.stopLoss <= chart.max && (
              <g>
                <line
                  x1={chart.padding.left}
                  x2={chart.width - chart.padding.right}
                  y1={yAt(openPosition.stopLoss)}
                  y2={yAt(openPosition.stopLoss)}
                  stroke={colors.loss}
                  strokeDasharray="5 5"
                  strokeWidth="1.4"
                  strokeOpacity="0.85"
                />
                <text x={chart.width - chart.padding.right + 8} y={yAt(openPosition.stopLoss) + 4} fill={colors.loss} fontSize="11" fontWeight="800">
                  SL {formatPrice(openPosition.stopLoss)}
                </text>
              </g>
            )}
            {/* The B mark belongs at the actual entry candle (time position), not
                smeared across the full width at the price level — a vertical guide
                plus a bigger glowing marker makes that exact candle easy to spot even
                when it sits far from the currently selected signal. */}
            {openEntryIndex >= 0 && (
              <g>
                <line
                  x1={xAt(openEntryIndex)}
                  x2={xAt(openEntryIndex)}
                  y1={chart.padding.top}
                  y2={chart.priceHeight + chart.gap + chart.volumeHeight}
                  stroke={colors.entry}
                  strokeDasharray="4 6"
                  strokeOpacity="0.35"
                  strokeWidth="1.2"
                />
                <circle
                  cx={xAt(openEntryIndex)}
                  cy={yAt(openPosition.entryPrice)}
                  r="10"
                  fill="#071017"
                  stroke={colors.entry}
                  strokeWidth="2.4"
                  filter="url(#signalGlow)"
                />
                <text
                  x={xAt(openEntryIndex)}
                  y={yAt(openPosition.entryPrice) + 4}
                  fill={colors.entry}
                  fontSize="11"
                  fontWeight="800"
                  textAnchor="middle"
                >
                  B
                </text>
              </g>
            )}
            {/* Entry candle predates the current timeframe's visible window (e.g. a
                position held longer than 15m×121 candles) — pin the marker to the left
                edge instead of hiding it outright. */}
            {openEntryIndex < 0 && openPosition.entryPrice >= chart.min && openPosition.entryPrice <= chart.max && (
              <g>
                <circle cx={chart.padding.left + 2} cy={yAt(openPosition.entryPrice)} r="8" fill="#071017" stroke={colors.entry} strokeWidth="2" />
                <text x={chart.padding.left + 2} y={yAt(openPosition.entryPrice) + 4} fill={colors.entry} fontSize="10" fontWeight="800" textAnchor="middle">
                  B
                </text>
                <text x={chart.padding.left + 14} y={yAt(openPosition.entryPrice) - 8} fill={colors.entry} fontSize="10" fontWeight="700">
                  ← 화면 밖 진입
                </text>
              </g>
            )}
          </>
        )}

        {state.trades.slice(-20).map((trade) => {
          const entryIndex = indexAtTime(trade.entryTime)
          const exitIndex = indexAtTime(trade.exitTime)
          const won = trade.exitReason === "take-profit"
          const exitColor = won ? colors.win : colors.loss
          const exitLabel = won ? "TP" : "SL"

          return (
            <g key={`${trade.entryTime}-${trade.exitTime}`}>
              {entryIndex >= 0 && (
                <g>
                  <circle cx={xAt(entryIndex)} cy={yAt(trade.entryPrice)} r="8" fill="#071017" stroke={colors.entry} strokeWidth="1.6" />
                  <text x={xAt(entryIndex)} y={yAt(trade.entryPrice) + 4} fill={colors.entry} fontSize="10" fontWeight="800" textAnchor="middle">
                    B
                  </text>
                </g>
              )}
              {exitIndex >= 0 && (
                <g>
                  <circle cx={xAt(exitIndex)} cy={yAt(trade.exitPrice)} r="10" fill="#071017" stroke={exitColor} strokeWidth="1.6" />
                  <text x={xAt(exitIndex)} y={yAt(trade.exitPrice) + 3} fill={exitColor} fontSize="8" fontWeight="800" textAnchor="middle">
                    {exitLabel}
                  </text>
                </g>
              )}
            </g>
          )
        })}
      </g>
    )
  }

  // Trade-history table — shared between paper and live, only the title/empty-state copy
  // and the "no state yet" (live-trade.js never run) case differ.
  function renderTradeHistoryTable(state: PaperTradeState | null, recentTrades: PaperTrade[], title: string, notStartedText: string) {
    return (
      <section className="border-t border-[#1a2432] bg-[#0b0f17] px-5 py-5 lg:px-7">
        <div className="mb-4">
          <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Trade history</p>
          <h2 className="mt-1 text-base font-semibold text-zinc-50">{title}</h2>
        </div>

        {!state || (recentTrades.length === 0 && !state.openPosition) ? (
          <div className="rounded-xl border border-dashed border-[#263545] bg-[#080d13] p-5 text-sm text-zinc-500">
            {notStartedText}
          </div>
        ) : recentTrades.length === 0 ? (
          <div className="rounded-xl border border-dashed border-[#263545] bg-[#080d13] p-5 text-sm text-zinc-500">
            아직 청산된 거래가 없습니다. 위 현황에서 보유중인 포지션을 확인하세요.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] border-collapse text-sm">
              <thead>
                <tr className="border-b border-[#1c2733] text-left text-[10px] font-semibold uppercase tracking-[0.1em] text-zinc-500">
                  <th className="py-2 pr-3">패턴</th>
                  <th className="py-2 pr-3">레버리지</th>
                  <th className="py-2 pr-3">진입</th>
                  <th className="py-2 pr-3">청산</th>
                  <th className="py-2 pr-3">결과</th>
                  <th className="py-2 text-right">손익</th>
                </tr>
              </thead>
              <tbody>
                {recentTrades.map((trade) => (
                  <tr key={`${trade.entryTime}-${trade.exitTime}`} className="border-b border-[#161f29] last:border-0">
                    <td className="py-2.5 pr-3 text-zinc-300">{patternLabel(trade.pattern)}</td>
                    <td className="py-2.5 pr-3 tabular-nums text-zinc-400">{trade.leverage}x</td>
                    <td className="py-2.5 pr-3 tabular-nums text-zinc-400">
                      {formatPrice(trade.entryPrice)}
                      <span className="ml-1 text-zinc-600">{formatDateTime(trade.entryTime)}</span>
                    </td>
                    <td className="py-2.5 pr-3 tabular-nums text-zinc-400">
                      {formatPrice(trade.exitPrice)}
                      <span className="ml-1 text-zinc-600">{formatDateTime(trade.exitTime)}</span>
                    </td>
                    <td className="py-2.5 pr-3">
                      <span
                        className={`rounded-md px-2 py-0.5 text-[10px] font-bold ${
                          trade.exitReason === "take-profit" ? "bg-emerald-300/15 text-emerald-300" : "bg-rose-300/15 text-rose-300"
                        }`}
                      >
                        {trade.exitReason === "take-profit" ? "익절" : "손절"}
                      </span>
                    </td>
                    <td className={`py-2.5 text-right font-semibold tabular-nums ${trade.pnlPct >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                      {trade.pnlPct >= 0 ? "+" : ""}
                      {trade.pnlPct.toFixed(2)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    )
  }

  // Chart hover crosshair — converts a mouse position (in rendered CSS pixels) into the
  // nearest candle index in the SVG's own viewBox coordinate space, so the crosshair
  // snaps to a candle center rather than tracking the raw pointer.
  function handleChartMouseMove(event: React.MouseEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect()
    if (!rect.width) return
    const svgX = ((event.clientX - rect.left) / rect.width) * chart.width
    const index = Math.round((svgX - chart.padding.left - chart.candleWidth / 2) / chart.candleWidth)
    setHoverIndex(index >= 0 && index < candles.length ? index : null)
  }

  function handleChartMouseLeave() {
    setHoverIndex(null)
  }

  return (
    <main className="min-h-screen bg-[#05070a] px-3 py-6 text-zinc-100 sm:px-6 lg:px-10">
      <div className="mx-auto flex max-w-[1360px] flex-col overflow-hidden rounded-2xl border border-[#1b2534] bg-[#0a0e15] shadow-[0_30px_90px_rgba(0,0,0,0.5)]">
        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-[#1a2432] bg-[#0c1119] px-5 py-4 lg:px-7">
          <div className="flex items-center gap-4">
            <div className="grid h-10 w-10 place-items-center rounded-xl border border-cyan-300/30 bg-cyan-300/10 text-sm font-black text-cyan-200">B</div>
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-cyan-300/60">BTCUSDT · Binance 차트</p>
              <div className="mt-0.5 flex items-baseline gap-2">
                <h1 className="text-lg font-semibold text-zinc-50">역추세매매</h1>
                <span className="text-sm font-medium text-zinc-500">나도 해보자</span>
              </div>
              <div className="mt-1 flex items-center gap-1.5">
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400" />
                </span>
                <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-emerald-300/80">Live trading · 실계좌</p>
              </div>
            </div>
            <div className="hidden border-l border-[#232f3d] pl-4 sm:block">
              <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-zinc-500">Live move</p>
              <p className={`mt-0.5 text-sm font-semibold tabular-nums ${priceMove >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
                {priceMove >= 0 ? "+" : ""}{priceMove.toFixed(2)}%
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="hidden text-right md:block">
              <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-zinc-500">Last update</p>
              <p className="mt-0.5 text-xs tabular-nums text-zinc-400">{updateTime ? formatCardTime(updateTime) : "--:--"}</p>
            </div>
            <div className="flex rounded-xl border border-[#232f3d] bg-[#080c12] p-1">
            {TIMEFRAMES.map((item) => (
              <button
                key={item}
                type="button"
                onClick={() => setTimeframe(item)}
                className={`h-8 min-w-11 rounded-lg px-3 text-sm font-medium transition ${
                  timeframe === item
                    ? "bg-cyan-300/90 text-[#061014] shadow-[0_0_14px_rgba(103,232,249,0.18)]"
                    : "text-zinc-500 hover:bg-[#141d28] hover:text-zinc-200"
                }`}
              >
                {item}
              </button>
            ))}
            </div>
          </div>
        </header>

        {renderTradeStatusPanel(liveState, {
          title: "실전매매 현황 (Live)",
          subtitleLabel: "Live trading · 실계좌 · 85점 이상 신호 · 10x 레버리지 · 익절 +8% / 손절 -8%",
          accent: "amber",
          badgeText: "실전 보유중",
          emptyText: "현재 보유중인 실전 포지션이 없습니다. 85점 이상 신호가 뜨면 자동으로 진입합니다.",
          loadingText: "실전매매 기록을 불러오는 중입니다...",
        })}

        <section className="flex flex-col gap-4 bg-[#080b11] px-5 py-5 lg:px-7">
          <div className="relative aspect-[1200/461] max-h-[520px] min-h-[240px] w-full overflow-hidden rounded-2xl border border-[#1a2432] bg-[#0a0e15] shadow-[0_20px_50px_rgba(0,0,0,0.28)]">
            <div className="pointer-events-none absolute inset-0 opacity-60 [background-image:linear-gradient(rgba(255,255,255,0.02)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.02)_1px,transparent_1px)] [background-size:40px_40px]" />
            <div className="pointer-events-none absolute left-4 top-4 z-10 flex flex-wrap items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.08em]">
              <span className="rounded-full border border-[#28394b] bg-[#0a1017]/90 px-2.5 py-1 text-zinc-400">가격</span>
              <span className="rounded-full border border-[#28394b] bg-[#0a1017]/90 px-2.5 py-1 text-zinc-400">거래량</span>
              <span className="rounded-full border border-cyan-400/30 bg-cyan-300/10 px-2.5 py-1 text-cyan-200/90">진입 후보</span>
              <span className="rounded-full border border-amber-400/30 bg-amber-300/10 px-2.5 py-1 text-amber-200/90">주의</span>
              <span className="rounded-full border border-amber-400/30 bg-amber-300/10 px-2.5 py-1 text-amber-200/90">B 진입</span>
              <span className="rounded-full border border-emerald-400/30 bg-emerald-300/10 px-2.5 py-1 text-emerald-200/90">TP 익절</span>
              <span className="rounded-full border border-rose-400/30 bg-rose-300/10 px-2.5 py-1 text-rose-200/90">SL 손절</span>
            </div>
            {renderEntryPill(liveState, { entry: LIVE_MARKER_COLORS.entry }, "top-4")}
            {loading && candles.length === 0 ? (
              <div className="relative flex h-full items-center justify-center text-zinc-500">Loading chart...</div>
            ) : error ? (
              <div className="relative flex h-full items-center justify-center text-red-300">{error}</div>
            ) : (
              <svg
                viewBox={`0 0 ${chart.width} ${chart.height}`}
                className="relative h-full w-full"
                onMouseMove={handleChartMouseMove}
                onMouseLeave={handleChartMouseLeave}
              >
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
                    <text x={chart.width - chart.padding.right + 8} y={level.y + 4} fill="#64748b" fontSize="12">
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

                {renderTradeMarkers(liveState, LIVE_MARKER_COLORS)}

                {candles.filter((_, index) => index % 20 === 0).map((candle, index) => {
                  const candleIndex = index * 20
                  const x = chart.padding.left + candleIndex * chart.candleWidth
                  return (
                    <text key={candle.time} x={x} y={chart.height - 8} fill="#475569" fontSize="11">
                      {formatTime(candle.time, timeframe)}
                    </text>
                  )
                })}

                {/* Hover crosshair + OHLCV readout — every value here is already visible
                    elsewhere (candle body/wick, header price), the tooltip only collects
                    it in one place; it never gates information behind hover. */}
                {hoverIndex !== null && candles[hoverIndex] && (() => {
                  const hovered = candles[hoverIndex]
                  const x = chart.padding.left + hoverIndex * chart.candleWidth + chart.candleWidth / 2
                  const up = hovered.close >= hovered.open
                  const boxWidth = 172
                  const boxHeight = 116
                  const boxX = clamp(x + 14, chart.padding.left, chart.width - chart.padding.right - boxWidth)
                  const boxY = chart.padding.top + 4

                  return (
                    <g pointerEvents="none">
                      <line
                        x1={x}
                        x2={x}
                        y1={chart.padding.top}
                        y2={chart.priceHeight + chart.gap + chart.volumeHeight}
                        stroke="#94a3b8"
                        strokeWidth="1"
                        strokeDasharray="3 4"
                        strokeOpacity="0.55"
                      />
                      <rect x={boxX} y={boxY} width={boxWidth} height={boxHeight} rx="8" fill="#0b1118" stroke="#28394b" />
                      <text x={boxX + 12} y={boxY + 20} fill="#cbd5e1" fontSize="11" fontWeight="700">
                        {formatDateTime(hovered.time)}
                      </text>
                      <text x={boxX + 12} y={boxY + 40} fill="#94a3b8" fontSize="11">
                        시가 <tspan fill="#e2e8f0" fontWeight="700">{formatPrice(hovered.open)}</tspan>
                      </text>
                      <text x={boxX + 12} y={boxY + 58} fill="#94a3b8" fontSize="11">
                        고가 <tspan fill="#e2e8f0" fontWeight="700">{formatPrice(hovered.high)}</tspan>
                      </text>
                      <text x={boxX + 12} y={boxY + 76} fill="#94a3b8" fontSize="11">
                        저가 <tspan fill="#e2e8f0" fontWeight="700">{formatPrice(hovered.low)}</tspan>
                      </text>
                      <text x={boxX + 12} y={boxY + 94} fill="#94a3b8" fontSize="11">
                        종가 <tspan fill={up ? "#34d399" : "#fb7185"} fontWeight="700">{formatPrice(hovered.close)}</tspan>
                      </text>
                      <text x={boxX + 12} y={boxY + 110} fill="#64748b" fontSize="10">
                        거래량 {hovered.volume.toFixed(1)}
                      </text>
                    </g>
                  )
                })()}
              </svg>
            )}
          </div>

          <div className="grid gap-4 rounded-2xl border border-[#1a2432] bg-[#0b0f17] p-5 lg:grid-cols-[210px_1fr_250px] lg:items-center">
            <div className="border-l-2 border-cyan-300/70 pl-4">
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Last price</p>
              <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums text-zinc-50">{currentPrice ? formatPrice(currentPrice) : "-"}</p>
              <p className={`mt-1 text-xs font-medium tabular-nums ${priceMove >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{priceMove >= 0 ? "+" : ""}{priceMove.toFixed(2)}% 현재 진행 봉</p>
            </div>

            <div className="min-w-0 border-y border-[#1c2733] py-3 lg:border-y-0 lg:border-x lg:px-5 lg:py-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Selected signal</p>
              <p
                className={`mt-1 text-lg font-semibold ${signalTone}`}
              >
                {selectedSignal ? `${selectedSignalNumber}. ${signalTitle(selectedSignal)} ${Math.round(selectedSignal.score)}점` : "관망"}
              </p>
              <p className="mt-1 text-sm leading-6 text-zinc-500">
                {selectedSignal?.detail ?? "거래량, 지지선, 쌍바닥, 다이버전스 조건이 아직 뚜렷하지 않습니다."}
              </p>
            </div>

            <div className="grid grid-cols-2 gap-4 text-right">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Volume</p>
                <p className={`mt-1 text-lg font-semibold tabular-nums ${volumeRatio >= 1.5 ? "text-amber-300" : "text-zinc-200"}`}>
                  {volumeRatio ? `${volumeRatio.toFixed(2)}x` : "-"}
                </p>
              </div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-zinc-500">Mode</p>
                <p className={`mt-1 text-lg font-semibold ${signalTone}`}>{selectedSignal?.direction ?? "WAIT"}</p>
              </div>
            </div>
          </div>

        </section>

        {renderTradeHistoryTable(
            liveState,
            liveRecentTrades,
            "실전매매 결과 (Live)",
            "아직 체결된 실전매매 기록이 없습니다. 85점 이상 신호가 뜨면 자동으로 진입합니다.",
          )}

        <section className="border-t border-[#1a2432] bg-[#0a0e15] px-5 py-5 lg:px-7">
          <div className="mb-4 flex items-end justify-between gap-4">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">Signal timeline</p>
              <h2 className="mt-1 text-base font-semibold text-zinc-50">최근 확정 신호</h2>
            </div>
            <div className="hidden items-center gap-2 text-xs text-zinc-500 md:flex"><span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />30초마다 시세 갱신</div>
          </div>
          <p className="mb-4 text-xs text-zinc-500">
            이 카드들은 지금 선택한 {timeframe} 기준의 참고용 후보 신호입니다. 실제 매매 봇은 5분봉 기준으로 자동 진입하므로 진입 시점이 다를 수 있습니다 — 실제 진입가/손익은 차트의 B/TP/SL 가로줄과 상단 배지를 확인하세요.
          </p>

          <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-5">
            {displaySignals.length === 0 ? (
              <div className="rounded-xl border border-dashed border-[#263545] bg-[#080d13] p-5 text-sm text-zinc-500 xl:col-span-5">
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
                    className={`group relative min-h-[142px] overflow-hidden rounded-xl border p-4 text-left transition ${
                      selected
                        ? accent === "cyan"
                          ? "border-cyan-300/60 bg-[#0d1a22] shadow-[inset_2px_0_0_#67e8f9,0_10px_26px_rgba(103,232,249,0.06)]"
                          : "border-amber-300/60 bg-[#191509] shadow-[inset_2px_0_0_#fbbf24,0_10px_26px_rgba(251,191,36,0.05)]"
                        : "border-[#1c2734] bg-[#0b0f16] hover:border-[#33465a] hover:bg-[#0f141c]"
                    }`}
                  >
                    <div className="mb-3.5 flex items-center justify-between">
                      <span
                        className={`grid h-6 w-6 place-items-center rounded-md text-[11px] font-bold ${
                          signal.direction === "LONG" ? "bg-cyan-300/90 text-[#061014]" : "bg-amber-300/90 text-[#1a1202]"
                        }`}
                      >
                        {eventNumber}
                      </span>
                      <span className="text-xs tabular-nums text-zinc-500">{candle ? formatCardTime(candle.time) : "--:--"}</span>
                    </div>
                    <p className={`text-[10px] font-semibold uppercase tracking-[0.1em] ${signal.direction === "LONG" ? "text-cyan-200/90" : "text-amber-200/90"}`}>
                      {signalTitle(signal)}
                    </p>
                    <p className="mt-1 text-lg font-semibold tracking-tight tabular-nums text-zinc-50">{candle ? formatPrice(candle.close) : "-"}</p>
                    <p className="mt-2 line-clamp-1 text-xs leading-5 text-zinc-500">{shortReason(signal)}</p>
                    <div className="mt-3.5 h-1 rounded-full bg-[#161f29]">
                      <div
                        className={`h-full rounded-full ${signal.direction === "LONG" ? "bg-cyan-300/80" : "bg-amber-300/80"}`}
                        style={{ width: `${signal.score}%` }}
                      />
                    </div>
                  </button>
                )
              })
            )}
          </div>
        </section>

        <section className="border-t border-[#1a2432] bg-[#080b11] px-5 py-5">
          <div className="mx-auto w-full max-w-[640px]">
            <KakaoAd unit="DAN-0A1Dxif5Rgz57Nwg" width={320} height={100} />
          </div>
          <div className="mx-auto mt-4 w-full max-w-[300px]">
            <KakaoAd unit="DAN-6jUyeCB09Hw8CGmH" width={300} height={250} />
          </div>
        </section>
      </div>
    </main>
  )
}
