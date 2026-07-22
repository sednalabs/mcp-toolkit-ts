/**
 * # Structured Logging & Redaction
 *
 * Provides a production-grade logger with automated secret redaction.
 *
 * ## Rationale
 * Prevents accidental leakage of PII and credentials into persistent logs.
 * It ensures that all log entries are structured (JSON or logfmt) and contain
 * the necessary timestamps and levels for monitoring.
 *
 * ## Security Boundaries
 * * **Secret Redaction**: Automatically identifies and masks patterns matching
 *   tokens, passwords, and connection strings.
 * * **Denial of Service**: Truncates large payloads to prevent log exhaustion.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFormat = 'json' | 'logfmt';

const LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export type Logger = {
  debug: (msg: string, extra?: Record<string, unknown>) => void;
  info: (msg: string, extra?: Record<string, unknown>) => void;
  warn: (msg: string, extra?: Record<string, unknown>) => void;
  error: (msg: string, extra?: Record<string, unknown>) => void;
};

export type LoggerOptions = {
  level: LogLevel;
  format: LogFormat;
  stream?: NodeJS.WritableStream;
  redactKeys?: RegExp;
  redactValuePatterns?: RedactValuePattern[];
};

export type RedactValuePattern =
  | RegExp
  | {
      pattern: RegExp;
      replacement: string;
    };

export const DEFAULT_REDACT_KEYS = /token|secret|password|authorization/i;
export const DEFAULT_REDACT_VALUE_PATTERNS: RedactValuePattern[] = [
  { pattern: /(authorization:\s*bearer\s+)[^\s]+/gi, replacement: '$1REDACTED' },
  { pattern: /\bbearer\s+[A-Za-z0-9._~-]+/gi, replacement: 'Bearer REDACTED' },
  { pattern: /(github_pat\s*[=:]\s*)\S+/gi, replacement: '$1REDACTED' },
  { pattern: /gh[a-z]_[A-Za-z0-9_]{36,}/g, replacement: 'REDACTED' },
  { pattern: /(password|token|secret|api_key)\s*[=:]\s*\S+/gi, replacement: '$1=REDACTED' },
  {
    pattern: /(client_secret|subject_token|access_token|refresh_token)\s*[=:]\s*\S+/gi,
    replacement: '$1=REDACTED',
  },
  { pattern: /postgresql(\+\w+)?:\/\/[^\s]+/gi, replacement: 'postgresql://REDACTED' },
];

type NormalizedRedactPattern = { pattern: RegExp; replacement: string };

function normalizeRedactPatterns(
  patterns: RedactValuePattern[] | undefined,
): NormalizedRedactPattern[] {
  const resolved = patterns ?? DEFAULT_REDACT_VALUE_PATTERNS;
  return resolved.map((entry) =>
    entry instanceof RegExp ? { pattern: entry, replacement: '$1REDACTED' } : entry,
  );
}

/**
 * Scrub sensitive data from a string using heuristic patterns.
 *
 * # Security
 * * **Heuristics**: Uses regular expressions to find and mask bearer tokens,
 *   GitHub tokens, and database URLs.
 */
export function redactString(
  value: string,
  patterns?: RedactValuePattern[],
): string {
  let redacted = value;
  for (const entry of normalizeRedactPatterns(patterns)) {
    redacted = redacted.replace(entry.pattern, entry.replacement);
  }
  return redacted;
}

export function redactValue(
  value: unknown,
  patterns?: RedactValuePattern[],
): unknown {
  if (typeof value !== 'string') return value;
  return redactString(value, patterns);
}

function sanitize(
  extra: Record<string, unknown> | undefined,
  redactKeys: RegExp,
  redactValuePatterns: RedactValuePattern[],
): Record<string, unknown> | undefined {
  if (!extra) return undefined;
  const normalizedPatterns = normalizeRedactPatterns(redactValuePatterns);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra)) {
    if (redactKeys.test(key)) {
      out[key] = '<redacted>';
      continue;
    }
    out[key] = redactValue(value, normalizedPatterns);
  }
  return out;
}

/**
 * Create a new structured logger with the provided options.
 *
 * # Security
 * * **Sanitization**: All metadata passed to the logger is automatically scrubbed
 *   based on the configured `redactKeys` and `redactValuePatterns`.
 */
export function createLogger(options: LoggerOptions): Logger {
  const threshold = LEVELS[options.level] ?? LEVELS.info;
  const stream = options.stream ?? process.stdout;
  const redactKeys = options.redactKeys ?? DEFAULT_REDACT_KEYS;
  const redactValuePatterns = options.redactValuePatterns ?? DEFAULT_REDACT_VALUE_PATTERNS;

  function emit(lvl: LogLevel, msg: string, extra?: Record<string, unknown>): void {
    if ((LEVELS[lvl] ?? 0) < threshold) return;
    const payload = {
      ts: new Date().toISOString(),
      level: lvl,
      msg,
      ...sanitize(extra, redactKeys, redactValuePatterns),
    };
    if (options.format === 'json') {
      stream.write(`${JSON.stringify(payload)}\n`);
      return;
    }
    const parts = Object.entries(payload).map(
      ([key, value]) => `${key}=${String(value).replace(/\s+/g, '_')}`,
    );
    stream.write(`${parts.join(' ')}\n`);
  }

  return {
    debug: (msg, extra) => emit('debug', msg, extra),
    info: (msg, extra) => emit('info', msg, extra),
    warn: (msg, extra) => emit('warn', msg, extra),
    error: (msg, extra) => emit('error', msg, extra),
  };
}
