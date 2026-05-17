"use client";

import { useState, useEffect, useRef } from "react";
import { revealAndMatch } from "../../lib/contract";
import {
  generateECDHKeyPair,
  importPeerPublicKey,
  decryptKeyFromMaker,
  decryptOrder,
} from "../../lib/crypto";
import { relayerClient } from "../../lib/relayer";
import type { RelayerOrderEntry, SettlementResult } from "../../../../shared/types";

const USE_MOCK = process.env.NEXT_PUBLIC_USE_MOCK === "true";

// ─── Mock order book for demo ─────────────────────────────────────────────────

const MOCK_ORDERS: RelayerOrderEntry[] = [
  {
    id: "ord-001",
    commitment: "a3f8c2d1e4b9fa23c1d8e4f9a0b3c2d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1",
    ciphertext: "[AES-256-GCM encrypted — price and size hidden]",
    iv: "c2d5e6f7a8b9c0d1e2f3a4b5",
    authTag: "c2d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9",
    salt: "a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1",
    assetPair: "BTC/USDC",
    directionBit: 1,
    expiry: Math.floor(Date.now() / 1000) + 86400,
    makerAddress: "0xMaker1a2b3c4d5e6f7a8b9c0d1e2f3",
    makerPublicKey: "04a3f8c2d1e4b9fa23c1d8e4f9a0b3c2",
    signature: "",
    receivedAt: Date.now() - 120_000,
    status: "open",
  },
  {
    id: "ord-002",
    commitment: "b7e9d3a5c1f8e4b2d9a7c3f1e8b4d2a6c9e3b7d5a1f9c7e5b3d1a9f7c5e3b1d9",
    ciphertext: "[AES-256-GCM encrypted — price and size hidden]",
    iv: "a1b2c3d4e5f6a7b8c9d0e1f2",
    authTag: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6",
    salt: "e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2",
    assetPair: "ETH/USDC",
    directionBit: 1,
    expiry: Math.floor(Date.now() / 1000) + 3600 * 4,
    makerAddress: "0xMaker9f8e7d6c5b4a3e2d1c0b9a8f7e6d5",
    makerPublicKey: "04b7e9d3a5c1f8e4b2d9a7c3f1e8b4d2",
    signature: "",
    receivedAt: Date.now() - 600_000,
    status: "open",
  },
  {
    id: "ord-003",
    commitment: "c4d2f8a6e1b9d7c5a3f1e9d7b5c3a1f9e7d5b3a1f9c7e5b3d1a9f7c5e3b1d9f7",
    ciphertext: "[AES-256-GCM encrypted — price and size hidden]",
    iv: "d4e5f6a7b8c9d0e1f2a3b4c5",
    authTag: "d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9",
    salt: "f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2",
    assetPair: "BTC/USDC",
    directionBit: 0,
    expiry: Math.floor(Date.now() / 1000) + 86400 * 7,
    makerAddress: "0xMaker3c4d5e6f7a8b9c0d1e2f3a4b5c6",
    makerPublicKey: "04c4d2f8a6e1b9d7c5a3f1e9d7b5c3a1",
    signature: "",
    receivedAt: Date.now() - 1_800_000,
    status: "open",
  },
];

const MOCK_TAKER = "0xTaker987654321fedcba0987654321fedcba";

type SettleStep = "idle" | "requesting-key" | "decrypting" | "settling" | "done" | "error";

interface SelectedOrder {
  order: RelayerOrderEntry;
  step: SettleStep;
  result?: SettlementResult;
  error?: string;
  revealedPrice?: number;
  revealedAmount?: number;
}

export default function TakerPage() {
  const [orders, setOrders] = useState<RelayerOrderEntry[]>(USE_MOCK ? MOCK_ORDERS : []);
  const [filterPair, setFilterPair] = useState<string>("all");
  const [filterDir, setFilterDir] = useState<"all" | "buy" | "sell">("all");
  const [selected, setSelected] = useState<SelectedOrder | null>(null);

  // Holds the resolve callback for the pending ECDH key exchange Promise
  const keyResolveRef = useRef<((encryptedAesKey: string) => void) | null>(null);
  const keyRejectRef = useRef<((err: Error) => void) | null>(null);

  useEffect(() => {
    relayerClient.connect();

    const unsub = relayerClient.subscribe((event) => {
      switch (event.event) {
        case "snapshot":
          if (!USE_MOCK) setOrders(event.orders);
          break;
        case "order:new":
          if (!USE_MOCK) setOrders((prev) => [event.order, ...prev]);
          break;
        case "order:filled":
          if (!USE_MOCK)
            setOrders((prev) =>
              prev.map((o) => (o.id === event.id ? { ...o, status: "filled" } : o))
            );
          break;
        case "order:cancelled":
          if (!USE_MOCK)
            setOrders((prev) =>
              prev.map((o) => (o.id === event.id ? { ...o, status: "cancelled" } : o))
            );
          break;
        case "key:received":
          if (keyResolveRef.current) {
            keyResolveRef.current(event.encryptedAesKey);
            keyResolveRef.current = null;
            keyRejectRef.current = null;
          }
          break;
      }
    });

    return () => {
      unsub();
      if (keyRejectRef.current) {
        keyRejectRef.current(new Error("Component unmounted"));
        keyResolveRef.current = null;
        keyRejectRef.current = null;
      }
    };
  }, []);

  const filteredOrders = orders.filter((o) => {
    if (o.status !== "open") return false;
    if (filterPair !== "all" && o.assetPair !== filterPair) return false;
    if (filterDir === "buy" && o.directionBit !== 0) return false;
    if (filterDir === "sell" && o.directionBit !== 1) return false;
    return true;
  });

  const selectOrder = (order: RelayerOrderEntry) => {
    setSelected({ order, step: "idle" });
  };

  const startFill = async () => {
    if (!selected) return;
    const order = selected.order;

    setSelected((s) => s ? { ...s, step: "requesting-key" } : s);

    let revealedPrice: number;
    let revealedAmount: number;

    if (USE_MOCK) {
      // ── Mock path: simulate ECDH with fake values ──────────────────────────
      await delay(1500);

      setSelected((s) => s ? { ...s, step: "decrypting" } : s);
      await delay(1200);

      revealedPrice =
        order.assetPair === "BTC/USDC"
          ? 41850 + Math.floor(Math.random() * 300)
          : order.assetPair === "ETH/USDC"
          ? 2480 + Math.floor(Math.random() * 40)
          : 0.06 + Math.random() * 0.005;
      revealedAmount = 0.5 + Math.random() * 2;

      setSelected((s) => s ? { ...s, revealedPrice, revealedAmount } : s);
      await delay(800);
    } else {
      // ── Real path: ECDH key exchange via relayer ───────────────────────────
      try {
        const keyPair = await generateECDHKeyPair();

        // Wait for the maker to respond with the encrypted AES key (30s timeout)
        const encryptedAesKey = await new Promise<string>((resolve, reject) => {
          const timer = setTimeout(() => {
            keyResolveRef.current = null;
            keyRejectRef.current = null;
            reject(new Error("Key exchange timed out — maker did not respond within 30s"));
          }, 30_000);

          keyResolveRef.current = (key: string) => {
            clearTimeout(timer);
            resolve(key);
          };
          keyRejectRef.current = (err: Error) => {
            clearTimeout(timer);
            reject(err);
          };

          relayerClient.expressInterest(order.id, keyPair.publicKeyHex);
        });

        setSelected((s) => s ? { ...s, step: "decrypting" } : s);

        // Recover the AES key using ECDH: taker private key + maker public key
        const makerPubKey = await importPeerPublicKey(order.makerPublicKey);
        const aesKeyHex = await decryptKeyFromMaker(
          encryptedAesKey,
          keyPair.privateKey,
          makerPubKey
        );

        // Decrypt the order to reveal real price and amount
        const plaintext = await decryptOrder(order.ciphertext, order.iv, order.authTag, aesKeyHex);
        revealedPrice = plaintext.price;
        revealedAmount = plaintext.amount;

        setSelected((s) => s ? { ...s, revealedPrice, revealedAmount } : s);
        await delay(800);
      } catch (err) {
        setSelected((s) => s ? { ...s, step: "error", error: (err as Error).message } : s);
        return;
      }
    }

    // ── Settlement ────────────────────────────────────────────────────────────
    setSelected((s) => s ? { ...s, step: "settling" } : s);

    try {
      const result = await revealAndMatch(order.id, {
        commitment: order.commitment,
        ciphertext: order.ciphertext,
        iv: order.iv,
        authTag: order.authTag,
        salt: order.salt,
        takerAddress: MOCK_TAKER,
        takerCredentialProof: "mock-verified-credential",
      });

      if (result.success) {
        setOrders((prev) =>
          prev.map((o) => (o.id === order.id ? { ...o, status: "filled" } : o))
        );
        setSelected((s) => s ? { ...s, step: "done", result } : s);
      } else {
        setSelected((s) => s ? { ...s, step: "error", error: result.error } : s);
      }
    } catch (err) {
      setSelected((s) => s ? { ...s, step: "error", error: (err as Error).message } : s);
    }
  };

  const timeLeft = (expiry: number) => {
    const diff = expiry - Math.floor(Date.now() / 1000);
    if (diff <= 0) return "Expired";
    if (diff < 3600) return `${Math.floor(diff / 60)}m`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h`;
    return `${Math.floor(diff / 86400)}d`;
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white">Browse Order Book</h1>
        <p className="text-gray-400 text-sm mt-1">
          All orders are encrypted. You see the asset pair and direction — not the price or size.
          Request the AES key from the maker to see order details before filling.
        </p>
      </div>

      {/* Privacy banner */}
      <div className="bg-purple-950/20 border border-purple-900/50 rounded-xl px-5 py-3 flex items-center gap-3">
        <span className="text-purple-400 text-lg">🔒</span>
        <p className="text-sm text-purple-300">
          Prices and amounts are hidden from you — and from every other observer including the relayer.
          After expressing interest, you complete a key exchange with the maker off-chain to decrypt order details.
        </p>
      </div>

      {/* Filters */}
      <div className="flex gap-3 flex-wrap">
        <div className="flex gap-1">
          {["all", "BTC/USDC", "ETH/USDC", "BTC/ETH"].map((p) => (
            <button
              key={p}
              onClick={() => setFilterPair(p)}
              className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
                filterPair === p
                  ? "border-purple-600 bg-purple-900/30 text-purple-300"
                  : "border-gray-700 text-gray-500 hover:border-gray-600 hover:text-gray-300"
              }`}
            >
              {p === "all" ? "All Pairs" : p}
            </button>
          ))}
        </div>
        <div className="flex gap-1">
          {[["all", "All"], ["buy", "🟢 Buy"], ["sell", "🔴 Sell"]].map(([val, label]) => (
            <button
              key={val}
              onClick={() => setFilterDir(val as "all" | "buy" | "sell")}
              className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
                filterDir === val
                  ? "border-purple-600 bg-purple-900/30 text-purple-300"
                  : "border-gray-700 text-gray-500 hover:border-gray-600 hover:text-gray-300"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-5 gap-6">
        {/* Order list */}
        <div className="lg:col-span-3 space-y-3">
          {filteredOrders.length === 0 && (
            <div className="text-center text-gray-600 py-12">No open orders match your filters</div>
          )}
          {filteredOrders.map((order) => (
            <div
              key={order.id}
              onClick={() => selectOrder(order)}
              className={`bg-gray-900 border rounded-xl p-5 cursor-pointer transition-all ${
                selected?.order.id === order.id
                  ? "border-purple-600 glow-purple"
                  : "border-gray-800 hover:border-gray-700"
              }`}
            >
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <span className={`text-xs font-bold px-2 py-1 rounded ${
                    order.directionBit === 0
                      ? "bg-green-900/40 text-green-400 border border-green-800"
                      : "bg-red-900/40 text-red-400 border border-red-800"
                  }`}>
                    {order.directionBit === 0 ? "BUY" : "SELL"}
                  </span>
                  <span className="text-white font-medium">{order.assetPair}</span>
                </div>
                <div className="flex items-center gap-2 text-xs text-gray-500">
                  <span>Expires in {timeLeft(order.expiry)}</span>
                  <span className="text-green-400 bg-green-900/20 px-2 py-0.5 rounded border border-green-900/50">
                    open
                  </span>
                </div>
              </div>

              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-gray-500">Price</span>
                  <span className="text-gray-600 font-mono encrypted-shimmer">
                    [encrypted — request key to reveal]
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-gray-500">Amount</span>
                  <span className="text-gray-600 font-mono encrypted-shimmer">
                    [encrypted — request key to reveal]
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-gray-500">Commitment</span>
                  <span className="text-gray-500 font-mono hash">
                    {order.commitment.slice(0, 20)}...
                  </span>
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-gray-500">Maker</span>
                  <span className="text-gray-500 font-mono">
                    {order.makerAddress.slice(0, 10)}...
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>

        {/* Settlement panel */}
        <div className="lg:col-span-2">
          {!selected ? (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 text-center text-gray-600 text-sm">
              Select an order to fill
            </div>
          ) : selected.step === "idle" ? (
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-5">
              <h3 className="text-white font-semibold">Fill Order</h3>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500">Pair</span>
                  <span className="text-white">{selected.order.assetPair}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Direction</span>
                  <span className={selected.order.directionBit === 0 ? "text-green-400" : "text-red-400"}>
                    {selected.order.directionBit === 0 ? "BUY" : "SELL"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Price</span>
                  <span className="text-gray-600 encrypted-shimmer">Hidden</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Amount</span>
                  <span className="text-gray-600 encrypted-shimmer">Hidden</span>
                </div>
              </div>
              <div className="bg-gray-950 rounded-lg p-3 text-xs text-gray-500 space-y-1">
                <p>1. You signal interest → maker gets your ECDH public key</p>
                <p>2. Maker encrypts AES key to your pubkey → sends via relayer</p>
                <p>3. You decrypt the order, verify price/amount</p>
                <p>4. Submit revealAndMatch → Zswap atomic settlement</p>
              </div>
              <div className="text-xs text-gray-500">
                Your credential: <span className="text-green-400">✓ KYC Verified (mock)</span>
              </div>
              <button
                onClick={startFill}
                className="w-full bg-purple-600 hover:bg-purple-500 text-white py-3 rounded-xl font-semibold transition-colors"
              >
                Express Interest &amp; Fill
              </button>
            </div>
          ) : selected.step === "requesting-key" ? (
            <SettlementStep
              title="Requesting AES Key..."
              detail={
                USE_MOCK
                  ? "Signaling interest to maker via relayer. Maker will encrypt the order's AES key to your ECDH public key."
                  : "Waiting for maker to respond with encrypted AES key (up to 30s)..."
              }
              progress={25}
              color="blue"
            />
          ) : selected.step === "decrypting" ? (
            <SettlementStep
              title="Decrypting Order..."
              detail="Deriving shared secret via ECDH. Decrypting order parameters with AES-256-GCM."
              progress={60}
              color="purple"
            >
              {selected.revealedPrice !== undefined && (
                <div className="bg-green-950/20 border border-green-900/40 rounded-lg p-3 text-sm space-y-1">
                  <div className="flex justify-between">
                    <span className="text-gray-500">Revealed Price</span>
                    <span className="text-green-400 font-mono">
                      {selected.revealedPrice?.toLocaleString()} {selected.order.assetPair.split("/")[1]}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Revealed Amount</span>
                    <span className="text-green-400 font-mono">
                      {selected.revealedAmount?.toFixed(4)} {selected.order.assetPair.split("/")[0]}
                    </span>
                  </div>
                </div>
              )}
            </SettlementStep>
          ) : selected.step === "settling" ? (
            <SettlementStep
              title="Atomic Settlement..."
              detail="Submitting revealAndMatch to Midnight. Verifying credential proof and commitment integrity. Zswap executing..."
              progress={85}
              color="yellow"
            />
          ) : selected.step === "done" ? (
            <div className="bg-gray-900 border border-green-900/50 rounded-xl p-6 space-y-4">
              <div className="flex items-center gap-2 text-green-400 font-semibold">
                <span>✓</span> Settlement Complete
              </div>
              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500">Price</span>
                  <span className="text-white font-mono">
                    {selected.revealedPrice?.toLocaleString()} {selected.order.assetPair.split("/")[1]}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">Amount</span>
                  <span className="text-white font-mono">
                    {selected.revealedAmount?.toFixed(4)} {selected.order.assetPair.split("/")[0]}
                  </span>
                </div>
              </div>
              <div className="bg-gray-950 rounded-lg p-3 text-xs">
                <div className="text-gray-500 mb-1">Tx Hash (on-chain — no trade details visible)</div>
                <div className="text-green-400 font-mono break-all">
                  {selected.result?.txHash}
                </div>
              </div>
              <p className="text-xs text-gray-500">
                Settlement is atomic via Zswap. No observer can determine the price or size from on-chain data.
              </p>
              <button
                onClick={() => setSelected(null)}
                className="w-full border border-gray-700 text-gray-300 py-2.5 rounded-xl text-sm"
              >
                Close
              </button>
            </div>
          ) : (
            <div className="bg-gray-900 border border-red-900/50 rounded-xl p-6 space-y-4">
              <div className="text-red-400 font-semibold">Settlement Failed</div>
              <div className="text-gray-400 text-sm">{selected.error}</div>
              <button
                onClick={() => setSelected((s) => s ? { ...s, step: "idle" } : s)}
                className="w-full border border-gray-700 text-gray-300 py-2.5 rounded-xl text-sm"
              >
                Try Again
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SettlementStep({
  title,
  detail,
  progress,
  color,
  children,
}: {
  title: string;
  detail: string;
  progress: number;
  color: "blue" | "purple" | "yellow";
  children?: React.ReactNode;
}) {
  const colorClass = {
    blue: "bg-blue-600",
    purple: "bg-purple-600",
    yellow: "bg-yellow-500",
  }[color];

  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 space-y-4">
      <div className="flex items-center gap-3">
        <div className={`w-3 h-3 rounded-full ${colorClass} animate-pulse`} />
        <span className="text-white font-medium">{title}</span>
      </div>
      <div className="w-full bg-gray-800 rounded-full h-1.5">
        <div
          className={`h-1.5 rounded-full ${colorClass} transition-all duration-500`}
          style={{ width: `${progress}%` }}
        />
      </div>
      <p className="text-gray-400 text-sm">{detail}</p>
      {children}
    </div>
  );
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}
