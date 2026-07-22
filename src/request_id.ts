import { randomUUID } from 'node:crypto';

export const DEFAULT_REQUEST_ID_HEADERS = [
  'x-request-id',
  'x-trace-id',
  'trace-id',
  'traceparent',
];

export type HeaderValue = string | string[] | undefined;
export type HeaderMap = Record<string, HeaderValue>;

function normalizeHeaderValue(value: HeaderValue): string | undefined {
  if (Array.isArray(value)) {
    const lastValue = value.at(-1);
    return lastValue?.trim() || undefined;
  }
  if (typeof value === 'string') {
    return value.trim() || undefined;
  }
  return undefined;
}

export function extractRequestId(
  headers: HeaderMap,
  candidates: string[] = DEFAULT_REQUEST_ID_HEADERS,
): string | undefined {
  const normalized: Record<string, HeaderValue> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value;
  }
  for (const header of candidates) {
    const value = normalizeHeaderValue(normalized[header.toLowerCase()]);
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function ensureRequestId(
  headers: HeaderMap,
  candidates: string[] = DEFAULT_REQUEST_ID_HEADERS,
  generator: () => string = randomUUID,
): string {
  return extractRequestId(headers, candidates) ?? generator();
}

export function attachRequestId(
  setter: (name: string, value: string) => void,
  requestId: string,
): void {
  setter('x-request-id', requestId);
}
