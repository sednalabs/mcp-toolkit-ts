import crypto from 'node:crypto';

export type IntrospectionAuthMethod = 'client_secret_basic' | 'client_secret_post';

export type IntrospectionConfig = {
  url: string;
  clientId: string;
  clientSecret: string;
  authMethod?: IntrospectionAuthMethod;
  timeoutMs?: number;
  cacheTtlSeconds?: number;
  cacheMaxEntries?: number;
  now?: () => number;
  fetch?: typeof fetch;
};

export type IntrospectionResponse = Record<string, unknown> & {
  active?: boolean | 'true' | 'false';
};

type CacheEntry = {
  value: IntrospectionResponse;
  expiresAt: number;
  createdAt: number;
};

class IntrospectionCache {
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private entries = new Map<string, CacheEntry>();

  constructor(ttlSeconds: number, maxEntries: number, now: () => number) {
    this.ttlMs = Math.max(0, ttlSeconds) * 1000;
    this.maxEntries = Math.max(0, maxEntries);
    this.now = now;
  }

  get(key: string): IntrospectionResponse | null {
    if (this.ttlMs <= 0) return null;
    const entry = this.entries.get(key);
    if (!entry) return null;
    const now = this.now();
    if (entry.expiresAt <= now) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  set(key: string, value: IntrospectionResponse, expiresAt: number): void {
    if (this.ttlMs <= 0) return;
    const now = this.now();
    if (expiresAt <= now) return;
    if (this.maxEntries > 0 && this.entries.size >= this.maxEntries) {
      this.evictOldest();
    }
    this.entries.set(key, { value, expiresAt, createdAt: now });
  }

  private evictOldest(): void {
    if (this.entries.size === 0) return;
    const evictCount = Math.max(1, Math.floor(this.maxEntries / 10));
    const oldest = Array.from(this.entries.entries())
      .sort((a, b) => a[1].createdAt - b[1].createdAt)
      .slice(0, evictCount);
    for (const [key] of oldest) {
      this.entries.delete(key);
    }
  }
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function resolveFetch(custom?: typeof fetch): typeof fetch {
  if (custom) return custom;
  if (typeof fetch === 'function') return fetch;
  throw new Error('Fetch is not available; provide a custom fetch implementation.');
}

function normalizeActiveFlag(value: IntrospectionResponse['active']): boolean {
  if (value === true) return true;
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true';
  }
  return false;
}

export class IntrospectionClient {
  private readonly config: IntrospectionConfig;
  private readonly cache: IntrospectionCache;
  private readonly inflight = new Map<string, Promise<IntrospectionResponse>>();

  constructor(config: IntrospectionConfig) {
    this.config = config;
    const ttlSeconds = config.cacheTtlSeconds ?? 0;
    const maxEntries = config.cacheMaxEntries ?? 1000;
    const now = config.now ?? (() => Date.now());
    this.cache = new IntrospectionCache(ttlSeconds, maxEntries, now);
  }

  async introspect(token: string): Promise<{ active: boolean; response: IntrospectionResponse }> {
    const key = hashToken(token);
    const cached = this.cache.get(key);
    if (cached) {
      return { active: normalizeActiveFlag(cached.active), response: cached };
    }
    const inflight = this.inflight.get(key);
    if (inflight) {
      const response = await inflight;
      return { active: normalizeActiveFlag(response.active), response };
    }
    const promise = this.performRequest(token);
    this.inflight.set(key, promise);
    try {
      const response = await promise;
      const now = this.config.now?.() ?? Date.now();
      const ttlMs = Math.max(0, this.config.cacheTtlSeconds ?? 0) * 1000;
      let expiresAt = now + ttlMs;
      const exp = typeof response.exp === 'number' ? response.exp * 1000 : undefined;
      if (exp !== undefined) {
        expiresAt = Math.min(expiresAt, exp);
      }
      this.cache.set(key, response, expiresAt);
      return { active: normalizeActiveFlag(response.active), response };
    } finally {
      this.inflight.delete(key);
    }
  }

  private async performRequest(token: string): Promise<IntrospectionResponse> {
    const fetchImpl = resolveFetch(this.config.fetch);
    const timeoutMs = this.config.timeoutMs ?? 5_000;
    const headers: Record<string, string> = {
      accept: 'application/json',
      'content-type': 'application/x-www-form-urlencoded',
    };
    const params = new URLSearchParams();
    params.set('token', token);
    params.set('token_type_hint', 'access_token');
    const authMethod = this.config.authMethod ?? 'client_secret_basic';
    if (authMethod === 'client_secret_post') {
      params.set('client_id', this.config.clientId);
      params.set('client_secret', this.config.clientSecret);
    } else {
      const encoded = Buffer.from(
        `${this.config.clientId}:${this.config.clientSecret}`,
        'utf8',
      ).toString('base64');
      headers.authorization = `Basic ${encoded}`;
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(this.config.url, {
        method: 'POST',
        headers,
        body: params,
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(
          `Introspection failed with status ${response.status}${body ? `: ${body}` : ''}`,
        );
      }
      return (await response.json()) as IntrospectionResponse;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error('Introspection request timed out.');
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
