import { redactValue } from '../../logging.js';
import { DEFAULT_REDACT_KEYS, DEFAULT_REDACT_VALUE_PATTERNS } from '../../logging.js';

export type ErrorDetails = {
  message: string;
  code?: number | string;
  data?: unknown;
  name?: string;
  event?: unknown;
  cause?: string;
  raw?: unknown;
};

const TRACE_REDACT_KEYS = DEFAULT_REDACT_KEYS;
const TRACE_REDACT_VALUE_PATTERNS = DEFAULT_REDACT_VALUE_PATTERNS;

export function serializeUnknown(
  value: unknown,
  seen: WeakSet<object> = new WeakSet<object>(),
  depth: number = 0,
): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'function') {
    return '[Function]';
  }
  if (typeof value === 'symbol') {
    return value.toString();
  }
  if (typeof value === 'string') {
    return redactValue(value, TRACE_REDACT_VALUE_PATTERNS) as string;
  }
  if (value instanceof Error) {
    const base: Record<string, unknown> = {
      name: value.name,
      message: redactValue(value.message, TRACE_REDACT_VALUE_PATTERNS),
      stack: value.stack ? redactValue(value.stack, TRACE_REDACT_VALUE_PATTERNS) : value.stack,
    };
    if ('cause' in value && value.cause !== undefined) {
      base.cause = serializeUnknown(value.cause, seen, depth + 1);
    }
    for (const [key, entry] of Object.entries(value)) {
      base[key] = TRACE_REDACT_KEYS.test(key)
        ? '[REDACTED]'
        : serializeUnknown(entry, seen, depth + 1);
    }
    return base;
  }
  if (typeof value === 'object') {
    if (seen.has(value)) {
      return '[Circular]';
    }
    seen.add(value);
    if (Array.isArray(value)) {
      return value.map((entry) => serializeUnknown(entry, seen, depth + 1));
    }
    const record: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      record[key] = TRACE_REDACT_KEYS.test(key)
        ? '[REDACTED]'
        : serializeUnknown(entry, seen, depth + 1);
    }
    return record;
  }
  return value;
}

export function serializeError(error: unknown): unknown {
  return serializeUnknown(error);
}

function summarizeEvent(event: unknown): unknown {
  if (!event || typeof event !== 'object') {
    return event;
  }
  const record = event as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  const candidates = ['code', 'message', 'status', 'statusText', 'type'] as const;
  for (const key of candidates) {
    const value = record[key];
    if (typeof value === 'string' || typeof value === 'number') {
      summary[key] = value;
    }
  }
  return Object.keys(summary).length > 0 ? summary : undefined;
}

export function describeError(error: unknown): ErrorDetails {
  const message = error instanceof Error ? error.message : String(error);
  if (error && typeof error === 'object') {
    const record = error as {
      code?: unknown;
      data?: unknown;
      name?: unknown;
      event?: unknown;
      cause?: unknown;
    };
    const code = record.code;
    const data = record.data;
    const name = typeof record.name === 'string' ? record.name : undefined;
    const event = summarizeEvent(record.event);
    const cause =
      record.cause instanceof Error
        ? record.cause.message
        : typeof record.cause === 'string'
          ? record.cause
          : typeof record.cause === 'object' && record.cause && 'message' in record.cause
            ? String((record.cause as { message?: unknown }).message)
            : undefined;
    return {
      message,
      ...(code !== undefined ? { code: code as number | string } : {}),
      ...(data !== undefined ? { data } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(event !== undefined ? { event } : {}),
      ...(cause !== undefined ? { cause } : {}),
      raw: serializeError(error),
    };
  }
  return { message, raw: serializeError(error) };
}

export function errorData(details: ErrorDetails): Record<string, unknown> | undefined {
  if (
    details.code === undefined &&
    details.data === undefined &&
    details.name === undefined &&
    details.event === undefined &&
    details.cause === undefined &&
    details.raw === undefined
  ) {
    return undefined;
  }
  return {
    ...(details.code !== undefined ? { code: details.code } : {}),
    ...(details.data !== undefined ? { data: details.data } : {}),
    ...(details.name !== undefined ? { name: details.name } : {}),
    ...(details.event !== undefined ? { event: details.event } : {}),
    ...(details.cause !== undefined ? { cause: details.cause } : {}),
    ...(details.raw !== undefined ? { raw: details.raw } : {}),
  };
}
