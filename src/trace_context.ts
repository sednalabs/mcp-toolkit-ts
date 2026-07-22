/**
 * # Trace Context
 *
 * Request-scoped metadata propagation for end-to-end tracing.
 *
 * ## Rationale
 * Ensures that `requestId` and `actorId` are available to all layers of the stack,
 * including logging, database settings, and environment variables.
 *
 * ## Security Boundaries
 * * **Sanitization**: Strictly strips control characters and enforces length limits
 *   on trace values to prevent header injection.
 */

import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { DEFAULT_REQUEST_ID_HEADERS, extractRequestId, type HeaderMap } from './request_id.js';

export type TraceContext = {
  requestId?: string;
  actorId?: string;
};

export const DEFAULT_ACTOR_ID_HEADERS = ['x-ops-actor-id', 'ops-actor-id', 'x-actor-id'];

const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;

function coerceHeaderString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const lastValue = value.at(-1);
    return typeof lastValue === 'string' ? lastValue : undefined;
  }
  return typeof value === 'string' ? value : undefined;
}

function sanitizeTraceValue(value: unknown, maxLen = 128): string | undefined {
  const raw = coerceHeaderString(value);
  if (!raw) return undefined;
  const trimmed = raw.replace(CONTROL_CHARS, '').trim();
  if (!trimmed) return undefined;
  return trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

/**
 * Extract the actor identity from standard HTTP headers.
 *
 * # Security
 * * **Sanitization**: Scrubs the header value before returning it to the application.
 */
export function extractActorId(
  headers: HeaderMap,
  candidates: string[] = DEFAULT_ACTOR_ID_HEADERS,
): string | undefined {
  const normalized: Record<string, HeaderMap[string]> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value;
  }
  for (const header of candidates) {
    const value = sanitizeTraceValue(normalized[header.toLowerCase()]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function traceContextFromHeaders(
  headers: HeaderMap,
  requestHeaders: string[] = DEFAULT_REQUEST_ID_HEADERS,
  actorHeaders: string[] = DEFAULT_ACTOR_ID_HEADERS,
): TraceContext {
  const context: TraceContext = {};
  const requestId = extractRequestId(headers, requestHeaders);
  const actorId = extractActorId(headers, actorHeaders);
  if (requestId !== undefined) {
    context.requestId = requestId;
  }
  if (actorId !== undefined) {
    context.actorId = actorId;
  }
  return context;
}

export function traceContextFromAuthInfo(authInfo?: AuthInfo): TraceContext {
  const extra = authInfo?.extra as Record<string, unknown> | undefined;
  const requestId = sanitizeTraceValue(extra?.request_id ?? extra?.requestId);
  const actorId = sanitizeTraceValue(
    extra?.actor_id ?? extra?.actor ?? extra?.subject ?? extra?.sub ?? extra?.preferred_username,
  );
  return {
    ...(requestId ? { requestId } : {}),
    ...(actorId ? { actorId } : {}),
  };
}

export function traceContextFromExtra(extra?: { authInfo?: AuthInfo }): TraceContext {
  return traceContextFromAuthInfo(extra?.authInfo);
}

export function mergeTraceContext(
  primary?: TraceContext,
  fallback?: TraceContext,
): TraceContext {
  const context: TraceContext = {};
  const requestId = primary?.requestId ?? fallback?.requestId;
  const actorId = primary?.actorId ?? fallback?.actorId;
  if (requestId !== undefined) {
    context.requestId = requestId;
  }
  if (actorId !== undefined) {
    context.actorId = actorId;
  }
  return context;
}

export function traceContextToLogFields(context: TraceContext): Record<string, string> {
  const fields: Record<string, string> = {};
  if (context.requestId) fields.request_id = context.requestId;
  if (context.actorId) fields.actor_id = context.actorId;
  return fields;
}

export function traceContextToEnv(
  context: TraceContext,
  prefix = 'MCP',
): Record<string, string> {
  const normalized = prefix.trim().toUpperCase() || 'MCP';
  const env: Record<string, string> = {};
  if (context.requestId) env[`${normalized}_REQUEST_ID`] = context.requestId;
  if (context.actorId) env[`${normalized}_ACTOR_ID`] = context.actorId;
  return env;
}

export function traceContextToDbSettings(
  context: TraceContext,
  namespace = 'mcp',
): Record<string, string> {
  const normalized = namespace.trim() || 'mcp';
  const settings: Record<string, string> = {};
  if (context.requestId) settings[`${normalized}.request_id`] = context.requestId;
  if (context.actorId) settings[`${normalized}.actor_id`] = context.actorId;
  return settings;
}
