"use client"

import { useState, useEffect } from "react"
import { ArrowUpIcon, ArrowDownIcon } from "@heroicons/react/24/solid"

interface KlineData {
  timestamp: number
  open: number
  close: number
  high: number
  low: number
}

export default function TradingSignals() {
  const [signal, setSignal] = useState<{
    type: 'BUY' | 'SELL' | 'NEUTRAL'
    reason: string
    price: number
    timestamp: number
  } | null>(null)

  useEffect(() => {
    checkSignals()
    const interval = setInterval(checkSignals, 1000 * 10) // 10초마다 체크
    return () => clearInterval(interval)
  }, [])

  const checkSignals = async () => {
    try {
      // 1분봉 2개 데이터 가져오기
      const response = await fetch(
        'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=2'
      )
      const data = await response.json()
      
      const candles: KlineData[] = data.map((item: any) => ({
        timestamp: item[0],
        open: parseFloat(item[1]),
        high: parseFloat(item[2]),
        low: parseFloat(item[3]),
        close: parseFloat(item[4])
      }))

      // 직전 봉과 현재 봉의 가격 변화 계산
      const prevCandle = candles[0]
      const currentCandle = candles[1]
      const priceChange = ((currentCandle.close - prevCandle.open) / prevCandle.open) * 100

      // 0.2% 이상 하락했을 때 매수 신호 발생 (1분봉이므로 기준값 하향 조정)
      if (priceChange <= -0.2) {
        setSignal({
          type: 'BUY',
          reason: `최근 1분간 ${priceChange.toFixed(2)}% 하락으로 인한 반등 매수 시그널`,
          price: currentCandle.close,
          timestamp: Date.now()
        })
      } else {
        setSignal(null)
      }
    } catch (error) {
      console.error('신호 체크 중 오류 발생:', error)
    }
  }

  if (!signal) {
    return (
      <div className="bg-gray-800 p-4 rounded-lg">
        <h2 className="text-xl font-bold text-white mb-4">매매 신호</h2>
        <p className="text-gray-400">현재 매매 신호가 없습니다</p>
      </div>
    )
  }

  return (
    <div className="bg-gray-800 p-4 rounded-lg">
      <h2 className="text-xl font-bold text-white mb-4">매매 신호</h2>
      <div className={`p-4 rounded-lg ${
        signal.type === 'BUY' 
          ? 'bg-green-900/50' 
          : signal.type === 'SELL' 
            ? 'bg-red-900/50' 
            : 'bg-gray-700'
      }`}>
        <div className="flex items-center gap-2 mb-2">
          {signal.type === 'BUY' && (
            <ArrowUpIcon className="w-6 h-6 text-green-500" />
          )}
          {signal.type === 'SELL' && (
            <ArrowDownIcon className="w-6 h-6 text-red-500" />
          )}
          <span className={`font-bold ${
            signal.type === 'BUY' 
              ? 'text-green-500' 
              : signal.type === 'SELL' 
                ? 'text-red-500' 
                : 'text-gray-400'
          }`}>
            {signal.type} 신호
          </span>
        </div>
        <p className="text-white mb-2">{signal.reason}</p>
        <p className="text-gray-400">
          가격: ${signal.price.toLocaleString()}
        </p>
        <p className="text-gray-400 text-sm">
          {new Date(signal.timestamp).toLocaleString()}
        </p>
      </div>
    </div>
  )
}

