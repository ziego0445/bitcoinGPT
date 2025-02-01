"use client"

import { useEffect, useRef } from "react"

declare global {
  interface Window {
    TradingView: any
  }
}

export default function BitcoinChart() {
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const script = document.createElement("script")
    script.src = "https://s3.tradingview.com/tv.js"
    script.async = true
    script.onload = () => {
      if (container.current) {
        new window.TradingView.widget({
          autosize: true,
          symbol: "BINANCE:BTCUSDT",
          interval: "5",
          timezone: "Asia/Seoul",
          theme: "dark",
          style: "1",
          locale: "kr",
          toolbar_bg: "#1e293b",
          enable_publishing: false,
          hide_side_toolbar: false,
          allow_symbol_change: true,
          container_id: "tradingview_chart",
          library_path: "/charting_library/",
          width: "100%",
          height: "100%",
          save_image: false,
          hide_volume: false,
          studies: [
            "RSI@tv-basicstudies",
            "MASimple@tv-basicstudies",
          ],
        })
      }
    }

    document.head.appendChild(script)
    return () => {
      if (document.head.contains(script)) {
        document.head.removeChild(script)
      }
    }
  }, [])

  return (
    <div className="bg-gray-800 p-4 rounded-lg h-full w-full">
      <h2 className="text-xl font-bold mb-4 text-white">비트코인 차트 (5분봉)</h2>
      <div 
        id="tradingview_chart" 
        ref={container} 
        className="w-full h-[calc(100%-3rem)]"
      />
    </div>
  )
}

