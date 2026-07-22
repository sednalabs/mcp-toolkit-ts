export type ReplayGuardOptions = {
  ttlSeconds: number;
  maxEntries: number;
  now?: () => number;
};

export class ReplayGuard {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private entries = new Map<string, number>();

  constructor(options: ReplayGuardOptions) {
    this.ttlMs = Math.max(1, options.ttlSeconds) * 1000;
    this.maxEntries = Math.max(100, options.maxEntries);
    this.now = options.now ?? (() => Date.now());
  }

  seen(tokenId: string): boolean {
    const now = this.now();
    this.pruneExpired(now);
    if (this.entries.has(tokenId)) {
      return true;
    }
    if (this.entries.size >= this.maxEntries) {
      this.evictOldest();
    }
    this.entries.set(tokenId, now);
    return false;
  }

  private pruneExpired(now: number): void {
    for (const [key, ts] of this.entries.entries()) {
      if (now - ts >= this.ttlMs) {
        this.entries.delete(key);
      }
    }
  }

  private evictOldest(): void {
    const evictCount = Math.max(1, Math.floor(this.maxEntries / 10));
    const oldest = Array.from(this.entries.entries())
      .sort((a, b) => a[1] - b[1])
      .slice(0, evictCount);
    for (const [key] of oldest) {
      this.entries.delete(key);
    }
  }
}
