import BitcoinChart from "./components/BitcoinChart"
import TradingSignals from "./components/TradingSignals"
import CommunityFeed from "./components/CommunityFeed"
import Header from "./components/Header"

export default function Home() {
  return (
    <div className="min-h-screen bg-gray-900 flex flex-col">
      <Header />
      <main className="flex-1 container mx-auto px-4 py-8 flex flex-col">
        <div className="mb-8">
          <TradingSignals />
        </div>
        <div className="h-[500px] mb-8">
          <BitcoinChart />
        </div>
        <div className="flex-1 min-h-[400px]">
          <CommunityFeed />
        </div>
      </main>
    </div>
  )
}

