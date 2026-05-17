import { randomUUID } from "crypto";
import type { RelayerOrderEntry, EncryptedOrder } from "../../shared/types";
import { validateOrderPayload } from "../../shared/types";

type OrderMap = Map<string, RelayerOrderEntry>;

export class OrderBook {
  private orders: OrderMap = new Map();
  private encryptedKeySet = new Set<string>();
  private statusChangedAt = new Map<string, number>();
  private maxOrders: number;
  private pruneTtlMs: number;

  constructor(maxOrders: number = 10_000, pruneTtlMs: number = 300_000) {
    this.maxOrders = maxOrders;
    this.pruneTtlMs = pruneTtlMs;
  }

  /**
   * Add a new encrypted order to the book.
   * Validates all hex fields and enforces order book capacity.
   */
  add(order: Omit<EncryptedOrder, "encryptedAesKey">, id?: string): RelayerOrderEntry {
    if (this.orders.size >= this.maxOrders) {
      throw new Error("Order book is full");
    }

    validateOrderPayload(order);

    const entry: RelayerOrderEntry = {
      ...order,
      id: id ?? randomUUID(),
      receivedAt: Date.now(),
      status: "open",
    };

    this.orders.set(entry.id, entry);
    return entry;
  }

  findOpposites(
    assetPair: string,
    directionBit: 0 | 1
  ): RelayerOrderEntry[] {
    const oppositeDirection: 0 | 1 = directionBit === 0 ? 1 : 0;
    const now = Math.floor(Date.now() / 1000);

    return Array.from(this.orders.values()).filter(
      (o) =>
        o.status === "open" &&
        o.assetPair === assetPair &&
        o.directionBit === oppositeDirection &&
        o.expiry > now
    );
  }

  markFilled(id: string): boolean {
    const order = this.orders.get(id);
    if (!order || order.status !== "open") return false;
    order.status = "filled";
    this.statusChangedAt.set(id, Date.now());
    return true;
  }

  markCancelled(id: string): boolean {
    const order = this.orders.get(id);
    if (!order || order.status !== "open") return false;
    order.status = "cancelled";
    this.statusChangedAt.set(id, Date.now());
    return true;
  }

  /**
   * Update an order with the encrypted AES key after a match is negotiated.
   * Returns false if already set (prevents overwrite by a different peer).
   */
  setEncryptedKey(id: string, encryptedAesKey: string): boolean {
    if (this.encryptedKeySet.has(id)) return false;
    const order = this.orders.get(id);
    if (!order) return false;
    (order as RelayerOrderEntry & { encryptedAesKey?: string }).encryptedAesKey =
      encryptedAesKey;
    this.encryptedKeySet.add(id);
    return true;
  }

  /**
   * Check if an order already has an encrypted key set.
   */
  hasEncryptedKey(id: string): boolean {
    return this.encryptedKeySet.has(id);
  }

  /**
   * Expire orders past their deadline and delete them.
   * Returns the count of expired+deleted orders.
   */
  expireStale(): number {
    const now = Math.floor(Date.now() / 1000);
    let count = 0;
    const toDelete: string[] = [];

    for (const [id, order] of this.orders) {
      if (order.status === "open" && order.expiry <= now) {
        toDelete.push(id);
        count++;
      }
    }

    for (const id of toDelete) {
      this.orders.delete(id);
      this.encryptedKeySet.delete(id);
      this.statusChangedAt.delete(id);
    }

    return count;
  }

  /**
   * Prune non-open orders (filled, cancelled, matched, expired) that have
   * been in that state longer than pruneTtlMs. Should be called periodically
   * alongside expireStale() to keep the order book clean.
   * Returns the count of pruned orders.
   */
  pruneNonOpen(): number {
    const now = Date.now();
    let count = 0;
    const toDelete: string[] = [];

    for (const [id, order] of this.orders) {
      if (order.status !== "open") {
        const changedAt = this.statusChangedAt.get(id) ?? order.receivedAt;
        if (now - changedAt >= this.pruneTtlMs) {
          toDelete.push(id);
          count++;
        }
      }
    }

    for (const id of toDelete) {
      this.orders.delete(id);
      this.encryptedKeySet.delete(id);
      this.statusChangedAt.delete(id);
    }

    return count;
  }

  snapshot(): RelayerOrderEntry[] {
    const now = Math.floor(Date.now() / 1000);
    return Array.from(this.orders.values()).filter(
      (o) => o.status === "open" && o.expiry > now
    );
  }

  getById(id: string): RelayerOrderEntry | undefined {
    return this.orders.get(id);
  }

  getByCommitment(commitment: string): RelayerOrderEntry | undefined {
    return Array.from(this.orders.values()).find(
      (o) => o.commitment === commitment
    );
  }

  size(): number {
    const now = Math.floor(Date.now() / 1000);
    return Array.from(this.orders.values()).filter(
      (o) => o.status === "open" && o.expiry > now
    ).length;
  }

  totalSize(): number {
    return this.orders.size;
  }
}
