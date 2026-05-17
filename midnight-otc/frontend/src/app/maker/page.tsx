"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import {
  encryptOrder,
  buildEncryptedOrder,
  generateECDHKeyPair,
  generateNonce,
  encryptKeyForTaker,
  importPeerPublicKey,
} from "../../lib/crypto";
import { commitOrder } from "../../lib/contract";
import { relayerClient } from "../../lib/relayer";
import type { PlaintextOrder, AssetPair } from "../../../../shared/types";

const USE_MOCK = process.env.NEXT_PUBLIC_USE_MOCK === "true";

type Step =
  | "form"
  | "encrypting"
  | "committing"
  | "waiting-for-match"
  | "key-sent"
  | "done"
  | "error";

const ASSET_PAIRS: AssetPair[] = ["BTC/USDC", "ETH/USDC", "BTC/ETH", "DUST/USDC"];
const TOKEN_MAP: Record<string, { in: string; out: string }> = {
  "BTC/USDC-buy":  { in: "USDC", out: "BTC"  },
  "BTC/USDC-sell": { in: "BTC",  out: "USDC" },
  "ETH/USDC-buy":  { in: "USDC", out: "ETH"  },
  "ETH/USDC-sell": { in: "ETH",  out: "USDC" },
  "BTC/ETH-buy":   { in: "ETH",  out: "BTC"  },
  "BTC/ETH-sell":  { in: "BTC",  out: "ETH"  },
  "DUST/USDC-buy": { in: "USDC", out: "DUST" },
  "DUST/USDC-sell":{ in: "DUST", out: "USDC" },
};

const MOCK_ADDRESS = "0xMockMaker1234567890abcdef";

export default function MakerPage() {
  const [step, setStep] = useState<Step>("form");

  // Form state
  const [pair, setPair] = useState<AssetPair>("BTC/USDC");
  const [side, setSide] = useState<"buy" | "sell">("sell");
  const [price, setPrice] = useState("");
  const [amount, setAmount] = useState("");
  const [expiryHours, setExpiryHours] = useState("24");
  const [restrictTaker, setRestrictTaker] = useState("");

  // Result state
  const [commitment, setCommitment] = useState("");
  const [orderKey, setOrderKey] = useState("");
  const [ciphertextPreview, setCiphertextPreview] = useState("");
  const [publicKey, setPublicKey] = useState("");
  const [error, setError] = useState("");
  const [matchedTakerHint, setMatchedTakerHint] = useState("");

  // Refs hold ECDH material and order ID across async events without causing re-renders
  const aesKeyRef = useRef<CryptoKey | null>(null);
  const makerPrivKeyRef = useRef<CryptoKey | null>(null);
  const orderIdRef = useRef<string>("");   // Assigned by relayer after submit
  const commitmentRef = useRef<string>(""); // Used to identify our order in order:new broadcasts

  // Subscribe to relayer events for the waiting-for-match flow
  useEffect(() => {
    if (step !== "waiting-for-match") return;

    relayerClient.connect();

    const unsub = relayerClient.subscribe(async (event) => {
      if (event.event === "order:new" && !orderIdRef.current) {
        // Identify our order by commitment once the relayer assigns it an ID
        if (event.order.commitment === commitmentRef.current) {
          orderIdRef.current = event.order.id;
        }
      }

      if (event.event === "match:signal") {
        const signal = event.signal;
        // Only act on signals for our order
        if (signal.makerOrderId !== orderIdRef.current) return;
        // Signals from the periodic scanner won't have takerPublicKey — skip those
        if (!signal.takerPublicKey) return;

        const makerPrivKey = makerPrivKeyRef.current;
        const aesKey = aesKeyRef.current;
        if (!makerPrivKey || !aesKey) return;

        try {
          const takerPubKey = await importPeerPublicKey(signal.takerPublicKey);
          const encryptedAesKey = await encryptKeyForTaker(aesKey, makerPrivKey, takerPubKey);
          relayerClient.updateOrderWithKey(orderIdRef.current, encryptedAesKey);

          setMatchedTakerHint(signal.takerConnectionId ?? signal.takerOrderId);
          setStep("key-sent");
        } catch (err) {
          console.error("[Maker] Key encryption failed:", err);
        }
      }
    });

    return unsub;
  }, [step]);

  const handleSubmit = useCallback(async () => {
    const priceNum = parseFloat(price);
    const amountNum = parseFloat(amount);

    if (!priceNum || !amountNum || priceNum <= 0 || amountNum <= 0) {
      setError("Price and amount must be positive numbers");
      setStep("error");
      return;
    }

    setStep("encrypting");
    setError("");

    try {
      // 1. Generate ECDH key pair for this order
      const keyPair = await generateECDHKeyPair();
      setPublicKey(keyPair.publicKeyHex.slice(0, 16) + "...");

      // Persist private key for the match signal handler (never leaves the browser)
      makerPrivKeyRef.current = keyPair.privateKey;

      // 2. Build the plaintext order (this NEVER leaves the browser unencrypted)
      const order: PlaintextOrder = {
        price: priceNum,
        amount: amountNum,
        side,
        assetPair: pair,
        expiry: Math.floor(Date.now() / 1000) + parseInt(expiryHours) * 3600,
        nonce: generateNonce(),
        makerAllowlist: restrictTaker ? [restrictTaker] : undefined,
      };

      // 3. Encrypt the order client-side
      const encResult = await encryptOrder(order);
      setCiphertextPreview(encResult.ciphertext.slice(0, 32) + "...[encrypted]");
      setCommitment(encResult.commitment);
      commitmentRef.current = encResult.commitment;

      // Persist AES key — shared with the taker after match (never sent to relayer)
      aesKeyRef.current = encResult.aesKey;

      setStep("committing");

      // 4. Build encrypted order struct (no AES key included)
      const encryptedOrder = buildEncryptedOrder(
        encResult,
        order,
        MOCK_ADDRESS,
        keyPair.publicKeyHex
      );

      // 5. Post commitment to chain (or mock)
      const tokens = TOKEN_MAP[`${pair}-${side}`];
      const key = await commitOrder({
        ciphertextHash: encResult.commitment,
        deadline: order.expiry,
        tokenIn: tokens.in,
        tokenOut: tokens.out,
        escrowedAmount: BigInt(Math.floor(amountNum * 1_000_000)),
        directionBit: side === "buy" ? 0 : 1,
        feeDeposit: BigInt(1_000),
        makerAddress: MOCK_ADDRESS,
      });

      setOrderKey(key);

      if (USE_MOCK) {
        // In mock mode there's no relayer, so go straight to done
        setStep("done");
      } else {
        // In real mode: submit to relayer and wait for a taker to express interest
        relayerClient.connect();
        relayerClient.submitOrder(encryptedOrder);
        setStep("waiting-for-match");
      }

    } catch (err) {
      setError((err as Error).message);
      setStep("error");
    }
  }, [pair, side, price, amount, expiryHours, restrictTaker]);

  const reset = () => {
    setStep("form");
    setCommitment("");
    setOrderKey("");
    setCiphertextPreview("");
    setError("");
    setPrice("");
    setAmount("");
    setMatchedTakerHint("");
    aesKeyRef.current = null;
    makerPrivKeyRef.current = null;
    orderIdRef.current = "";
    commitmentRef.current = "";
  };

  return (
    <div className="max-w-2xl space-y-8">
      <div>
        <h1 className="text-2xl font-bold text-white">Create Encrypted Order</h1>
        <p className="text-gray-400 text-sm mt-1">
          Your price and amount are encrypted before leaving this page.
          Only a hash commitment is posted on-chain.
        </p>
      </div>

      {step === "form" && (
        <form
          onSubmit={(e) => { e.preventDefault(); handleSubmit(); }}
          className="space-y-6"
        >
          {/* Asset Pair */}
          <div>
            <label className="block text-sm text-gray-400 mb-2">Asset Pair</label>
            <div className="grid grid-cols-4 gap-2">
              {ASSET_PAIRS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setPair(p)}
                  className={`py-2 px-3 rounded-lg border text-sm font-medium transition-colors ${
                    pair === p
                      ? "border-purple-600 bg-purple-900/30 text-purple-300"
                      : "border-gray-700 text-gray-400 hover:border-gray-600"
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          {/* Side */}
          <div>
            <label className="block text-sm text-gray-400 mb-2">Direction</label>
            <div className="grid grid-cols-2 gap-2">
              {(["buy", "sell"] as const).map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSide(s)}
                  className={`py-2.5 rounded-lg border text-sm font-semibold transition-colors ${
                    side === s
                      ? s === "buy"
                        ? "border-green-600 bg-green-900/30 text-green-300"
                        : "border-red-600 bg-red-900/30 text-red-300"
                      : "border-gray-700 text-gray-400 hover:border-gray-600"
                  }`}
                >
                  {s === "buy" ? "🟢 BUY" : "🔴 SELL"}
                </button>
              ))}
            </div>
            <p className="text-xs text-gray-600 mt-1">
              Direction bit is public (lets relayer match buy↔sell).
              Price and size remain encrypted.
            </p>
          </div>

          {/* Price */}
          <div>
            <label className="block text-sm text-gray-400 mb-2">
              Limit Price <span className="text-gray-600">(encrypted)</span>
            </label>
            <div className="relative">
              <input
                type="number"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder={pair === "BTC/USDC" ? "42000" : "2500"}
                step="any"
                min="0"
                required
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-3 text-white placeholder-gray-600 focus:outline-none focus:border-purple-600 pr-20"
              />
              <span className="absolute right-3 top-3 text-gray-500 text-sm">
                {pair.split("/")[1]}
              </span>
            </div>
          </div>

          {/* Amount */}
          <div>
            <label className="block text-sm text-gray-400 mb-2">
              Amount <span className="text-gray-600">(encrypted)</span>
            </label>
            <div className="relative">
              <input
                type="number"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="1.5"
                step="any"
                min="0"
                required
                className="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-3 text-white placeholder-gray-600 focus:outline-none focus:border-purple-600 pr-20"
              />
              <span className="absolute right-3 top-3 text-gray-500 text-sm">
                {pair.split("/")[0]}
              </span>
            </div>
          </div>

          {/* Expiry */}
          <div>
            <label className="block text-sm text-gray-400 mb-2">Order Expiry</label>
            <div className="grid grid-cols-4 gap-2">
              {[["1", "1h"], ["4", "4h"], ["24", "24h"], ["168", "7d"]].map(([val, label]) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => setExpiryHours(val)}
                  className={`py-2 rounded-lg border text-sm transition-colors ${
                    expiryHours === val
                      ? "border-purple-600 bg-purple-900/30 text-purple-300"
                      : "border-gray-700 text-gray-400 hover:border-gray-600"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Optional: restrict to specific taker */}
          <div>
            <label className="block text-sm text-gray-400 mb-2">
              Restrict to Taker <span className="text-gray-600">(optional — encrypted in order)</span>
            </label>
            <input
              type="text"
              value={restrictTaker}
              onChange={(e) => setRestrictTaker(e.target.value)}
              placeholder="0x... (leave blank for any verified taker)"
              className="w-full bg-gray-900 border border-gray-700 rounded-lg px-4 py-3 text-white placeholder-gray-600 focus:outline-none focus:border-purple-600 font-mono text-sm"
            />
          </div>

          {/* Privacy note */}
          <div className="bg-purple-950/20 border border-purple-900/50 rounded-xl p-4">
            <p className="text-purple-300 text-xs leading-relaxed">
              <strong>What gets encrypted:</strong> Price, amount, direction details, maker allowlist
              <br />
              <strong>What stays public:</strong> Asset pair, direction bit (buy/sell), expiry, commitment hash
              <br />
              <strong>Escrow:</strong> Your tokens are locked on-chain to prove solvency — without revealing the amount
            </p>
          </div>

          <button
            type="submit"
            className="w-full bg-purple-600 hover:bg-purple-500 text-white py-3 rounded-xl font-semibold transition-colors"
          >
            Encrypt &amp; Commit Order
          </button>
        </form>
      )}

      {/* Encrypting state */}
      {step === "encrypting" && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center space-y-4">
          <div className="w-12 h-12 border-2 border-purple-600 border-t-transparent rounded-full animate-spin mx-auto" />
          <div className="text-white font-medium">Encrypting order parameters...</div>
          <div className="text-gray-500 text-sm">
            Generating ECDH key pair → AES-256-GCM encryption → SHA-256 commitment
          </div>
          <div className="bg-gray-950 rounded-lg p-3 font-mono text-xs text-gray-500 text-left space-y-1">
            <div>{"[1/3] Generating ephemeral ECDH keypair (P-256)..."}</div>
            <div>{"[2/3] Encrypting {price, amount, side} with AES-256-GCM..."}</div>
            <div className="text-purple-400">{"[3/3] Computing commitment = SHA-256(ciphertext ++ IV ++ authTag ++ salt)"}</div>
          </div>
        </div>
      )}

      {/* Committing state */}
      {step === "committing" && (
        <div className="bg-gray-900 border border-gray-800 rounded-xl p-8 text-center space-y-4">
          <div className="w-12 h-12 border-2 border-blue-600 border-t-transparent rounded-full animate-spin mx-auto" />
          <div className="text-white font-medium">Posting commitment to Midnight...</div>
          <div className="bg-gray-950 rounded-lg p-3 font-mono text-xs text-left space-y-1">
            <div className="text-gray-500">commitment: <span className="text-purple-400">{commitment.slice(0, 24)}...</span></div>
            <div className="text-gray-500">ciphertext: <span className="text-gray-600 encrypted-shimmer">{ciphertextPreview}</span></div>
            <div className="text-gray-500">ECDH pubkey: <span className="text-blue-400">{publicKey}</span></div>
          </div>
          <p className="text-gray-500 text-xs">
            Tokens being escrowed → No price visible on-chain
          </p>
        </div>
      )}

      {/* Waiting for match state (real mode only) */}
      {step === "waiting-for-match" && (
        <div className="space-y-6">
          <div className="bg-blue-950/20 border border-blue-900/50 rounded-xl p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-3 h-3 bg-blue-400 rounded-full animate-pulse" />
              <span className="text-blue-400 font-semibold">Order live — waiting for taker</span>
            </div>
            <div className="space-y-3 font-mono text-sm">
              <div>
                <div className="text-gray-500 text-xs mb-1">Order Key (on-chain ID)</div>
                <div className="text-white break-all bg-gray-950 rounded p-2">{orderKey}</div>
              </div>
              <div>
                <div className="text-gray-500 text-xs mb-1">Commitment Hash (visible to all)</div>
                <div className="text-purple-400 break-all bg-gray-950 rounded p-2">{commitment}</div>
              </div>
            </div>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <p className="text-gray-400 text-sm">
              Your order is now visible in the order book. When a taker signals interest,
              you&apos;ll automatically encrypt your AES key to their ECDH public key and send it.
              This happens without any further action from you.
            </p>
          </div>

          <button
            onClick={reset}
            className="w-full border border-gray-700 hover:border-gray-600 text-gray-300 py-3 rounded-xl font-medium transition-colors"
          >
            Cancel &amp; Create New Order
          </button>
        </div>
      )}

      {/* Key sent state (real mode — taker matched) */}
      {step === "key-sent" && (
        <div className="space-y-6">
          <div className="bg-green-950/20 border border-green-900/50 rounded-xl p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-2 h-2 bg-green-400 rounded-full" />
              <span className="text-green-400 font-semibold">Taker matched — AES key sent</span>
            </div>
            <p className="text-gray-400 text-sm">
              A taker expressed interest. Your order&apos;s AES key has been encrypted to their
              ECDH public key and forwarded via the relayer. They can now decrypt the order and
              submit revealAndMatch for atomic Zswap settlement.
            </p>
            {matchedTakerHint && (
              <div className="mt-3">
                <div className="text-gray-500 text-xs mb-1">Taker connection</div>
                <div className="text-blue-400 font-mono text-xs break-all bg-gray-950 rounded p-2">
                  {matchedTakerHint.slice(0, 16)}...
                </div>
              </div>
            )}
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <h3 className="text-white font-medium mb-3">What happens next</h3>
            <ol className="space-y-2 text-sm text-gray-400">
              <li className="flex gap-2">
                <span className="text-purple-400">1.</span>
                Taker decrypts the order using your AES key
              </li>
              <li className="flex gap-2">
                <span className="text-purple-400">2.</span>
                They verify price and amount match their expectations
              </li>
              <li className="flex gap-2">
                <span className="text-purple-400">3.</span>
                Taker submits revealAndMatch on-chain → Zswap atomic settlement
              </li>
              <li className="flex gap-2">
                <span className="text-purple-400">4.</span>
                Both legs settle atomically — no counterparty risk
              </li>
            </ol>
          </div>

          <button
            onClick={reset}
            className="w-full border border-gray-700 hover:border-gray-600 text-gray-300 py-3 rounded-xl font-medium transition-colors"
          >
            Create Another Order
          </button>
        </div>
      )}

      {/* Done state (mock mode) */}
      {step === "done" && (
        <div className="space-y-6">
          <div className="bg-green-950/20 border border-green-900/50 rounded-xl p-6">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-2 h-2 bg-green-400 rounded-full" />
              <span className="text-green-400 font-semibold">Order committed on-chain</span>
            </div>
            <div className="space-y-3 font-mono text-sm">
              <div>
                <div className="text-gray-500 text-xs mb-1">Order Key (on-chain ID)</div>
                <div className="text-white break-all bg-gray-950 rounded p-2">{orderKey}</div>
              </div>
              <div>
                <div className="text-gray-500 text-xs mb-1">Commitment Hash (visible to all)</div>
                <div className="text-purple-400 break-all bg-gray-950 rounded p-2">{commitment}</div>
              </div>
              <div>
                <div className="text-gray-500 text-xs mb-1">Encrypted Order (observer sees this)</div>
                <div className="text-gray-600 break-all bg-gray-950 rounded p-2 encrypted-shimmer">
                  {ciphertextPreview}
                </div>
              </div>
            </div>
          </div>

          <div className="bg-gray-900 border border-gray-800 rounded-xl p-5">
            <h3 className="text-white font-medium mb-3">Next Steps</h3>
            <ol className="space-y-2 text-sm text-gray-400">
              <li className="flex gap-2">
                <span className="text-purple-400">1.</span>
                Your order is now visible in the order book — direction bit only, no price
              </li>
              <li className="flex gap-2">
                <span className="text-purple-400">2.</span>
                When a taker signals interest, you&apos;ll receive their ECDH public key
              </li>
              <li className="flex gap-2">
                <span className="text-purple-400">3.</span>
                You encrypt your AES key to their public key and send it
              </li>
              <li className="flex gap-2">
                <span className="text-purple-400">4.</span>
                Taker decrypts your order, agrees on price, submits revealAndMatch
              </li>
              <li className="flex gap-2">
                <span className="text-purple-400">5.</span>
                Zswap atomically settles both legs — no counterparty risk
              </li>
            </ol>
          </div>

          <button
            onClick={reset}
            className="w-full border border-gray-700 hover:border-gray-600 text-gray-300 py-3 rounded-xl font-medium transition-colors"
          >
            Create Another Order
          </button>
        </div>
      )}

      {/* Error state */}
      {step === "error" && (
        <div className="space-y-4">
          <div className="bg-red-950/20 border border-red-900/50 rounded-xl p-5">
            <div className="text-red-400 font-medium mb-1">Error</div>
            <div className="text-gray-400 text-sm">{error}</div>
          </div>
          <button
            onClick={reset}
            className="w-full border border-gray-700 text-gray-300 py-3 rounded-xl font-medium"
          >
            Try Again
          </button>
        </div>
      )}
    </div>
  );
}
