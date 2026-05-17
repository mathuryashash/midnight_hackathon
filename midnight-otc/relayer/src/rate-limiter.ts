export interface BucketState {
  tokens: number;
  lastRefill: number;
}

export class RateLimiter {
  private state = new Map<string, BucketState>();

  constructor(
    private capacity: number,
    private refillRate: number,
    private refillIntervalMs: number = 1000,
  ) {}

  check(key: string): boolean {
    const now = Date.now();
    let bucket = this.state.get(key);

    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefill: now };
      this.state.set(key, bucket);
    }

    const elapsed = now - bucket.lastRefill;
    const intervals = Math.floor(elapsed / this.refillIntervalMs);
    if (intervals > 0) {
      bucket.tokens = Math.min(
        this.capacity,
        bucket.tokens + intervals * this.refillRate,
      );
      bucket.lastRefill = now;
    }

    if (bucket.tokens > 0) {
      bucket.tokens--;
      return true;
    }

    return false;
  }

  cleanup(key: string): void {
    this.state.delete(key);
  }

  prune(): void {
    const now = Date.now();
    const staleThreshold = this.refillIntervalMs * 2;
    for (const [key, bucket] of this.state) {
      if (now - bucket.lastRefill > staleThreshold && bucket.tokens === this.capacity) {
        this.state.delete(key);
      }
    }
  }
}
