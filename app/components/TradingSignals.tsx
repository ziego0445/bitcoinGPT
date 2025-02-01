/* eslint-disable @typescript-eslint/no-unused-vars */
"use client"
import { useState, useEffect } from "react"
import { ArrowUpIcon, ArrowDownIcon } from "@heroicons/react/24/solid"
import { ChartBarIcon } from "@heroicons/react/24/outline"
import OpenAI from 'openai'
import { toJpeg } from 'html-to-image'

interface KlineData {
  timestamp: number
  open: number
  close: number
  high: number
  low: number
}

interface SignalData {
  type: 'BUY' | 'SELL' | 'NEUTRAL'
  reason: string
  price: number
  timestamp: number
  entryPrice: number
  targetPrice: number
  aiAnalysis: string
}

interface BinanceKlineData {
  0: number;    // timestamp
  1: string;    // open
  2: string;    // high
  3: string;    // low
  4: string;    // close
  5: string;    // volume
}

const openai = new OpenAI({
  apiKey: process.env.NEXT_PUBLIC_OPENAI_API_KEY,
  dangerouslyAllowBrowser: true
})

export default function TradingSignals() {
  const [signal, setSignal] = useState<SignalData | null>(null)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [manualAnalysis, setManualAnalysis] = useState<string>("")

  useEffect(() => {
    checkSignals()
    const interval = setInterval(checkSignals, 1000 * 10)
    return () => clearInterval(interval)
  }, [])

  const captureChart = async (): Promise<string> => {
    const chartElement = document.getElementById('tradingview_chart')
    if (!chartElement) return ''

    try {
      const dataUrl = await toJpeg(chartElement)
      return dataUrl
    } catch (error) {
      console.error('차트 캡쳐 중 오류 발생:', error)
      return ''
    }
  }

  const getAIAnalysis = async (chartData: KlineData[]) => {
    try {
      // 차트 캡쳐
      const chartImage = await captureChart()
      if (!chartImage) {
        return "차트 분석을 위한 이미지 캡쳐에 실패했습니다."
      }

      // 현재 시장 데이터 준비
      const currentPrice = chartData[1].close
      const priceChange = ((chartData[1].close - chartData[0].open) / chartData[0].open) * 100
      const volatility = ((chartData[1].high - chartData[1].low) / chartData[1].low) * 100

      // GPT에 분석 요청
      const response = await openai.chat.completions.create({
        model: "gpt-4",
        messages: [
          {
            role: "user",
            content: `비트코인 차트를 분석해주세요. 현재가: $${currentPrice.toLocaleString()}, 
            1분 변동률: ${priceChange.toFixed(2)}%, 
            변동성: ${volatility.toFixed(2)}%. 
            향후 5-10분 동안의 단기 가격 움직임에 대한 기술적 분석과 의견을 제시해주세요.`
          }
        ],
        max_tokens: 150,
        temperature: 0.7
      })

      return response.choices[0]?.message?.content || "분석 결과를 가져오는데 실패했습니다."
    } catch (error) {
      console.error('AI 분석 중 오류 발생:', error)
      return "AI 분석 중 오류가 발생했습니다."
    }
  }

  const calculatePrices = (currentPrice: number, isLong: boolean) => {
    // 진입가는 현재가에서 약간의 슬리피지 고려
    const entryPrice = isLong 
      ? currentPrice * 1.001  // 롱은 0.1% 위
      : currentPrice * 0.999  // 숏은 0.1% 아래

    // 목표가는 진입가에서 1% 움직임 가정
    const targetPrice = isLong
      ? entryPrice * 1.01     // 롱은 1% 위
      : entryPrice * 0.99     // 숏은 1% 아래

    return { entryPrice, targetPrice }
  }

  const checkSignals = async () => {
    try {
      const response = await fetch(
        'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=2'
      )
      const data = await response.json()
      
      const candles: KlineData[] = data.map((item: BinanceKlineData) => ({
        timestamp: item[0],
        open: parseFloat(item[1]),
        high: parseFloat(item[2]),
        low: parseFloat(item[3]),
        close: parseFloat(item[4])
      }))

      const prevCandle = candles[0]
      const currentCandle = candles[1]
      const priceChange = ((currentCandle.close - prevCandle.open) / prevCandle.open) * 100

      if (priceChange <= -0.2) {
        setIsAnalyzing(true)
        const aiAnalysis = await getAIAnalysis(candles)
        const { entryPrice, targetPrice } = calculatePrices(currentCandle.close, true)

        setSignal({
          type: 'BUY',
          reason: `최근 1분간 ${priceChange.toFixed(2)}% 하락으로 인한 반등 매수 시그널`,
          price: currentCandle.close,
          timestamp: Date.now(),
          entryPrice,
          targetPrice,
          aiAnalysis
        })
        setIsAnalyzing(false)
      } else {
        setSignal(null)
      }
    } catch (error) {
      console.error('신호 체크 중 오류 발생:', error)
      setIsAnalyzing(false)
    }
  }

  const handleManualAnalysis = async () => {
    setIsAnalyzing(true)
    try {
      const response = await fetch(
        'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=2'
      )
      const data = await response.json()
      
      const candles: KlineData[] = data.map((item: BinanceKlineData) => ({
        timestamp: item[0],
        open: parseFloat(item[1]),
        high: parseFloat(item[2]),
        low: parseFloat(item[3]),
        close: parseFloat(item[4])
      }))

      const analysis = await getAIAnalysis(candles)
      setManualAnalysis(analysis)
    } catch (error) {
      console.error('수동 분석 중 오류 발생:', error)
      setManualAnalysis("분석 중 오류가 발생했습니다.")
    } finally {
      setIsAnalyzing(false)
    }
  }

  if (!signal) {
    return (
      <div className="bg-gray-800 p-4 rounded-lg">
        <h2 className="text-xl font-bold text-white mb-4">매매 신호</h2>
        <div className="flex flex-col gap-4">
          <p className="text-gray-400">현재 매매 신호가 없습니다</p>
          
          {/* 수동 분석 섹션 */}
          <div className="border-t border-gray-700 pt-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-white">AI 차트 분석</h3>
              <button
                onClick={handleManualAnalysis}
                disabled={isAnalyzing}
                className={`flex items-center gap-2 px-4 py-2 rounded ${
                  isAnalyzing 
                    ? 'bg-gray-600 cursor-not-allowed' 
                    : 'bg-blue-600 hover:bg-blue-700'
                } transition-colors`}
              >
                <ChartBarIcon className="w-5 h-5" />
                <span>{isAnalyzing ? '분석 중...' : '차트 분석하기'}</span>
              </button>
            </div>
            
            {manualAnalysis && (
              <div className="bg-gray-700/50 p-4 rounded">
                <p className="text-gray-200 whitespace-pre-wrap">{manualAnalysis}</p>
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-gray-800 p-4 rounded-lg">
      <h2 className="text-xl font-bold text-white mb-4">매매 신호</h2>
      <div className={`p-4 rounded-lg ${
        signal.type === 'BUY' 
          ? 'bg-green-900/50' 
          : 'bg-red-900/50'
      }`}>
        {/* 신호 타입 및 시간 */}
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            {signal.type === 'BUY' && (
              <ArrowUpIcon className="w-6 h-6 text-green-500" />
            )}
            <span className="font-bold text-green-500">
              {signal.type} 신호
            </span>
          </div>
          <span className="text-sm text-gray-400">
            {new Date(signal.timestamp).toLocaleString()}
          </span>
        </div>

        {/* 신호 발생 이유 */}
        <p className="text-white mb-4">{signal.reason}</p>

        {/* 가격 정보 */}
        <div className="grid grid-cols-3 gap-4 mb-4">
          <div className="bg-gray-700/50 p-3 rounded">
            <p className="text-sm text-gray-400 mb-1">현재가</p>
            <p className="text-white font-bold">${signal.price.toLocaleString()}</p>
          </div>
          <div className="bg-gray-700/50 p-3 rounded">
            <p className="text-sm text-gray-400 mb-1">진입가</p>
            <p className="text-white font-bold">${signal.entryPrice.toLocaleString()}</p>
          </div>
          <div className="bg-gray-700/50 p-3 rounded">
            <p className="text-sm text-gray-400 mb-1">목표가</p>
            <p className="text-white font-bold">${signal.targetPrice.toLocaleString()}</p>
          </div>
        </div>

        {/* AI 분석 섹션에 수동 분석 버튼 추가 */}
        <div className="bg-gray-700/50 p-4 rounded">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-white font-bold">AI 분석</h3>
            <button
              onClick={handleManualAnalysis}
              disabled={isAnalyzing}
              className={`flex items-center gap-2 px-3 py-1 rounded text-sm ${
                isAnalyzing 
                  ? 'bg-gray-600 cursor-not-allowed' 
                  : 'bg-blue-600 hover:bg-blue-700'
              } transition-colors`}
            >
              <ChartBarIcon className="w-4 h-4" />
              <span>{isAnalyzing ? '분석 중...' : '새로 분석'}</span>
            </button>
          </div>
          {isAnalyzing ? (
            <p className="text-gray-400">분석 중...</p>
          ) : (
            <p className="text-gray-200">{manualAnalysis || signal.aiAnalysis}</p>
          )}
        </div>
      </div>
    </div>
  )
}

