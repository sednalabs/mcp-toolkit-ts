type Bucket = {
  count: number;
  resetAt: number;
};

export type RateLimitDecision = {
  allowed: boolean;
  reason?: 'ip' | 'session';
  retryAfterSeconds?: number;
  hint?: string;
};

export class RateLimiter {
  private readonly byIp = new Map<string, Bucket>();
  private readonly bySession = new Map<string, Bucket>();
  private readonly windowMs: number;
  private readonly maxPerIp: number;
  private readonly maxPerSession: number;
  private readonly now: () => number;
  private tick = 0;

  constructor(
    windowSeconds: number,
    maxPerIp: number,
    maxPerSession: number,
    now: () => number = () => Date.now(),
  ) {
    this.windowMs = Math.max(1, windowSeconds) * 1000;
    this.maxPerIp = maxPerIp;
    this.maxPerSession = maxPerSession;
    this.now = now;
  }

  check(ip: string, sessionId?: string): RateLimitDecision {
    const now = this.now();
    if (this.maxPerIp > 0) {
      const ipDecision = this.checkBucket(this.byIp, ip, this.maxPerIp, now);
      if (!ipDecision.allowed) {
        return { ...ipDecision, reason: 'ip' };
      }
    }
    if (sessionId && this.maxPerSession > 0) {
      const sessionDecision = this.checkBucket(this.bySession, sessionId, this.maxPerSession, now);
      if (!sessionDecision.allowed) {
        return { ...sessionDecision, reason: 'session' };
      }
    }
    return { allowed: true };
  }

  private checkBucket(
    map: Map<string, Bucket>,
    key: string,
    max: number,
    now: number,
  ): RateLimitDecision {
    let bucket = map.get(key);
    if (!bucket || now >= bucket.resetAt) {
      bucket = { count: 0, resetAt: now + this.windowMs };
      map.set(key, bucket);
    }
    if (bucket.count >= max) {
      const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
      return {
        allowed: false,
        retryAfterSeconds,
        hint: `To fix this, wait ${retryAfterSeconds}s and retry.`,
      };
    }
    bucket.count += 1;
    this.maybeCleanup(map, now);
    return { allowed: true };
  }

  private maybeCleanup(map: Map<string, Bucket>, now: number): void {
    this.tick += 1;
    if (this.tick % 100 !== 0) return;
    if (map.size < 10_000) return;
    for (const [key, bucket] of map.entries()) {
      if (now >= bucket.resetAt) {
        map.delete(key);
      }
    }
  }
}
