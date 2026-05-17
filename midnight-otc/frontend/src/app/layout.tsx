import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MidnightOTC — Encrypted Block Trading",
  description:
    "Privacy-preserving OTC trading with encrypted limit orders and atomic settlement on Midnight",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-gray-950 text-gray-100 min-h-screen font-mono">
        <nav className="border-b border-gray-800 px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-2 h-2 rounded-full bg-purple-500 animate-pulse" />
            <span className="text-white font-semibold tracking-tight">
              MidnightOTC
            </span>
            <span className="text-xs text-gray-500 bg-gray-900 px-2 py-0.5 rounded border border-gray-800">
              testnet
            </span>
          </div>
          <div className="flex items-center gap-6 text-sm text-gray-400">
            <a href="/" className="hover:text-white transition-colors">
              Dashboard
            </a>
            <a href="/maker" className="hover:text-white transition-colors">
              Create Order
            </a>
            <a href="/taker" className="hover:text-white transition-colors">
              Browse Orders
            </a>
          </div>
        </nav>
        <main className="px-6 py-8 max-w-6xl mx-auto">{children}</main>
      </body>
    </html>
  );
}
