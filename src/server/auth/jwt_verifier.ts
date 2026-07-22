import {
  createRemoteJWKSet,
  jwtVerify,
  errors as joseErrors,
  type JWTPayload,
  type RemoteJWKSetOptions,
} from 'jose';
import { AuthError } from './errors.js';

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(url: string): ReturnType<typeof createRemoteJWKSet> {
  const cached = jwksCache.get(url);
  if (cached) return cached;
  const jwks = createRemoteJWKSet(new URL(url), {
    cooldownDuration: 5_000,
    timeoutDuration: 5_000,
  } satisfies RemoteJWKSetOptions);
  jwksCache.set(url, jwks);
  return jwks;
}

function reasonFromJwtError(err: unknown): string {
  if (err instanceof joseErrors.JWTExpired) {
    return 'expired';
  }
  if (err instanceof joseErrors.JWTClaimValidationFailed) {
    const claim = (err as joseErrors.JWTClaimValidationFailed & { claim?: string }).claim;
    if (claim === 'aud') return 'aud_mismatch';
    if (claim === 'iss') return 'iss_mismatch';
    if (claim === 'exp') return 'expired';
    if (claim === 'nbf') return 'not_before';
    return 'claim_invalid';
  }
  if (err instanceof joseErrors.JWSSignatureVerificationFailed) {
    return 'invalid_signature';
  }
  if (err instanceof joseErrors.JWTInvalid) {
    return 'invalid_token';
  }
  return 'invalid_token';
}

function hintFromJwtReason(reason: string): string {
  if (reason === 'expired') {
    return 'To fix this, refresh the access token and retry.';
  }
  if (reason === 'aud_mismatch' || reason === 'iss_mismatch') {
    return 'To fix this, check the configured issuer/audience for the server.';
  }
  if (reason === 'invalid_signature') {
    return 'To fix this, verify the token is signed by the expected issuer.';
  }
  return 'To fix this, verify the token is valid and re-authenticate.';
}

export async function verifyJwtToken(
  token: string,
  options: {
    jwksUrl: string;
    issuer: string;
    audience: string;
    clockSkewSeconds?: number;
  },
): Promise<{ payload: JWTPayload; headerTyp?: string }> {
  const jwks = getJwks(options.jwksUrl);
  try {
    const result = await jwtVerify(token, jwks, {
      issuer: options.issuer,
      audience: options.audience,
      ...(options.clockSkewSeconds !== undefined
        ? { clockTolerance: options.clockSkewSeconds }
        : {}),
    });
    const headerTyp =
      typeof result.protectedHeader.typ === 'string' ? result.protectedHeader.typ : undefined;
    return {
      payload: result.payload,
      ...(headerTyp !== undefined ? { headerTyp } : {}),
    };
  } catch (err) {
    const reason = reasonFromJwtError(err);
    throw new AuthError('Invalid bearer token.', {
      status: 401,
      code: 'auth.invalid_token',
      reason,
      hint: hintFromJwtReason(reason),
    });
  }
}
