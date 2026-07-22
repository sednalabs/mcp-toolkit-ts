import { AuthError } from './errors.js';
import { normalizeAudience, readString } from './claims.js';

const ALLOWED_TOKEN_TYPES = new Set(['bearer', 'at+jwt', 'jwt']);

export function isClientAllowed(clientId: string, allowedClientIds: string[] = []): boolean {
  if (allowedClientIds.length === 0) return true;
  return allowedClientIds.includes(clientId);
}

export function isTokenTypeAllowed(value?: string | null): boolean {
  if (!value) return true;
  return ALLOWED_TOKEN_TYPES.has(value.toLowerCase());
}

export function checkTokenType(
  value: string | undefined,
  strict: boolean,
): { allowed: boolean; reason?: string } {
  if (!value) {
    return strict ? { allowed: false, reason: 'token_type_missing' } : { allowed: true };
  }
  if (!isTokenTypeAllowed(value)) {
    return { allowed: false, reason: 'token_type_invalid' };
  }
  return { allowed: true };
}

export function resolveMode(config: {
  mode?: 'jwks' | 'introspection';
  introspection?: unknown;
}): 'jwks' | 'introspection' {
  if (config.mode) return config.mode;
  if (config.introspection) return 'introspection';
  return 'jwks';
}

export function requireConfigValue<T>(
  value: T | undefined,
  name: string,
  hint: string,
): T {
  if (value !== undefined) return value;
  throw new AuthError('Auth server is misconfigured.', {
    status: 500,
    code: 'auth.misconfigured',
    reason: `missing_${name}`,
    hint,
  });
}

export function ensureAudience(payload: Record<string, unknown>, audience?: string): void {
  if (!audience) return;
  const aud = normalizeAudience(payload.aud);
  if (!aud.includes(audience)) {
    throw new AuthError('Invalid bearer token.', {
      status: 401,
      code: 'auth.invalid_token',
      reason: aud.length === 0 ? 'aud_missing' : 'aud_mismatch',
      hint: 'To fix this, request a token with the correct audience.',
    });
  }
}

export function ensureIssuer(payload: Record<string, unknown>, issuer?: string): void {
  if (!issuer) return;
  const iss = readString(payload.iss);
  if (!iss || iss !== issuer) {
    throw new AuthError('Invalid bearer token.', {
      status: 401,
      code: 'auth.invalid_token',
      reason: iss ? 'iss_mismatch' : 'iss_missing',
      hint: 'To fix this, request a token from the correct issuer.',
    });
  }
}
