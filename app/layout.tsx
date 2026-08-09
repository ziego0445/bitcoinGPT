import "./globals.css"
import { Inter } from "next/font/google"
import type React from "react"

const inter = Inter({ subsets: ["latin"] })

export const metadata = {
  title: "BTC Entry Chart",
  description: "Bitcoin chart for entry reference",
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
