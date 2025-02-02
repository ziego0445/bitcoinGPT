/* eslint-disable @typescript-eslint/no-unused-vars */
"use client"
import { useState, useEffect } from "react"
import { ArrowUpIcon, ArrowDownIcon } from "@heroicons/react/24/solid"
import { ChartBarIcon } from "@heroicons/react/24/outline"
import OpenAI from 'openai'
import html2canvas from 'html2canvas'

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

// OpenAI 클라이언트 초기화를 조건부로 수정
const openai = typeof window !== 'undefined' ? new OpenAI({
  apiKey: process.env.NEXT_PUBLIC_OPENAI_API_KEY || '',
  dangerouslyAllowBrowser: true
}) : null

export default function TradingSignals() {
  // 테스트용 기본 신호 설정을 useEffect로 이동
  const [signal, setSignal] = useState<SignalData | null>(null)
  const [isAnalyzing, setIsAnalyzing] = useState(false)
  const [manualAnalysis, setManualAnalysis] = useState<string>("")
  const [capturedImage, setCapturedImage] = useState<string>("")

  useEffect(() => {
    // 테스트용 기본 신호를 클라이언트 사이드에서만 설정
    setSignal({
      type: 'BUY',
      reason: '테스트용 매수 신호: 최근 15분간 -1.5% 하락 추세로 인한 반등 매수 시그널',
      price: 65400,
      timestamp: Date.now(),
      entryPrice: 65465.40,
      targetPrice: 66120.05,
      aiAnalysis: "현재 RSI가 과매도 구간(30 이하)에 진입했으며, MACD 히스토그램이 상승 반전을 시도하고 있습니다. 이전 3개의 5분봉이 연속 하락하여 단기 과매도 상태로 판단됩니다. 스토캐스틱도 하단에서 반등 조짐을 보이고 있어, 향후 5-10분 동안 기술적 반등이 예상됩니다. 단, $65,200 지지선이 깨질 경우 추가 하락 가능성도 있으니 주의가 필요합니다."
    })

    // 신호 체크 인터벌 설정
    checkSignals()
    const interval = setInterval(checkSignals, 1000 * 60)
    return () => clearInterval(interval)
  }, [])

  const captureChart = async (): Promise<string> => {
    try {
      const chartElement = document.getElementById('tradingview_chart')
      if (!chartElement) {
        console.error('차트 엘리먼트를 찾을 수 없습니다')
        return ''
      }

      // iframe 내부의 차트가 로드될 때까지 대기
      await new Promise(resolve => setTimeout(resolve, 1000))

      const canvas = await html2canvas(chartElement, {
        useCORS: true,
        allowTaint: true,
        backgroundColor: '#1f2937',
        scale: 2,
      })

      // Canvas를 Blob으로 변환
      const blob = await new Promise<Blob>((resolve) => {
        canvas.toBlob((blob) => {
          resolve(blob as Blob)
        }, 'image/png')
      })

      // Blob을 File 객체로 변환
      const file = new File([blob], `chart-${Date.now()}.png`, { type: 'image/png' })
      
      // File을 URL로 변환
      const imageUrl = URL.createObjectURL(file)
      console.log('캡쳐된 이미지 URL:', imageUrl)
      
      return imageUrl
    } catch (error) {
      console.error('차트 캡쳐 중 오류 발생:', error)
      return ''
    }
  }

  const getAIAnalysis = async (chartData: KlineData[]) => {
    try {
      if (!openai) {
        return "OpenAI 클라이언트 초기화에 실패했습니다."
      }

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
        model: "gpt-4o-mini",
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
      // 5분봉 4개 데이터 가져오기 (이전 3개 + 현재)
      const response = await fetch(
        'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=4'
      )
      const data = await response.json()
      
      const candles: KlineData[] = data.map((item: BinanceKlineData) => ({
        timestamp: item[0],
        open: parseFloat(item[1]),
        high: parseFloat(item[2]),
        low: parseFloat(item[3]),
        close: parseFloat(item[4])
      }))

      // 하락 추세 확인 (이전 3개 봉이 연속 하락인지)
      const isDowntrend = candles.slice(0, 3).every((candle, index, array) => {
        if (index === 0) return true
        return candle.close < array[index - 1].close
      })

      // 현재 봉
      const currentCandle = candles[candles.length - 1]
      // 직전 봉
      const prevCandle = candles[candles.length - 2]

      // 하락 폭 계산 (3개 봉의 전체 하락률)
      const totalPriceChange = ((candles[2].close - candles[0].open) / candles[0].open) * 100

      console.log('5분봉 데이터:', {
        candles,
        isDowntrend,
        totalPriceChange,
        currentTime: new Date().toLocaleString()
      })

      if (isDowntrend && totalPriceChange <= -1) { // 3개 봉 연속 하락이고 총 1% 이상 하락
        setIsAnalyzing(true)
        const aiAnalysis = await getAIAnalysis(candles)
        const { entryPrice, targetPrice } = calculatePrices(currentCandle.close, true)

        setSignal({
          type: 'BUY',
          reason: `최근 15분간 ${totalPriceChange.toFixed(2)}% 하락 추세로 인한 반등 매수 시그널`,
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
      // 차트 캡쳐
      const chartImage = await captureChart()
      if (chartImage) {
        setCapturedImage(chartImage)
      }

      const response = await fetch(
        'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=5m&limit=4'
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

  // 컴포넌트 cleanup 시 URL 해제를 위한 useEffect 추가
  useEffect(() => {
    return () => {
      if (capturedImage) {
        URL.revokeObjectURL(capturedImage)
      }
    }
  }, [capturedImage])

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
            
            {/* 캡쳐된 이미지와 분석 결과를 나란히 표시 */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {capturedImage && (
                <div className="bg-gray-700/50 p-4 rounded">
                  <h4 className="text-sm font-semibold text-gray-300 mb-2">캡쳐된 차트</h4>
                  <div className="relative aspect-video">
                    <img 
                      src={capturedImage} 
                      alt="캡쳐된 차트" 
                      className="rounded w-full h-full object-cover"
                    />
                  </div>
                </div>
              )}
              {manualAnalysis && (
                <div className="bg-gray-700/50 p-4 rounded">
                  <h4 className="text-sm font-semibold text-gray-300 mb-2">AI 분석 결과</h4>
                  <p className="text-gray-200 whitespace-pre-wrap">{manualAnalysis}</p>
                </div>
              )}
            </div>
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

        {/* AI 분석 섹션 수정 */}
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
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
            {capturedImage && (
              <div className="relative aspect-video">
                <img 
                  src={capturedImage} 
                  alt="캡쳐된 차트" 
                  className="rounded w-full h-full object-cover"
                />
              </div>
            )}
            <div>
              {isAnalyzing ? (
                <p className="text-gray-400">분석 중...</p>
              ) : (
                <p className="text-gray-200">{manualAnalysis || signal.aiAnalysis}</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

