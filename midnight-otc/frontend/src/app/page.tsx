"use client";

import { useEffect, useState } from "react";

// ─── Static demo stats (replace with live data from contract/relayer) ─────────

const STATS = [
  { label: "Dark Pool Volume (HumidiFi, 1mo)", value: "$34B", sub: "Proves institutional demand" },
  { label: "Counterparty Risk (This Protocol)", value: "Zero", sub: "Atomic Zswap settlement" },
  { label: "Order Visibility to Observers", value: "None", sub: "AES-256-GCM encrypted" },
  { label: "Settlement Finality", value: "~2–5 min", sub: "Midnight block time" },
];

const PRIVACY_LAYERS = [
  {
    icon: "🔐",
    title: "Order Parameter Confidentiality",
    detail:
      "Price, size, and direction are AES-256-GCM encrypted client-side. Observers see only a random-looking ciphertext commitment on-chain.",
  },
  {
    icon: "🪪",
    title: "Identity Unlinkability",
    detail:
      "W3C Verifiable Credentials prove KYC status using BBS+ selective disclosure — without linking your on-chain address to your real identity.",
  },
  {
    icon: "👁️‍🗨️",
    title: "Settlement Unobservability",
    detail:
      "When an order fills, observers see only the commitment hash and a ZK proof of validity. No price, size, or counterparty addresses are revealed.",
  },
  {
    icon: "⚖️",
    title: "Selective Regulatory Disclosure",
    detail:
      "Regulators can inspect trades using threshold decryption — 2-of-3 identity issuers must cooperate. Built-in, not an afterthought.",
  },
];

const THREAT_TABLE = [
  { actor: "MEV / Front-runner", capability: "Monitor mempool", outcome: "Sees hash commitments only — cannot act on encrypted order params" },
  { actor: "Malicious Relayer", capability: "Control order propagation", outcome: "Can delay/censor orders, cannot decrypt or steal — any maker/taker can submit directly to chain" },
  { actor: "On-chain Observer", capability: "Read all transactions", outcome: "Sees ZK proofs and commitment hashes only, never plaintext" },
  { actor: "Compromised KYC Issuer", capability: "Issue fraudulent credentials", outcome: "Mitigated by 2-of-3 threshold: one bad issuer cannot unilaterally approve a credential" },
];

export default function Dashboard() {
  const [tick, setTick] = useState(0);

  // Simulated live commitment stream for demo
  const [liveCommitments, setLiveCommitments] = useState<{ hash: string; pair: string; time: string }[]>([
    { hash: "a3f8c2d1e4b9...", pair: "BTC/USDC", time: "just now" },
    { hash: "7b2e9d4a1c8f...", pair: "ETH/USDC", time: "12s ago" },
    { hash: "f1a5d8e3b2c9...", pair: "BTC/ETH",  time: "41s ago" },
  ]);

  useEffect(() => {
    const interval = setInterval(() => {
      setTick((t) => t + 1);
      // Randomly add a fake commitment to demonstrate live activity
      if (Math.random() > 0.6) {
        const hexChars = "0123456789abcdef";
        const hash = Array.from({ length: 12 }, () => hexChars[Math.floor(Math.random() * 16)]).join("") + "...";
        const pairs = ["BTC/USDC", "ETH/USDC", "BTC/ETH", "DUST/USDC"];
        setLiveCommitments((prev) => [
          { hash, pair: pairs[Math.floor(Math.random() * pairs.length)], time: "just now" },
          ...prev.slice(0, 4),
        ]);
      }
    }, 3000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="space-y-12">
      {/* Hero */}
      <section className="space-y-4">
        <div className="flex items-center gap-2 text-purple-400 text-sm">
          <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse" />
          Midnight Testnet — Mock Mode Active
        </div>
        <h1 className="text-4xl font-bold text-white leading-tight">
          Encrypted OTC Block Trading
          <br />
          <span className="text-purple-400">with Zero Counterparty Risk</span>
        </h1>
        <p className="text-gray-400 max-w-2xl text-lg">
          Institutional-grade dark pool trading on Midnight. Order parameters are
          encrypted client-side. Settlement is atomic via Zswap. No trusted
          intermediary ever sees your price or size.
        </p>
        <div className="flex gap-4 pt-2">
          <a
            href="/maker"
            className="bg-purple-600 hover:bg-purple-500 text-white px-5 py-2.5 rounded-lg font-medium transition-colors text-sm"
          >
            Create Encrypted Order →
          </a>
          <a
            href="/taker"
            className="border border-gray-700 hover:border-gray-500 text-gray-300 hover:text-white px-5 py-2.5 rounded-lg font-medium transition-colors text-sm"
          >
            Browse Order Book
          </a>
        </div>
      </section>

      {/* Stats */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {STATS.map((s) => (
          <div
            key={s.label}
            className="bg-gray-900 border border-gray-800 rounded-xl p-4"
          >
            <div className="text-2xl font-bold text-white mb-1">{s.value}</div>
            <div className="text-xs text-gray-500 mb-0.5">{s.label}</div>
            <div className="text-xs text-purple-400">{s.sub}</div>
          </div>
        ))}
      </section>

      {/* Live Order Stream */}
      <section>
        <h2 className="text-lg font-semibold text-white mb-4">
          Live On-Chain Commitments
          <span className="ml-3 text-xs text-gray-500 font-normal">
            (No price or size visible — only hash commitments)
          </span>
        </h2>
        <div className="bg-gray-900 border border-gray-800 rounded-xl overflow-hidden">
          <div className="border-b border-gray-800 px-4 py-2 flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
            <span className="text-xs text-gray-400">Midnight Blockchain — Public Mempool</span>
          </div>
          <div className="divide-y divide-gray-800">
            {liveCommitments.map((c, i) => (
              <div key={i} className="px-4 py-3 flex items-center justify-between">
                <div className="flex items-center gap-4">
                  <div className="text-purple-400 text-xs font-medium w-16">{c.pair}</div>
                  <code className="text-gray-500 text-xs hash encrypted-shimmer">
                    commitOrder({c.hash})
                  </code>
                </div>
                <div className="flex items-center gap-3">
                  <span className="text-xs text-green-400 bg-green-400/10 px-2 py-0.5 rounded">
                    encrypted
                  </span>
                  <span className="text-xs text-gray-600">{c.time}</span>
                </div>
              </div>
            ))}
          </div>
          <div className="px-4 py-3 border-t border-gray-800">
            <p className="text-xs text-gray-600">
              An observer sees only the hash commitment and asset pair. Price, size, and direction
              are encrypted inside the ciphertext.
            </p>
          </div>
        </div>
      </section>

      {/* Privacy Layers */}
      <section>
        <h2 className="text-lg font-semibold text-white mb-4">
          4-Layer Privacy Model
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {PRIVACY_LAYERS.map((layer) => (
            <div
              key={layer.title}
              className="bg-gray-900 border border-gray-800 rounded-xl p-5"
            >
              <div className="flex items-start gap-3">
                <span className="text-2xl">{layer.icon}</span>
                <div>
                  <div className="font-medium text-white text-sm mb-1">
                    {layer.title}
                  </div>
                  <div className="text-gray-400 text-sm leading-relaxed">
                    {layer.detail}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Adversary Model */}
      <section>
        <h2 className="text-lg font-semibold text-white mb-4">
          Adversary Model
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-800">
                <th className="pb-3 pr-4">Adversary</th>
                <th className="pb-3 pr-4">Capability</th>
                <th className="pb-3">Protocol Response</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-800">
              {THREAT_TABLE.map((row) => (
                <tr key={row.actor}>
                  <td className="py-3 pr-4 text-red-400 font-medium">{row.actor}</td>
                  <td className="py-3 pr-4 text-gray-400">{row.capability}</td>
                  <td className="py-3 text-green-400">{row.outcome}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Architecture */}
      <section>
        <h2 className="text-lg font-semibold text-white mb-4">
          Multi-Agent Architecture
        </h2>
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-5 overflow-x-auto">
          <div className="flex items-start justify-center min-w-max gap-0">
            {[
              { label: "MAKER", desc: "Encrypts order params locally → posts hash commitment + escrowed tokens on-chain", color: "purple" },
              { label: "RELAYER", desc: "Aggregates encrypted orders off-chain → signals direction-compatible matches (no decryption)", color: "blue" },
              { label: "ID VERIFIER", desc: "Issues W3C Verifiable Credentials for KYC → threshold 2-of-3 signature required", color: "yellow" },
              { label: "ZSWAP CONTRACT", desc: "Atomic settlement: verifies credential + commitment integrity → swaps assets", color: "green" },
            ].map((node, i) => (
              <div key={node.label} className="flex items-start">
                {i > 0 && (
                  <div className="flex items-center pt-4 px-2 text-gray-600 text-xl font-thin">→</div>
                )}
                <div className="flex flex-col items-center w-44">
                  <div className={`text-xs font-bold px-3 py-1.5 rounded border text-center
                    ${node.color === 'purple' ? 'border-purple-800 text-purple-400 bg-purple-950/30' :
                      node.color === 'blue' ? 'border-blue-800 text-blue-400 bg-blue-950/30' :
                      node.color === 'yellow' ? 'border-yellow-800 text-yellow-400 bg-yellow-950/30' :
                      'border-green-800 text-green-400 bg-green-950/30'}`}
                  >
                    {node.label}
                  </div>
                  <p className="text-gray-400 text-xs leading-relaxed mt-2 text-center px-1">{node.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}
