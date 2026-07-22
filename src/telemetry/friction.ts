export type FanoutAdvice = {
  title: string;
  details: string;
  recommended: string;
  recommended_tool?: string;
};

export type FanoutEmit = {
  key: string;
  advice: FanoutAdvice;
  calls: number;
  wasted_calls: number;
  wasted_delta: number;
};

type FanoutObservation = {
  last_seen: number;
  calls: number;
  wasted_calls: number;
  advice: FanoutAdvice;
};

export class FanoutDetector {
  private readonly threshold: number;
  private readonly gapMs: number;
  private readonly cache = new Map<string, FanoutObservation>();

  constructor(options: { threshold: number; gapSeconds: number }) {
    if (options.threshold < 2) throw new Error('threshold must be >= 2');
    if (options.gapSeconds <= 0) throw new Error('gapSeconds must be positive');
    this.threshold = options.threshold;
    this.gapMs = options.gapSeconds * 1000;
  }

  observe(options: {
    key: string;
    cardinality: number;
    now: number;
    advice?: FanoutAdvice;
  }): FanoutEmit | null {
    const { key, cardinality, now, advice } = options;

    if (cardinality !== 1 || !advice) {
      this.cache.delete(key);
      return null;
    }

    const prev = this.cache.get(key);
    if (!prev || now - prev.last_seen > this.gapMs) {
      this.cache.set(key, {
        last_seen: now,
        calls: 1,
        wasted_calls: 0,
        advice,
      });
      return null;
    }

    const calls = prev.calls + 1;
    const wasted_calls = prev.wasted_calls + 1;
    const observation: FanoutObservation = {
      last_seen: now,
      calls,
      wasted_calls,
      advice: prev.advice,
    };
    this.cache.set(key, observation);

    if (calls < this.threshold) {
      return null;
    }

    return {
      key,
      advice: prev.advice,
      calls,
      wasted_calls,
      wasted_delta: 1,
    };
  }
}

export class ErrorStormDetector {
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;
  private errors: number[] = [];
  private nextAllowedAt = 0;

  constructor(options: { threshold: number; windowSeconds: number; cooldownSeconds: number }) {
    this.threshold = options.threshold;
    this.windowMs = options.windowSeconds * 1000;
    this.cooldownMs = options.cooldownSeconds * 1000;
  }

  observe(now: number): [boolean, number] {
    this.errors = this.errors.filter((ts) => now - ts <= this.windowMs);
    this.errors.push(now);

    if (now < this.nextAllowedAt) {
      return [false, this.errors.length];
    }

    if (this.errors.length >= this.threshold) {
      this.nextAllowedAt = now + this.cooldownMs;
      return [true, this.errors.length];
    }

    return [false, this.errors.length];
  }
}

type KeyedErrorState = {
  errors: number[];
  nextAllowedAt: number;
};

export class PerActorErrorDetector {
  private readonly threshold: number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;
  private readonly state = new Map<string, KeyedErrorState>();

  constructor(options: { threshold: number; windowSeconds: number; cooldownSeconds: number }) {
    if (options.threshold < 2) throw new Error('threshold must be >= 2');
    if (options.windowSeconds <= 0) throw new Error('windowSeconds must be positive');
    if (options.cooldownSeconds < 0) throw new Error('cooldownSeconds must be >= 0');
    this.threshold = options.threshold;
    this.windowMs = options.windowSeconds * 1000;
    this.cooldownMs = options.cooldownSeconds * 1000;
  }

  observe(key: string, now: number): [boolean, number] {
    let state = this.state.get(key);
    if (!state) {
      state = { errors: [], nextAllowedAt: 0 };
    }

    state.errors = state.errors.filter((ts) => now - ts <= this.windowMs);
    state.errors.push(now);

    if (now < state.nextAllowedAt) {
      this.state.set(key, state);
      return [false, state.errors.length];
    }

    if (state.errors.length >= this.threshold) {
      state.nextAllowedAt = now + this.cooldownMs;
      this.state.set(key, state);
      return [true, state.errors.length];
    }

    this.state.set(key, state);
    return [false, state.errors.length];
  }
}
