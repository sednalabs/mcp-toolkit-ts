import {
  DEFAULT_REDACT_KEYS,
  DEFAULT_REDACT_VALUE_PATTERNS,
  redactString,
  type LogLevel,
  type Logger,
  type RedactValuePattern,
} from './logging.js';

export type McpLoggingLevel =
  | 'debug'
  | 'info'
  | 'notice'
  | 'warning'
  | 'error'
  | 'critical'
  | 'alert'
  | 'emergency';

const MCP_LEVELS: Record<McpLoggingLevel, number> = {
  debug: 10,
  info: 20,
  notice: 25,
  warning: 30,
  error: 40,
  critical: 50,
  alert: 60,
  emergency: 70,
};

const CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const MAX_VALUE_LENGTH = 2048;
const MAX_DEPTH = 2;
const MAX_KEYS = 32;
const MAX_ARRAY = 32;
const MAX_LOG_PAYLOAD = 4096;
const STACK_KEYS = new Set(['stack', 'stacktrace', 'traceback']);

export const MCP_LOGGING_SCHEMA = {
  version: 1,
  notes: [
    'All MCP log payloads include an `event` field.',
    'Payloads are redacted and size-capped before emission.',
  ],
  events: [
    {
      name: 'session.initialize',
      fields: {
        protocol_version: 'string',
        client_name: 'string',
        client_version: 'string',
      },
    },
    { name: 'session.initialized', fields: {} },
    { name: 'session.disconnect', fields: { error: 'boolean', error_type: 'string' } },
    {
      name: 'tool.call.start',
      fields: { tool_name: 'string', arg_keys: 'string[]' },
    },
    {
      name: 'tool.call.error',
      fields: {
        tool_name: 'string',
        error: 'string',
        reason: 'string',
        retry_after_s: 'number',
      },
    },
    {
      name: 'tool.call.finish',
      fields: { tool_name: 'string', duration_ms: 'number', error: 'boolean' },
    },
    {
      name: 'discovery.tools.list.*',
      fields: { duration_ms: 'number', count: 'number', error: 'boolean' },
    },
    {
      name: 'discovery.resources.list.*',
      fields: { duration_ms: 'number', count: 'number', error: 'boolean' },
    },
    {
      name: 'discovery.resource_templates.list.*',
      fields: { duration_ms: 'number', count: 'number', error: 'boolean' },
    },
    {
      name: 'discovery.prompts.list.*',
      fields: { duration_ms: 'number', count: 'number', error: 'boolean' },
    },
    {
      name: 'resource.read.*',
      fields: { uri: 'string', duration_ms: 'number', error: 'boolean' },
    },
    {
      name: 'resource.subscribe.*',
      fields: { uri: 'string', duration_ms: 'number', error: 'boolean' },
    },
    {
      name: 'resource.unsubscribe.*',
      fields: { uri: 'string', duration_ms: 'number', error: 'boolean' },
    },
    {
      name: 'prompt.render.*',
      fields: { prompt_name: 'string', duration_ms: 'number', error: 'boolean' },
    },
  ],
} as const;

export type McpLogSink = (
  payload: {
    level: McpLoggingLevel;
    logger?: string;
    data: Record<string, unknown>;
    relatedRequestId?: string;
  },
  sessionId: string,
) => Promise<void> | void;

export type McpLogEmitterOptions = {
  enabled: boolean;
  serverLevel: McpLoggingLevel | LogLevel;
  maxLevel: McpLoggingLevel | LogLevel;
  rateLimitPerSecond?: number;
  rateLimitBurst?: number;
  redactKeys?: RegExp;
  redactValuePatterns?: RedactValuePattern[];
  toClientLogger?: Logger;
};

type EmitArgs = {
  sessionId?: string;
  level: McpLoggingLevel | LogLevel;
  message: string;
  data?: Record<string, unknown>;
  loggerName?: string;
  relatedRequestId?: string;
  context?: Record<string, string>;
};

type TokenBucket = {
  capacity: number;
  refillRate: number;
  tokens: number;
  updatedAt: number;
};

type SessionCounters = {
  emittedTotal: number;
  rateLimitedTotal: number;
};

function normalizeLevel(level: McpLoggingLevel | LogLevel): McpLoggingLevel {
  if (level === 'warn') return 'warning';
  if (level in MCP_LEVELS) return level as McpLoggingLevel;
  return 'info';
}

function scrubText(value: string, limit = MAX_VALUE_LENGTH): string {
  const cleaned = value.replace(CONTROL_RE, '');
  const redacted = redactString(cleaned, DEFAULT_REDACT_VALUE_PATTERNS);
  if (redacted.length <= limit) return redacted;
  return `${redacted.slice(0, Math.max(0, limit - 3))}...`;
}

function sanitizeValue(
  value: unknown,
  redactKeys: RegExp,
  allowStacks: boolean,
  depth = 0,
): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return scrubText(value);
  }
  if (depth >= MAX_DEPTH) {
    return scrubText(String(value));
  }
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY).map((entry) =>
      sanitizeValue(entry, redactKeys, allowStacks, depth + 1),
    );
  }
  if (value && typeof value === 'object') {
    const sanitized: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value).slice(0, MAX_KEYS)) {
      if (STACK_KEYS.has(key) && !allowStacks) {
        continue;
      }
      if (redactKeys.test(key)) {
        sanitized[key] = '<redacted>';
        continue;
      }
      sanitized[key] = sanitizeValue(entry, redactKeys, allowStacks, depth + 1);
    }
    return sanitized;
  }
  return scrubText(String(value));
}

function sanitizePayload(
  message: string,
  data: Record<string, unknown> | undefined,
  allowStacks: boolean,
  context: Record<string, string> | undefined,
  sessionId: string | undefined,
  redactKeys: RegExp,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { event: scrubText(message) };
  if (data) {
    const sanitized = sanitizeValue(data, redactKeys, allowStacks);
    if (sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)) {
      Object.assign(payload, sanitized);
    }
  }
  if (context) {
    if (context.request_id) payload.request_id = context.request_id;
    if (context.session_id) payload.session_id = context.session_id;
    if (context.actor) payload.actor = context.actor;
  }
  if (!('session_id' in payload) && sessionId) {
    payload.session_id = sessionId;
  }
  return payload;
}

function consume(bucket: TokenBucket, cost = 1): boolean {
  const now = Date.now() / 1000;
  const elapsed = Math.max(0, now - bucket.updatedAt);
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refillRate);
  bucket.updatedAt = now;
  if (bucket.tokens < cost) return false;
  bucket.tokens -= cost;
  return true;
}

function mapToClientLogger(
  logger: Logger,
  level: McpLoggingLevel,
  payload: Record<string, unknown>,
): void {
  const payloadText = scrubText(JSON.stringify(payload), MAX_LOG_PAYLOAD);
  if (level === 'debug') {
    logger.debug('mcp.notify', { payload: payloadText });
    return;
  }
  if (level === 'info' || level === 'notice') {
    logger.info('mcp.notify', { payload: payloadText });
    return;
  }
  if (level === 'warning') {
    logger.warn('mcp.notify', { payload: payloadText });
    return;
  }
  logger.error('mcp.notify', { payload: payloadText });
}

export class McpLogEmitter {
  private readonly enabled: boolean;
  private readonly serverCap: number;
  private readonly serverLevel: McpLoggingLevel;
  private readonly maxLevel: McpLoggingLevel;
  private readonly send: McpLogSink;
  private readonly redactKeys: RegExp;
  private readonly rateLimitPerSecond: number;
  private readonly rateLimitBurst: number;
  private readonly toClientLogger: Logger | undefined;
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly levels = new Map<string, McpLoggingLevel>();
  private readonly sessionCounters = new Map<string, SessionCounters>();
  private emittedTotal = 0;
  private rateLimitedTotal = 0;

  constructor(send: McpLogSink, options: McpLogEmitterOptions) {
    this.send = send;
    this.enabled = options.enabled;
    this.serverLevel = normalizeLevel(options.serverLevel);
    this.maxLevel = normalizeLevel(options.maxLevel);
    this.serverCap = Math.max(MCP_LEVELS[this.serverLevel], MCP_LEVELS[this.maxLevel]);
    this.redactKeys = options.redactKeys ?? DEFAULT_REDACT_KEYS;
    this.rateLimitPerSecond = Math.max(options.rateLimitPerSecond ?? 60, 0);
    this.rateLimitBurst = Math.max(options.rateLimitBurst ?? 120, 0);
    this.toClientLogger = options.toClientLogger;
  }

  setLevel(sessionId: string, level: McpLoggingLevel | LogLevel): void {
    this.levels.set(sessionId, normalizeLevel(level));
  }

  snapshot(): Record<string, unknown> {
    const perSession = Array.from(this.sessionCounters.entries())
      .map(([sessionId, counters]) => ({
        session_id: sessionId,
        emitted_total: counters.emittedTotal,
        rate_limited_total: counters.rateLimitedTotal,
      }))
      .sort((a, b) => b.rate_limited_total - a.rate_limited_total);
    return {
      enabled: this.enabled,
      server_level: this.serverLevel,
      max_level: this.maxLevel,
      rate_limit_per_s: this.rateLimitPerSecond,
      rate_limit_burst: this.rateLimitBurst,
      emitted_total: this.emittedTotal,
      rate_limited_total: this.rateLimitedTotal,
      per_session: perSession.slice(0, 20),
    };
  }

  private shouldEmit(level: McpLoggingLevel, sessionId: string | undefined): boolean {
    if (!this.enabled) return false;
    if (!sessionId) return false;
    if (MCP_LEVELS[level] < this.serverCap) return false;
    const clientLevel = sessionId ? this.levels.get(sessionId) : undefined;
    if (clientLevel && MCP_LEVELS[level] < MCP_LEVELS[clientLevel]) return false;
    return true;
  }

  private consumeToken(sessionId: string): boolean {
    if (this.rateLimitPerSecond <= 0 || this.rateLimitBurst <= 0) return true;
    const existing = this.buckets.get(sessionId);
    if (!existing) {
      const bucket: TokenBucket = {
        capacity: this.rateLimitBurst,
        refillRate: this.rateLimitPerSecond,
        tokens: this.rateLimitBurst,
        updatedAt: Date.now() / 1000,
      };
      this.buckets.set(sessionId, bucket);
      return consume(bucket);
    }
    return consume(existing);
  }

  private recordEmit(sessionId: string): void {
    this.emittedTotal += 1;
    const counters = this.sessionCounters.get(sessionId) ?? { emittedTotal: 0, rateLimitedTotal: 0 };
    counters.emittedTotal += 1;
    this.sessionCounters.set(sessionId, counters);
  }

  private recordRateLimited(sessionId: string): void {
    this.rateLimitedTotal += 1;
    const counters = this.sessionCounters.get(sessionId) ?? { emittedTotal: 0, rateLimitedTotal: 0 };
    counters.rateLimitedTotal += 1;
    this.sessionCounters.set(sessionId, counters);
  }

  async emit(args: EmitArgs): Promise<void> {
    const sessionId = args.sessionId;
    const level = normalizeLevel(args.level);
    if (!this.shouldEmit(level, sessionId)) return;
    if (!sessionId) return;
    if (MCP_LEVELS[level] < MCP_LEVELS.error && !this.consumeToken(sessionId)) {
      this.recordRateLimited(sessionId);
      return;
    }
    const allowStacks = this.serverCap <= MCP_LEVELS.debug;
    const payload = sanitizePayload(
      args.message,
      args.data,
      allowStacks,
      args.context,
      sessionId,
      this.redactKeys,
    );
    try {
      const message = {
        level,
        data: payload,
        ...(args.loggerName ? { logger: args.loggerName } : {}),
        ...(args.relatedRequestId ? { relatedRequestId: args.relatedRequestId } : {}),
      };
      await this.send(message, sessionId);
      this.recordEmit(sessionId);
      if (this.toClientLogger) {
        mapToClientLogger(this.toClientLogger, level, payload);
      }
    } catch {
      return;
    }
  }
}
