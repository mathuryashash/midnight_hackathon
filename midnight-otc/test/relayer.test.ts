/**
 * Relayer order book and matcher tests.
 */

import { randomUUID } from "crypto";
import { OrderBook } from "../relayer/src/orderbook";
import { Matcher } from "../relayer/src/matcher";
import { RateLimiter } from "../relayer/src/rate-limiter";
import type { RelayerOrderEntry } from "../shared/types";

function makeEntry(overrides: Partial<RelayerOrderEntry> = {}): RelayerOrderEntry {
  return {
    id: `ord-${randomUUID().slice(0, 8)}`,
    commitment: "a".repeat(64),
    ciphertext: "aa".repeat(32),
    iv: "b".repeat(24),
    authTag: "c".repeat(32),
    salt: "d".repeat(64),
    assetPair: "BTC/USDC",
    directionBit: 0,
    expiry: Math.floor(Date.now() / 1000) + 3600,
    makerAddress: "0xMaker",
    makerPublicKey: "04deadbeef...",
    signature: "ff".repeat(32),
    receivedAt: Date.now(),
    status: "open",
    ...overrides,
  };
}

describe("OrderBook", () => {
  test("adds and retrieves orders", () => {
    const book = new OrderBook();
    const entry = makeEntry();
    const added = book.add(entry);

    expect(book.getById(added.id)).toBeDefined();
    expect(book.size()).toBe(1);
  });

  test("findOpposites returns only opposite-direction orders for same pair", () => {
    const book = new OrderBook();

    book.add(makeEntry({ directionBit: 0, assetPair: "BTC/USDC" })); // BUY
    book.add(makeEntry({ directionBit: 0, assetPair: "BTC/USDC" })); // BUY
    const sellId = book.add(makeEntry({ directionBit: 1, assetPair: "BTC/USDC" })).id; // SELL

    const opposites = book.findOpposites("BTC/USDC", 0); // Looking for sells opposite to buy
    expect(opposites).toHaveLength(1);
    expect(opposites[0].id).toBe(sellId);
  });

  test("findOpposites ignores different asset pairs", () => {
    const book = new OrderBook();
    book.add(makeEntry({ directionBit: 1, assetPair: "ETH/USDC" })); // Wrong pair

    const opposites = book.findOpposites("BTC/USDC", 0);
    expect(opposites).toHaveLength(0);
  });

  test("markFilled removes order from active set", () => {
    const book = new OrderBook();
    const { id } = book.add(makeEntry());

    expect(book.size()).toBe(1);
    book.markFilled(id);
    expect(book.size()).toBe(0);
    expect(book.getById(id)?.status).toBe("filled");
  });

  test("snapshot only returns open orders", () => {
    const book = new OrderBook();
    const e1 = book.add(makeEntry({ expiry: Math.floor(Date.now() / 1000) + 3600 }));
    book.markFilled(e1.id);

    const e2 = book.add(makeEntry({ expiry: Math.floor(Date.now() / 1000) + 3600 }));

    const snap = book.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].id).toBe(e2.id);
    expect(snap[0].status).toBe("open");
  });

  test("expireStale does not remove valid orders", () => {
    const book = new OrderBook();
    const e1 = book.add(makeEntry({ expiry: Math.floor(Date.now() / 1000) + 3600 }));
    const e2 = book.add(makeEntry({ expiry: Math.floor(Date.now() / 1000) + 7200 }));

    expect(book.totalSize()).toBe(2);
    const removed = book.expireStale();
    expect(removed).toBe(0);
    expect(book.totalSize()).toBe(2);
    expect(book.getById(e1.id)).toBeDefined();
    expect(book.getById(e2.id)).toBeDefined();
  });

  test("getByCommitment finds order by commitment hash", () => {
    const book = new OrderBook();
    const commitment = "e".repeat(64);
    const added = book.add(makeEntry({ commitment }));

    expect(book.getByCommitment(commitment)?.id).toBe(added.id);
    expect(book.getByCommitment("f".repeat(64))).toBeUndefined();
  });
});

describe("RateLimiter", () => {
  test("allows messages within burst capacity", () => {
    const limiter = new RateLimiter(5, 10);
    expect(limiter.check("peer1")).toBe(true);
    expect(limiter.check("peer1")).toBe(true);
    expect(limiter.check("peer1")).toBe(true);
    expect(limiter.check("peer1")).toBe(true);
    expect(limiter.check("peer1")).toBe(true);
  });

  test("blocks messages exceeding burst capacity", () => {
    const limiter = new RateLimiter(3, 10);
    expect(limiter.check("peer2")).toBe(true);
    expect(limiter.check("peer2")).toBe(true);
    expect(limiter.check("peer2")).toBe(true);
    expect(limiter.check("peer2")).toBe(false);
  });

  test("does not leak between peers", () => {
    const limiter = new RateLimiter(2, 10);
    expect(limiter.check("peerA")).toBe(true);
    expect(limiter.check("peerA")).toBe(true);
    expect(limiter.check("peerA")).toBe(false);
    expect(limiter.check("peerB")).toBe(true);
  });

  test("cleanup resets state for a peer", () => {
    const limiter = new RateLimiter(2, 10);
    expect(limiter.check("peer3")).toBe(true);
    expect(limiter.check("peer3")).toBe(true);
    expect(limiter.check("peer3")).toBe(false);

    limiter.cleanup("peer3");
    expect(limiter.check("peer3")).toBe(true);
  });

  test("prune does not remove active buckets", () => {
    const limiter = new RateLimiter(3, 10);
    limiter.check("peer4");
    limiter.check("peer4");
    limiter.prune();
    expect(limiter.check("peer4")).toBe(true);
  });
});

describe("Matcher", () => {
  test("generates match signals for opposite-direction orders", () => {
    const book = new OrderBook();
    const matcher = new Matcher();

    book.add(makeEntry({ directionBit: 0, assetPair: "BTC/USDC" })); // BUY
    book.add(makeEntry({ directionBit: 1, assetPair: "BTC/USDC" })); // SELL

    const { signals } = matcher.scan(book);
    expect(signals.length).toBeGreaterThanOrEqual(1);
    expect(signals[0].assetPair).toBe("BTC/USDC");
  });

  test("does not generate signals for same-direction orders", () => {
    const book = new OrderBook();
    const matcher = new Matcher();

    book.add(makeEntry({ directionBit: 0 }));
    book.add(makeEntry({ directionBit: 0 }));

    const { signals } = matcher.scan(book);
    expect(signals).toHaveLength(0);
  });

  test("does not re-signal the same pair after first scan", () => {
    const book = new OrderBook();
    const matcher = new Matcher();

    book.add(makeEntry({ directionBit: 0 }));
    book.add(makeEntry({ directionBit: 1 }));

    const r1 = matcher.scan(book);
    const r2 = matcher.scan(book); // Second scan, same orders

    expect(r1.signals.length).toBe(1);
    expect(r2.signals.length).toBe(0); // Already signaled — dedup
  });

  test("generates new signals after reset", () => {
    const book = new OrderBook();
    const matcher = new Matcher();

    book.add(makeEntry({ directionBit: 0 }));
    book.add(makeEntry({ directionBit: 1 }));

    matcher.scan(book); // First scan
    matcher.reset();    // Clear signal cache

    const { signals } = matcher.scan(book); // Should re-signal
    expect(signals.length).toBe(1);
  });

  test("respects maxOrdersPerScan cap", () => {
    const book = new OrderBook();
    const matcher = new Matcher(30_000, 10, 100);

    for (let i = 0; i < 15; i++) {
      book.add(makeEntry({ directionBit: i % 2 === 0 ? 0 : 1 }));
    }

    const { signals } = matcher.scan(book);
    expect(signals.length).toBeLessThanOrEqual(100);
  });

  test("relayer CANNOT see order price — only direction and pair", () => {
    const book = new OrderBook();
    const matcher = new Matcher();

    book.add(makeEntry({
      directionBit: 0,
      assetPair: "BTC/USDC",
      ciphertext: "aa".repeat(32),
    }));
    book.add(makeEntry({
      directionBit: 1,
      assetPair: "BTC/USDC",
      ciphertext: "bb".repeat(32),
    }));

    const { signals } = matcher.scan(book);

    expect(signals.length).toBe(1);
    const signal = signals[0];

    // MatchSignal has no price, amount, or side fields by design
    expect(signal).not.toHaveProperty("price");
    expect(signal).not.toHaveProperty("amount");
    expect(signal).not.toHaveProperty("side");

    // Only expected public metadata fields
    const keys = Object.keys(signal).sort();
    expect(keys).toEqual(["assetPair", "makerOrderId", "matchId", "takerOrderId", "timestamp"].sort());
  });
});

describe("OrderBook (graceful pruning)", () => {
  test("pruneNonOpen removes filled orders past TTL", () => {
    jest.useFakeTimers();
    const book = new OrderBook(100, 50); // pruneTtlMs=50
    const { id } = book.add(makeEntry());
    book.markFilled(id);
    expect(book.totalSize()).toBe(1);
    jest.advanceTimersByTime(100);
    const removed = book.pruneNonOpen();
    expect(removed).toBe(1);
    expect(book.totalSize()).toBe(0);
    jest.useRealTimers();
  });

  test("pruneNonOpen does not remove fresh filled orders", () => {
    const book = new OrderBook(100, 300_000);
    const { id } = book.add(makeEntry());
    book.markFilled(id);
    const removed = book.pruneNonOpen();
    expect(removed).toBe(0);
    expect(book.totalSize()).toBe(1);
  });

  test("pruneNonOpen does not affect open orders", () => {
    const book = new OrderBook(100);
    book.add(makeEntry());
    book.add(makeEntry());
    const removed = book.pruneNonOpen();
    expect(removed).toBe(0);
    expect(book.totalSize()).toBe(2);
  });
});

describe("TokenBucket rate limiter refill", () => {
  test("refills tokens over time", () => {
    jest.useFakeTimers();
    const limiter = new RateLimiter(3, 10, 100);
    expect(limiter.check("key")).toBe(true);
    expect(limiter.check("key")).toBe(true);
    expect(limiter.check("key")).toBe(true);
    expect(limiter.check("key")).toBe(false);
    jest.advanceTimersByTime(100); // 1 refill interval → +10 tokens, capped to 3
    expect(limiter.check("key")).toBe(true); // refilled
    jest.useRealTimers();
  });

  test("respects capacity cap after long idle", () => {
    jest.useFakeTimers();
    const limiter = new RateLimiter(5, 10, 100);
    expect(limiter.check("key")).toBe(true); // 5→4
    jest.advanceTimersByTime(10000); // refills to capacity (5)
    expect(limiter.check("key")).toBe(true); // 5→4
    expect(limiter.check("key")).toBe(true); // 4→3
    expect(limiter.check("key")).toBe(true); // 3→2
    expect(limiter.check("key")).toBe(true); // 2→1
    expect(limiter.check("key")).toBe(true); // 1→0
    expect(limiter.check("key")).toBe(false); // 0 → exhausted
    jest.useRealTimers();
  });
});
