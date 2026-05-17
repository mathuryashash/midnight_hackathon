/**
 * OTC Relayer — off-chain order book aggregator.
 *
 * This server:
 *  - Accepts encrypted orders from makers (via WebSocket)
 *  - Maintains an order book WITHOUT decrypting any order parameters
 *  - Periodically scans for direction-compatible matches and broadcasts signals
 *  - Forwards the encrypted AES key from maker to taker after negotiation
 *
 * What the relayer CANNOT do (by design):
 *  - Read order price, size, or maker identity beyond public address
 *  - Execute trades (settlement is on-chain via Zswap)
 *  - Block settlement (maker/taker can submit directly to chain)
 */

import express from "express";
import { createServer as createHttpServer } from "http";
import { createServer as createHttpsServer } from "https";
import { readFileSync } from "fs";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "crypto";
import cors from "cors";
import { OrderBook } from "./orderbook";
import { Matcher } from "./matcher";
import { ErrorCode, type PeerConnection, type ClientMessage } from "./types";
import { validateOrderPayload, type WsMessage, type EncryptedOrder } from "../../shared/types";
import { RateLimiter } from "./rate-limiter";
import { validateClientMessage } from "./validators";
import { logger } from "./logger";
import { verifySignature } from "./signature";
import { parseAuthToken, validateApiKey } from "./auth";

// ─── Config ───────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.RELAYER_PORT ?? "3001", 10);
const HOST = process.env.RELAYER_HOST ?? "0.0.0.0";
const MATCH_INTERVAL_MS = parseInt(process.env.MATCH_INTERVAL_MS ?? "5000", 10);
const MAX_ORDERS = parseInt(process.env.MAX_ORDERS ?? "10000", 10);
const WS_MAX_PAYLOAD = parseInt(process.env.WS_MAX_PAYLOAD ?? "65536", 10);
const RATE_LIMIT_CAPACITY = parseInt(process.env.RATE_LIMIT_CAPACITY ?? "120", 10);
const RATE_LIMIT_REFILL = parseInt(process.env.RATE_LIMIT_REFILL ?? "60", 10);
const PEER_ORDER_LIMIT = parseInt(process.env.PEER_ORDER_LIMIT ?? "50", 10);
const TLS_KEY_PATH = process.env.TLS_KEY_PATH ?? "";
const TLS_CERT_PATH = process.env.TLS_CERT_PATH ?? "";
const USE_TLS = TLS_KEY_PATH.length > 0 && TLS_CERT_PATH.length > 0;
const AUTH_ENABLED = process.env.AUTH_ENABLED === "true";

// Validate required config at startup
function validateConfig(): void {
  if (isNaN(PORT) || PORT < 1 || PORT > 65535) throw new Error("RELAYER_PORT must be a valid port (1-65535)");
  if (isNaN(MAX_ORDERS) || MAX_ORDERS < 1) throw new Error("MAX_ORDERS must be a positive integer");
  if (isNaN(MATCH_INTERVAL_MS) || MATCH_INTERVAL_MS < 100) throw new Error("MATCH_INTERVAL_MS must be >= 100");
  if (isNaN(WS_MAX_PAYLOAD) || WS_MAX_PAYLOAD < 1024) throw new Error("WS_MAX_PAYLOAD must be >= 1024");
  if (isNaN(PEER_ORDER_LIMIT) || PEER_ORDER_LIMIT < 1) throw new Error("PEER_ORDER_LIMIT must be a positive integer");
  if (USE_TLS) {
    try { readFileSync(TLS_KEY_PATH); } catch { throw new Error(`Cannot read TLS key file: ${TLS_KEY_PATH}`); }
    try { readFileSync(TLS_CERT_PATH); } catch { throw new Error(`Cannot read TLS cert file: ${TLS_CERT_PATH}`); }
  }
}
validateConfig();

if (USE_TLS) logger.info({ keyPath: TLS_KEY_PATH, certPath: TLS_CERT_PATH }, "TLS enabled");
if (AUTH_ENABLED) logger.info("API key authentication enabled");

// ─── State ────────────────────────────────────────────────────────────────────

const orderBook = new OrderBook(MAX_ORDERS);
const matcher = new Matcher();
const peers = new Map<string, PeerConnection>();

// Multi-taker: tracks all takers interested per order.
// keyed by orderId → Map<peerId, takerPublicKey>
// Cleared once the encrypted key is forwarded.
const interestedTakers = new Map<string, Map<string, string>>();

const rateLimiter = new RateLimiter(RATE_LIMIT_CAPACITY, RATE_LIMIT_REFILL);

// ─── Auth Middleware ──────────────────────────────────────────────────────────

function authenticateRequest(authHeader: string | undefined): boolean {
  if (!AUTH_ENABLED) return true;
  const token = parseAuthToken(authHeader);
  return token !== null && validateApiKey(token);
}

// ─── HTTP Server ──────────────────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json({ limit: WS_MAX_PAYLOAD }));

// Health check (always public)
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    orders: orderBook.size(),
    totalOrders: orderBook.totalSize(),
    peers: peers.size,
    uptime: process.uptime(),
    tls: USE_TLS,
    auth: AUTH_ENABLED,
  });
});

// REST fallback: submit order via HTTP (for makers without WS)
app.post("/orders", (req, res) => {
  if (!authenticateRequest(req.headers.authorization)) {
    return res.status(401).json({ error: ErrorCode.AUTH_REQUIRED, message: "Authentication required" });
  }

  try {
    const order = req.body as Omit<EncryptedOrder, "encryptedAesKey">;
    validateOrderPayload(order);

    if (orderBook.size() >= MAX_ORDERS) {
      logger.warn({ peer: req.ip }, "Order rejected — book full (HTTP)");
      return res.status(429).json({ error: ErrorCode.BOOK_FULL, message: "Order book full" });
    }

    // Verify signature
    const payloadForSig = JSON.stringify({ commitment: order.commitment, ciphertext: order.ciphertext, assetPair: order.assetPair, directionBit: order.directionBit, expiry: order.expiry, makerAddress: order.makerAddress });
    if (!verifySignature(payloadForSig, order.signature, order.makerPublicKey)) {
      return res.status(400).json({ error: ErrorCode.INVALID_ORDER, message: "Invalid order signature" });
    }

    const entry = orderBook.add(order);
    broadcastToAll({ type: "order:new", payload: entry });

    res.json({ id: entry.id, commitment: entry.commitment });
  } catch (err) {
    res.status(400).json({ error: ErrorCode.INVALID_ORDER, message: (err as Error).message });
  }
});

// REST: get order book snapshot
app.get("/orders", (_req, res) => {
  res.json(orderBook.snapshot());
});

// ─── WebSocket Server ─────────────────────────────────────────────────────────

const httpServer = USE_TLS
  ? createHttpsServer({ key: readFileSync(TLS_KEY_PATH, "utf8"), cert: readFileSync(TLS_CERT_PATH, "utf8") }, app)
  : createHttpServer(app);

const wss = new WebSocketServer({
  server: httpServer,
  maxPayload: WS_MAX_PAYLOAD,
});

wss.on("connection", (ws, req) => {
  const peerId = randomUUID();

  // Authenticate on connect if auth is enabled
  if (!authenticateRequest(req.headers["authorization"])) {
    sendTo(ws, {
      type: "error",
      payload: { code: ErrorCode.AUTH_REQUIRED, message: "Authentication required" },
    });
    ws.close(4001, "Authentication required");
    return;
  }

  const peer: PeerConnection = {
    id: peerId,
    ws,
    connectedAt: Date.now(),
    orderCount: 0,
  };
  peers.set(peerId, peer);

  logger.info({ peerId, peerCount: peers.size }, "Peer connected");

  // Send current order book snapshot immediately
  const snapshot = orderBook.snapshot();
  sendTo(ws, { type: "orderbook:snapshot", payload: snapshot });

  ws.on("message", (raw) => {
    try {
      if (!rateLimiter.check(peerId)) {
        sendTo(ws, {
          type: "error",
          payload: { code: ErrorCode.RATE_LIMITED, message: "Rate limit exceeded" },
        });
        logger.warn({ peerId }, "Peer rate-limited, closing connection");
        ws.close();
        return;
      }
      const parsed = JSON.parse(raw.toString());
      const msg = validateClientMessage(parsed);
      handleClientMessage(peer, msg);
    } catch (err) {
      sendTo(ws, {
        type: "error",
        payload: { code: ErrorCode.PARSE_ERROR, message: (err as Error).message || "Invalid message" },
      });
    }
  });

  ws.on("close", () => {
    peers.delete(peerId);
    rateLimiter.cleanup(peerId);
    cleanupInterestedTakersForPeer(peerId);
    logger.info({ peerId, peerCount: peers.size }, "Peer disconnected");
  });

  ws.on("error", (err) => {
    logger.error({ peerId, err: err.message }, "Peer error");
  });
});

// ─── Message Handlers ─────────────────────────────────────────────────────────

function handleClientMessage(peer: PeerConnection, msg: ClientMessage) {
  switch (msg.type) {
    case "order:submit":
      handleOrderSubmit(peer, msg.payload as Omit<EncryptedOrder, "encryptedAesKey">);
      break;

    case "order:key":
      handleOrderKey(
        peer,
        (msg.payload as { orderId: string; encryptedAesKey: string })
      );
      break;

    case "match:interest":
      handleMatchInterest(
        peer,
        (msg.payload as { orderId: string; takerPublicKey: string })
      );
      break;

    case "ping":
      sendTo(peer.ws, { type: "error", payload: { code: ErrorCode.PONG, message: "pong" } });
      break;

    default:
      sendTo(peer.ws, {
        type: "error",
        payload: { code: ErrorCode.UNKNOWN_MSG, message: `Unknown message type: ${msg.type}` },
      });
  }
}

function handleOrderSubmit(
  peer: PeerConnection,
  order: Omit<EncryptedOrder, "encryptedAesKey">
) {
  try {
    validateOrderPayload(order);

    if (orderBook.size() >= MAX_ORDERS) {
      sendTo(peer.ws, {
        type: "error",
        payload: { code: ErrorCode.BOOK_FULL, message: "Order book is full" },
      });
      return;
    }

    // Check for duplicate commitment
    if (orderBook.getByCommitment(order.commitment)) {
      sendTo(peer.ws, {
        type: "error",
        payload: { code: ErrorCode.DUPLICATE, message: "Commitment already in order book" },
      });
      return;
    }

    // Per-peer order quota
    if (peer.orderCount >= PEER_ORDER_LIMIT) {
      sendTo(peer.ws, {
        type: "error",
        payload: { code: ErrorCode.QUOTA_EXCEEDED, message: "Order quota exceeded" },
      });
      return;
    }

    // Verify signature
    const payloadForSig = JSON.stringify({ commitment: order.commitment, ciphertext: order.ciphertext, assetPair: order.assetPair, directionBit: order.directionBit, expiry: order.expiry, makerAddress: order.makerAddress });
    if (!verifySignature(payloadForSig, order.signature, order.makerPublicKey)) {
      sendTo(peer.ws, {
        type: "error",
        payload: { code: ErrorCode.INVALID_ORDER, message: "Invalid order signature" },
      });
      logger.warn({ peerId: peer.id, commitment: order.commitment?.slice(0, 16) }, "Order rejected — invalid signature");
      return;
    }

    // Store peer address from order metadata
    peer.address = order.makerAddress;
    peer.publicKey = order.makerPublicKey;
    peer.orderCount++;

    const entry = orderBook.add(order);
    logger.info(
      { orderId: entry.id, pair: entry.assetPair, dir: entry.directionBit === 0 ? "BUY" : "SELL", peerId: peer.id },
      "Order added"
    );

    // Broadcast to all peers — they see ID and metadata, not order params
    broadcastToAll({ type: "order:new", payload: entry });
  } catch (err) {
    sendTo(peer.ws, {
      type: "error",
      payload: { code: ErrorCode.INVALID_ORDER, message: (err as Error).message },
    });
  }
}

/**
 * Maker sends the encrypted AES key to be forwarded to interested takers.
 * The relayer forwards this blob but cannot decrypt it (it's ECDH-encrypted
 * to the taker's public key, which the relayer doesn't have).
 * The key is sent ONLY to interested taker peers — never logged or broadcast.
 */
function handleOrderKey(
  _peer: PeerConnection,
  payload: { orderId: string; encryptedAesKey: string }
) {
  const interested = interestedTakers.get(payload.orderId);
  if (!interested || interested.size === 0) return;

  // Forward the encrypted key to ALL interested takers
  for (const [takerPeerId] of interested) {
    const takerPeer = peers.get(takerPeerId);
    if (takerPeer && takerPeer.ws.readyState === WebSocket.OPEN) {
      sendTo(takerPeer.ws, {
        type: "order:key:received",
        payload: { orderId: payload.orderId, encryptedAesKey: payload.encryptedAesKey },
      });
    }
  }

  interestedTakers.delete(payload.orderId);
}

/**
 * Taker expresses interest in filling an order.
 * Relayer records the taker's ECDH public key and signals the maker so they
 * can encrypt the AES key back to the taker.
 * Multiple takers can express interest in the same order (multi-taker).
 */
function handleMatchInterest(
  peer: PeerConnection,
  payload: { orderId: string; takerPublicKey: string }
) {
  peer.publicKey = payload.takerPublicKey;

  // Record the interested taker (multi-taker support)
  let takers = interestedTakers.get(payload.orderId);
  if (!takers) {
    takers = new Map();
    interestedTakers.set(payload.orderId, takers);
  }
  takers.set(peer.id, payload.takerPublicKey);

  const order = orderBook.getById(payload.orderId);
  if (!order) {
    sendTo(peer.ws, {
      type: "error",
      payload: { code: ErrorCode.ORDER_NOT_FOUND, message: `Order ${payload.orderId} not found` },
    });
    return;
  }

  // Notify the maker — include the taker's ECDH public key and connection ID
  // so the maker can encrypt the order's AES key specifically for this taker.
  const makerPeer = findPeerByAddress(order.makerAddress);
  if (makerPeer) {
    sendTo(makerPeer.ws, {
      type: "match:signal",
      payload: {
        matchId: randomUUID(),
        makerOrderId: payload.orderId,
        takerOrderId: peer.id,
        takerConnectionId: peer.id,
        takerPublicKey: payload.takerPublicKey,
        assetPair: order.assetPair,
        timestamp: Date.now(),
      },
    });
  }
}

// ─── Periodic Tasks ───────────────────────────────────────────────────────────

// Match scanning: runs every MATCH_INTERVAL_MS
setInterval(() => {
  const { signals } = matcher.scan(orderBook);

  for (const signal of signals) {
    logger.info(
      { pair: signal.assetPair, makerId: signal.makerOrderId.slice(0, 8), takerId: signal.takerOrderId.slice(0, 8) },
      "Match signal"
    );
    broadcastToAll({ type: "match:signal", payload: signal });
  }
}, MATCH_INTERVAL_MS);

// Expiry cleanup + non-open pruning: runs every minute
setInterval(() => {
  const expired = orderBook.expireStale();
  if (expired > 0) {
    logger.info({ count: expired }, "Expired stale orders");
    matcher.reset();
  }
  const pruned = orderBook.pruneNonOpen();
  if (pruned > 0) {
    logger.debug({ count: pruned }, "Pruned non-open orders");
  }
  rateLimiter.prune();
}, 60_000);

// ─── Utilities ────────────────────────────────────────────────────────────────

function sendTo(ws: WebSocket, msg: WsMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcastToAll(msg: WsMessage) {
  const data = JSON.stringify(msg);
  for (const peer of peers.values()) {
    if (peer.ws.readyState === WebSocket.OPEN) {
      peer.ws.send(data);
    }
  }
}

function findPeerByAddress(address: string): PeerConnection | undefined {
  return Array.from(peers.values()).find((p) => p.address === address);
}

function cleanupInterestedTakersForPeer(peerId: string): void {
  for (const [orderId, takers] of interestedTakers) {
    takers.delete(peerId);
    if (takers.size === 0) interestedTakers.delete(orderId);
  }
}

// ─── Start ────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, HOST, () => {
  const proto = USE_TLS ? "https" : "http";
  logger.info({ port: PORT, host: HOST, matchInterval: MATCH_INTERVAL_MS, maxOrders: MAX_ORDERS }, "Relayer started");
  logger.info(`Health: ${proto}://${HOST}:${PORT}/health`);
});

export { orderBook, matcher };
