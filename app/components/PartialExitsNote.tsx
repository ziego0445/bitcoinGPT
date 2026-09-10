// Exit legs of a still-open ladder position (TP1 before TP2). Both live bots write these
// onto openPosition.partialExits and the open trade report as each leg fills — see
// recordPartialExits() in scripts/live-trade.js / scripts/live-trade-ict.js. A trade only
// lands in the closed-trade list once the whole position is flat, so without this a real
// TP1 fill was invisible on the dashboard.
export interface PartialExit {
  time: number
  price: number
  size: number
  tag: "tp1" | "tp2" | string
  pnlUsdt: number
}

function formatPrice(price: number) {
  return `$${price.toLocaleString("en-US", { maximumFractionDigits: price >= 1000 ? 1 : 2 })}`
}

function formatTime(time: number) {
  return new Intl.DateTimeFormat("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(time))
}

function formatUsdt(value: number) {
  return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(2)}`
}

export default function PartialExitsNote({
  exits,
  realizedPnlUsdt,
  unit,
  remainingSize,
  nextTarget,
}: {
  exits?: PartialExit[] | null
  realizedPnlUsdt?: number | null
  unit: string
  remainingSize?: number | null
  nextTarget?: number | null
}) {
  if (!exits?.length) return null
  const realized = realizedPnlUsdt ?? exits.reduce((sum, e) => sum + e.pnlUsdt, 0)

  return (
    <div className="mt-3 rounded-lg border border-emerald-400/25 bg-emerald-300/5 px-3 py-2 text-xs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold text-emerald-200">분할 익절 진행중</span>
        <span className={`font-semibold tabular-nums ${realized >= 0 ? "text-emerald-300" : "text-rose-300"}`}>
          실현 {formatUsdt(realized)}
        </span>
      </div>
      <ul className="mt-1.5 space-y-0.5">
        {exits.map((e, i) => (
          <li key={`${e.time}-${i}`} className="flex flex-wrap justify-between gap-2 tabular-nums text-zinc-300">
            <span>
              ✓ {e.tag === "tp2" ? "2차" : "1차"} 익절 {e.size} {unit} @ {formatPrice(e.price)}
            </span>
            <span className="text-zinc-500">
              {formatTime(e.time)} · {formatUsdt(e.pnlUsdt)}
            </span>
          </li>
        ))}
      </ul>
      {remainingSize != null && (
        <p className="mt-1.5 tabular-nums text-zinc-400">
          잔여 {remainingSize} {unit}
          {nextTarget != null ? ` → 2차 익절 ${formatPrice(nextTarget)} 대기` : ""}
        </p>
      )}
    </div>
  )
}
