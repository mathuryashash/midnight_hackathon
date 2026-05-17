# Relayer API Reference

## WebSocket Protocol

### Connection

```
ws://host:3001
wss://host:3001  (if TLS configured)
```

Optional: `Authorization: Bearer <api_key>` header on upgrade (if `AUTH_ENABLED=true`).

### Server → Client Messages

| Type | Payload | Description |
|------|---------|-------------|
| `orderbook:snapshot` | `RelayerOrderEntry[]` | Full order book on connect |
| `order:new` | `RelayerOrderEntry` | New order submitted |
| `order:cancelled` | `{ id: string }` | Order cancelled |
| `order:filled` | `{ id: string }` | Order filled |
| `match:signal` | `MatchSignal` | Potential match found |
| `order:key:received` | `{ orderId, encryptedAesKey }` | AES key forwarded |
| `error` | `{ code, message }` | Error (see codes below) |

### Client → Server Messages

| Type | Payload | Description |
|------|---------|-------------|
| `order:submit` | `EncryptedOrder` | Submit a new order |
| `order:key` | `{ orderId, encryptedAesKey }` | Send encrypted AES key |
| `match:interest` | `{ orderId, takerPublicKey }` | Express interest in order |
| `ping` | — | Liveness check (responds with `error` code `PONG`) |

## Error Codes

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| `PARSE_ERROR` | 400 | Invalid JSON or message format |
| `INVALID_ORDER` | 400 | Order validation failed or bad signature |
| `BOOK_FULL` | 429 | Order book at capacity |
| `DUPLICATE` | 409 | Commitment hash already exists |
| `QUOTA_EXCEEDED` | 429 | Peer has too many active orders |
| `RATE_LIMITED` | 429 | Too many messages (token bucket empty) |
| `AUTH_REQUIRED` | 401 | Missing or invalid API key |
| `ORDER_NOT_FOUND` | 404 | Order ID not in book |
| `UNKNOWN_MSG` | 400 | Unrecognized message type |
| `INTERNAL_ERROR` | 500 | Unexpected server error |

## REST Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | No | Server status + metrics |
| GET | `/orders` | No | Order book snapshot |
| POST | `/orders` | Yes* | Submit order (REST fallback) |

*Requires auth if `AUTH_ENABLED=true`.

### POST /orders

```json
{
  "commitment": "sha256 hex (64 chars)",
  "ciphertext": "aes-gcm ciphertext hex",
  "iv": "12-byte IV hex (24 chars)",
  "authTag": "16-byte tag hex (32 chars)",
  "salt": "32-byte salt hex (64 chars)",
  "assetPair": "BTC/USDC",
  "directionBit": 0,
  "expiry": 1716000000,
  "makerAddress": "0x...",
  "makerPublicKey": "uncompressed P-256 pubkey hex (130 chars)",
  "signature": "ECDSA/P-256 signature hex"
}
```

### GET /health

```json
{
  "status": "ok",
  "orders": 42,
  "totalOrders": 50,
  "peers": 7,
  "uptime": 1234.56,
  "tls": false,
  "auth": false
}
```

## Identifier Truncation

Order IDs and commitment hashes are UUIDv4 / SHA-256 hex strings (64 chars). UI displays should truncate to `first 8 chars...` (e.g., `a1b2c3d4...`).

## Rate Limiting

Token-bucket algorithm:
- **Capacity**: max burst (default 120 messages)
- **Refill**: tokens per second (default 60/sec)
- Buckets are per-peer (by connection UUID)
- Exceeded peers are disconnected

## Environment Variables

See `.env.example` for all configuration options.
