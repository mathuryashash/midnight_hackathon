# MidnightOTC — Encrypted Block Trading

Privacy-preserving OTC settlement with encrypted limit orders and zero counterparty risk.

Built on [Midnight](https://midnight.network) using AES-256-GCM client-side encryption, ECDH key exchange, and Zswap atomic settlement.

---

## Problem

OTC block trading today forces a choice between trust and privacy:

- **Centralized OTC desks**: Operator sees your price, size, and identity. Settlement takes days. You trust them not to front-run you.
- **Public on-chain DEXs**: Every order is visible in the mempool. MEV bots sandwich your trades before execution.

HumidiFi processed **$34B in dark pool volume in a single month** — institutional demand for privacy-preserving venues is proven. The missing piece is atomic settlement without a trusted intermediary.

---

## Solution

Encrypted limit orders on Midnight's privacy-preserving blockchain:

1. **Maker** encrypts `{price, amount, side}` with AES-256-GCM locally
2. Only a SHA-256 **commitment hash** is posted on-chain — observers see nothing
3. **Relayer** matches buy↔sell orders using a public **direction bit** only
4. **Taker** receives the AES key via ECDH-encrypted channel, verifies order details offline
5. `revealAndMatch` triggers **Zswap atomic settlement** — both legs settle or neither does

No single party sees the complete picture. No trusted intermediary required.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────┐
│  MAKER (browser)                                 │
│  AES-256-GCM encrypt({price, amount, side})      │
│  → commitment = SHA-256(ciphertext ‖ IV ‖ salt) │
│  → post commitment + escrow on-chain             │
└────────────────────┬────────────────────────────┘
                     │ encrypted order (ciphertext only)
                     ▼
┌─────────────────────────────────────────────────┐
│  RELAYER (off-chain)                             │
│  Sees: assetPair, directionBit, commitment       │
│  Does NOT see: price, amount, maker identity     │
│  Matches buy↔sell by direction bit only          │
└────────────────────┬────────────────────────────┘
                     │ match signal (no price)
                     ▼
┌─────────────────────────────────────────────────┐
│  TAKER (browser)                                 │
│  ECDH key exchange → decrypt order params        │
│  Verify price/amount offline                     │
│  Submit revealAndMatch transaction               │
└────────────────────┬────────────────────────────┘
                     │ commitment reveal + credential proof
                     ▼
┌─────────────────────────────────────────────────┐
│  ZSWAP CONTRACT (Midnight)                       │
│  Verify: hash(ciphertext ‖ salt) == commitment  │
│  Verify: taker has valid KYC credential          │
│  Atomic swap: maker tokens ↔ taker tokens        │
└─────────────────────────────────────────────────┘
```

---

## Key Design Improvements Over Spec

The original spec had three exploitable gaps. These are fixed:

| Gap | Problem | Fix |
|-----|---------|-----|
| **Relayer matching** | Spec said "match by opposite side" but side was encrypted | Expose `directionBit` (0/1) in commitment metadata — direction without price/size |
| **AES key handoff** | Spec never explained how taker gets the decryption key | ECDH key exchange: maker encrypts AES key to taker's P-256 public key |
| **Solvency proof** | Contract could only verify hash, not that maker actually has funds | `escrowedAmount` locked on-chain at commit time — proves solvency without revealing order size |

Additionally: commitment includes IV and authTag (`SHA-256(ciphertext ‖ IV ‖ authTag ‖ salt)`) to prevent commitment malleability attacks that the spec's simpler `SHA-256(ciphertext ‖ salt)` was vulnerable to.

---

## Privacy Guarantees

| What's Hidden | From Whom |
|--------------|-----------|
| Price | Everyone except maker + matched taker |
| Amount | Everyone except maker + matched taker |
| Full direction | Everyone (direction bit reveals buy/sell, not size) |
| Maker identity | Linked to address only, not real-world identity |
| Which orders filled | Any on-chain observer |

What's intentionally public: asset pair, direction bit, expiry, commitment hash. These are necessary for relayer operation and don't leak sensitive trading information.

---

## Cryptographic Stack

```
Client Side
├── AES-256-GCM    Encrypt {price, amount, side, allowlist}
├── ECDH (P-256)   Key exchange: maker → taker AES key transfer
└── SHA-256        Commitment hash (includes IV + authTag)

Midnight Network
├── ZK-SNARKs      Prove credential validity without identity revelation
└── Zswap          Atomic cross-asset settlement

Identity Layer
├── W3C VCs        Verifiable Credentials for KYC status
├── BBS+ Sigs      Selective disclosure ("accredited investor" without name)
└── Merkle Tree    On-chain credential commitment anchoring
```

---

## Quick Start

### Option A: Mock Mode (Demo, no setup needed)

```bash
git clone <repo>
cd midnight-otc
bash scripts/setup.sh
cp .env.example frontend/.env.local  # enables mock mode
```

Then in two terminals:

```bash
# Terminal 1 — Relayer
cd relayer && npm start

# Terminal 2 — Frontend
cd frontend && npm run dev
```

Open http://localhost:3000 — full demo runs in-browser with mock contract.

### Option B: Local Midnight Node

```bash
# Start Midnight local network
docker-compose up midnight-node midnight-proof-server postgres midnight-indexer

# Deploy contract
npm run deploy:local

# Update frontend/.env.local
echo "NEXT_PUBLIC_USE_MOCK=false" >> frontend/.env.local

# Start app + relayer
cd relayer && npm start & cd frontend && npm run dev
```

### Option C: Midnight Testnet

```bash
# Get Lace wallet with Midnight support: https://lacewallet.io
# Fund your wallet with testnet DUST from the faucet
# Update frontend/.env.local:
# NEXT_PUBLIC_USE_MOCK=false
# MIDNIGHT_NODE_URL=wss://rpc.testnet.midnight.network

npm run deploy:testnet
cd relayer && npm start & cd frontend && npm run dev
```

### Deploy to Railway

Two separate Railway services:

**Relayer service**
- Root Directory: `midnight-otc`
- Start Command: `cd relayer && npm start`

**Frontend service**
- Root Directory: `midnight-otc`
- Build Command: `cd frontend && npm install && npm run build`
- Start Command: `cd frontend && npm start`
- Environment: `NEXT_PUBLIC_USE_MOCK=true` (set in Railway dashboard)

> `NEXT_PUBLIC_` env vars are inlined at build time — set them before building on Railway.

---

## Project Structure

```
midnight-otc/
├── frontend/                    # Next.js app (Maker + Taker pages)
│   └── src/
│       ├── app/
│       │   ├── page.tsx         # Dashboard — architecture + live stream
│       │   ├── maker/page.tsx   # Create encrypted order UI
│       │   └── taker/page.tsx   # Browse + fill orders UI
│       └── lib/
│           ├── crypto.ts        # AES-256-GCM + ECDH key exchange
│           ├── contract.ts      # Contract client (mock + Midnight)
│           └── relayer.ts       # WebSocket relayer client + React hook
├── relayer/                     # WebSocket relay + order matching engine
│   └── src/
│       ├── index.ts             # Express + WS server
│       ├── orderbook.ts         # In-memory order book (no decryption)
│       └── matcher.ts           # Direction-bit matching engine
├── shared/
│   └── types.ts                 # TypeScript types across all packages
├── test/
│   ├── crypto.test.ts           # Encryption unit tests
│   ├── integration.test.ts      # E2E contract flow tests
│   ├── relayer.test.ts          # Order book + matcher tests
│   ├── relayer-ws.test.ts       # WebSocket integration tests
│   └── signature.test.ts        # Signature verification tests
├── scripts/
│   └── setup.sh
└── docker-compose.yml           # Full Midnight local stack
```

---

## Running Tests

```bash
npm test
```

Runs **63 tests** across 5 test files:

| File | Tests | Coverage |
|------|-------|----------|
| `test/crypto.test.ts` | 13 | AES-256-GCM encrypt/decrypt, commitment hash, key serialization |
| `test/integration.test.ts` | 16 | Commit → reveal → settlement, deadline, double-fill, replay, expiry |
| `test/relayer.test.ts` | 16 | Order lifecycle, direction-bit matching, dedup, rate limits |
| `test/relayer-ws.test.ts` | 16 | WebSocket publish/subscribe, connection handling, heartbeat |
| `test/signature.test.ts` | 2 | ECDSA signature creation and verification |

---

## Adversary Model

| Adversary | Capability | Protocol Response |
|-----------|-----------|-------------------|
| MEV / Front-runner | Monitor mempool | Sees commitment hash only — cannot act on encrypted params |
| Malicious relayer | Control order propagation | Can delay/censor; cannot decrypt; maker/taker can submit directly to chain |
| On-chain observer | Read all transactions | Sees ZK proofs and hashes only, never plaintext |
| Compromised KYC issuer | Issue fraudulent credentials | 2-of-3 threshold: one bad issuer cannot unilaterally approve |

---

## Hackathon Scope vs. Production

| Feature | Hackathon | Production |
|---------|-----------|------------|
| Order encryption | ✅ AES-256-GCM client-side | ✅ Same |
| Commitment scheme | ✅ SHA-256 with IV + authTag | ✅ Same + padding for length privacy |
| Relayer matching | ✅ Direction bit only | ✅ + ZK range proofs for price compatibility |
| Identity check | ⚠️ Mock (single issuer) | 🔒 W3C VCs + BBS+ + 2-of-3 threshold |
| ZK proofs | ⚠️ Simulated | 🔒 Full BLS12-381 circuits in Compact |
| Relayer network | ⚠️ Single node | 🔒 Decentralized P2P gossip |
| Audit trail | ⚠️ Not implemented | 🔒 Threshold decryption for regulators |

---

## Demo Script (~3 Minutes)

1. **Home page** (0:10) — Show the horizontal architecture flow. "Four agents: Maker encrypts locally, Relayer matches on direction only, Identity Verifier issues KYC credentials, Zswap Contract settles atomically."

2. **Maker flow** (0:30) — "Maker" page → fill BTC/USDC form → "Place Encrypted Order". "Order is AES-256-GCM encrypted in-browser. Relayer and blockchain see only a hash commitment."

3. **Taker flow** (1:10) — "Taker" page → encrypted order list (price hidden) → select order → "Express Interest & Fill". Show the settlement steps: Requesting AES Key → Decrypting (price revealed for 2s) → Atomic Settlement → Complete.

4. **Privacy summary** (2:00) — Back to home page. "No single party sees the full picture. Price is revealed only to the matched taker after key exchange. Settlement is atomic — both legs settle or neither does."

5. **Closing** (2:20) — "MidnightOTC — encrypted block trading without a trusted intermediary."

---

## License

MIT
