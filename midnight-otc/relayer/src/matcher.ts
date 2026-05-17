/**
 * Order matching engine for the relayer.
 *
 * Privacy guarantee: matcher never decrypts any order.
 * It only uses public metadata (assetPair, directionBit) to signal
 * that potential matches exist. The actual price/size compatibility
 * is determined by the maker and taker off-chain after they negotiate.
 */

import { randomUUID } from "crypto";
import type { MatchSignal } from "../../shared/types";
import type { OrderBook } from "./orderbook";
import type { RelayerOrderEntry } from "./types";

export interface MatchResult {
  signals: MatchSignal[];
  matchedPairs: Array<{ buyId: string; sellId: string }>;
}

const DEFAULT_SIGNAL_TTL_MS = 30_000;
const DEFAULT_MAX_ORDERS_PER_SCAN = 200;
const DEFAULT_MAX_SIGNALS_PER_SCAN = 500;

export class Matcher {
  private recentSignals = new Map<string, number>();
  private signalTtlMs: number;
  private maxOrdersPerScan: number;
  private maxSignalsPerScan: number;

  constructor(
    signalTtlMs: number = DEFAULT_SIGNAL_TTL_MS,
    maxOrdersPerScan: number = DEFAULT_MAX_ORDERS_PER_SCAN,
    maxSignalsPerScan: number = DEFAULT_MAX_SIGNALS_PER_SCAN,
  ) {
    this.signalTtlMs = signalTtlMs;
    this.maxOrdersPerScan = maxOrdersPerScan;
    this.maxSignalsPerScan = maxSignalsPerScan;
  }

  /**
   * Scan the order book for potential matches.
   * Called periodically by the relayer on a timer.
   *
   * Returns match signals to broadcast to subscribers.
   * Signals are informational — they do not commit either party.
   */
  scan(orderBook: OrderBook): MatchResult {
    const openOrders = orderBook.snapshot();
    const signals: MatchSignal[] = [];
    const matchedPairs: Array<{ buyId: string; sellId: string }> = [];
    const now = Date.now();
    const staleThreshold = now - this.signalTtlMs;

    // Prune stale entries lazily before scan
    for (const [key, ts] of this.recentSignals) {
      if (ts < staleThreshold) this.recentSignals.delete(key);
    }

    // Limit orders scanned per interval to cap O(N²)
    const ordersToScan = openOrders.slice(0, this.maxOrdersPerScan);

    // Group by asset pair
    const byPair = new Map<string, { buys: RelayerOrderEntry[]; sells: RelayerOrderEntry[] }>();

    for (const order of ordersToScan) {
      if (!byPair.has(order.assetPair)) {
        byPair.set(order.assetPair, { buys: [], sells: [] });
      }
      const group = byPair.get(order.assetPair)!;
      if (order.directionBit === 0) {
        group.buys.push(order);
      } else {
        group.sells.push(order);
      }
    }

    // For each pair, signal every buy↔sell combination we haven't signaled recently
    // Hard-cap both O(N²) iterations and total signals per scan
    let signalCount = 0;

    for (const [pair, { buys, sells }] of byPair) {
      if (signalCount >= this.maxSignalsPerScan) break;

      for (const buy of buys) {
        if (signalCount >= this.maxSignalsPerScan) break;
        for (const sell of sells) {
          if (signalCount >= this.maxSignalsPerScan) break;

          const pairKey = `${buy.id}:${sell.id}`;
          if (this.recentSignals.has(pairKey)) continue;

          this.recentSignals.set(pairKey, now);
          matchedPairs.push({ buyId: buy.id, sellId: sell.id });
          signalCount++;

          signals.push({
            matchId: randomUUID(),
            makerOrderId: sell.id,
            takerOrderId: buy.id,
            assetPair: pair,
            timestamp: now,
          });
        }
      }
    }

    // Hard cap to prevent memory leak
    if (this.recentSignals.size > 10_000) {
      const entries = Array.from(this.recentSignals.entries());
      this.recentSignals = new Map(entries.slice(-5_000));
    }

    return { signals, matchedPairs };
  }

  /**
   * Remove a specific order's signal entries (e.g., after fill failure).
   */
  clearSignalsForOrder(orderId: string): void {
    for (const [key] of this.recentSignals) {
      if (key.includes(orderId)) this.recentSignals.delete(key);
    }
  }

  /**
   * Reset signal cache entirely.
   */
  reset(): void {
    this.recentSignals.clear();
  }
}
