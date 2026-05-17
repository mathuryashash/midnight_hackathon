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
npm run dev
```

Open http://localhost:3000 — full demo runs in-browser with mock contract.

### Option B: Local Midnight Node

```bash
# Start Midnight local network
docker-compose up midnight-node midnight-proof-server postgres midnight-indexer

# Deploy contract
npm run deploy:local

# Update .env
echo "NEXT_PUBLIC_USE_MOCK=false" >> .env

# Start app + relayer
npm run dev
```

### Option C: Midnight Testnet

```bash
# Get Lace wallet with Midnight support: https://lacewallet.io
# Fund your wallet with testnet DUST from the faucet
# Update .env:
# MIDNIGHT_NODE_URL=wss://rpc.testnet.midnight.network
# NEXT_PUBLIC_USE_MOCK=false

npm run deploy:testnet
npm run dev
```

---

## Project Structure

```
midnight-otc/
├── contracts/
│   └── src/
│       └── otc.compact          # Midnight Compact smart contract
│           ├── commitOrder()    # Post encrypted order + escrow
│           ├── revealAndMatch() # Atomic settlement via Zswap
│           └── cancelOrder()    # Recover escrowed funds
├── frontend/
│   └── src/
│       ├── app/
│       │   ├── page.tsx         # Dashboard — architecture + live stream
│       │   ├── maker/page.tsx   # Create encrypted order UI
│       │   └── taker/page.tsx   # Browse + fill orders UI
│       └── lib/
│           ├── crypto.ts        # AES-256-GCM + ECDH key exchange
│           ├── contract.ts      # Contract client (mock + Midnight)
│           └── relayer.ts       # WebSocket relayer client + React hook
├── relayer/
│   └── src/
│       ├── index.ts             # Express + WS server
│       ├── orderbook.ts         # In-memory order book (no decryption)
│       └── matcher.ts           # Direction-bit matching engine
├── shared/
│   └── types.ts                 # TypeScript types across all packages
├── test/
│   ├── crypto.test.ts           # Encryption unit tests
│   ├── integration.test.ts      # 10 end-to-end contract flow tests
│   └── relayer.test.ts          # Order book + matcher tests
├── docker-compose.yml           # Full Midnight local stack
└── scripts/
    └── setup.sh
```

---

## Running Tests

```bash
npm test
```

Covers:
- ✅ Basic commit → reveal → settlement flow
- ✅ Deadline protection
- ✅ Insufficient balance rejection
- ✅ Tampered ciphertext rejection
- ✅ Double-fill prevention
- ✅ Only maker can cancel
- ✅ Replay attack prevention (nonce)
- ✅ Expired deadline enforcement
- ✅ Relayer cannot see price (documented test)
- ✅ Matcher dedup (no duplicate signals)

---

## Adversary Model

| Adversary | Capability | Protocol Response |
|-----------|-----------|-------------------|
| MEV / Front-runner | Monitor mempool | Sees commitment hash only — cannot act on encrypted params |
| Malicious relayer | Control order propagation | Can delay/censor; cannot decrypt; maker/taker can submit directly to chain |
| On-chain observer | Read all transactions | Sees ZK proofs and hashes only, never plaintext |
| Compromised KYC issuer | Issue fraudulent credentials | 2-of-3 threshold: one bad issuer cannot unilaterally approve |

---


## License

MIT
