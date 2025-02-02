"use client"

import { useEffect, useRef } from "react"

interface TradingViewConfig {
  autosize: boolean
  symbol: string
  interval: string
  timezone: string
  theme: string
  style: string
  locale: string
  toolbar_bg: string
  enable_publishing: boolean
  hide_side_toolbar: boolean
  allow_symbol_change: boolean
  container_id: string
  width: string
  height: string
  save_image: boolean
  hide_volume: boolean
  studies: string[]
}

interface TradingViewInstance {
  onChartReady: (callback: () => void) => void
  takeScreenshot: () => Promise<string>
  _ready?: boolean
}

interface TradingViewWidget extends TradingViewInstance {
  _ready: boolean  // 내부 속성으로 사용되는 _ready를 명시적으로 정의
}

declare global {
  interface Window {
    TradingView: {
      widget: new (config: TradingViewConfig) => TradingViewInstance
    }
    tvWidget?: TradingViewInstance
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
        const widgetOptions: TradingViewConfig = {
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
          width: "100%",
          height: "100%",
          save_image: true,
          hide_volume: false,
          studies: [
            "RSI@tv-basicstudies",
            "MASimple@tv-basicstudies",
          ],
        }

        const widget = new window.TradingView.widget(widgetOptions)

        // 위젯을 전역 변수에 할당
        window.tvWidget = widget

        // 차트 로드 완료 이벤트 리스너
        const waitForChartLoad = () => {
          if (widget && (widget as TradingViewWidget)._ready) {
            window.tvWidget = widget
          } else {
            setTimeout(waitForChartLoad, 100)
          }
        }

        waitForChartLoad()
      }
    }

    document.head.appendChild(script)
    return () => {
      if (document.head.contains(script)) {
        document.head.removeChild(script)
      }
      delete window.tvWidget
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

