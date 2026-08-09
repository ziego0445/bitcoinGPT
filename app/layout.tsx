import "./globals.css"
import { Inter } from "next/font/google"
import type React from "react"

const inter = Inter({ subsets: ["latin"] })

export const metadata = {
  title: "Bitcoin Entry Radar",
  description: "BTCUSDT entry-reference signals based on volume, support, and price action.",
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="ko" className="dark">
      <body className={inter.className}>{children}</body>
    </html>
  )
}
