"use client"

import { useState } from "react"
import BitcoinEntryChart from "./BitcoinEntryChart"
import IctStrategyChart from "./IctStrategyChart"
import TradeReportsPanel from "./TradeReportsPanel"

type Tab = "counter-trend" | "ict" | "reports"

export default function StrategyTabs() {
  const [tab, setTab] = useState<Tab>("counter-trend")

  return (
    <div className="min-h-screen bg-[#05070a]">
      <div className="mx-auto flex max-w-[1360px] items-center gap-2 px-3 pt-6 sm:px-6 lg:px-10">
        <button
          onClick={() => setTab("counter-trend")}
          className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
            tab === "counter-trend" ? "bg-red-400/20 text-red-200" : "bg-[#0c1119] text-zinc-500 hover:text-zinc-300"
          }`}
        >
          역추세매매 (double-bottom)
        </button>
        <button
          onClick={() => setTab("ict")}
          className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
            tab === "ict" ? "bg-fuchsia-400/20 text-fuchsia-200" : "bg-[#0c1119] text-zinc-500 hover:text-zinc-300"
          }`}
        >
          ICT 전략 (실험적)
        </button>
        <button
          onClick={() => setTab("reports")}
          className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
            tab === "reports" ? "bg-amber-400/20 text-amber-200" : "bg-[#0c1119] text-zinc-500 hover:text-zinc-300"
          }`}
        >
          거래 리포트
        </button>
      </div>
      {tab === "counter-trend" ? <BitcoinEntryChart /> : tab === "ict" ? <IctStrategyChart /> : <TradeReportsPanel />}
    </div>
  )
}
