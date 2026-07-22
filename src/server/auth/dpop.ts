import crypto from 'node:crypto';
import {
  calculateJwkThumbprint,
  decodeProtectedHeader,
  importJWK,
  jwtVerify,
  type JWK,
  type JWTPayload,
} from 'jose';
import { AuthError } from './errors.js';
import type { ReplayGuard } from './replay_guard.js';

export type DpopConfig = {
  required?: boolean;
  allowedAlgorithms?: string[];
  maxClockSkewSeconds?: number;
  requireAth?: boolean;
  replayGuard: ReplayGuard;
};

export type DpopRequest = {
  method: string;
  url: string;
  proof?: string;
  nonce?: string;
};

const DEFAULT_ALGORITHMS = ['ES256'];

function normalizeHtu(value: string): string {
  const url = new URL(value);
  const scheme = url.protocol.toLowerCase();
  const host = url.hostname.toLowerCase();
  const port = url.port;
  const defaultPort = scheme === 'https:' ? '443' : '80';
  const hostPort = port && port !== defaultPort ? `${host}:${port}` : host;
  return `${scheme}//${hostPort}${url.pathname}${url.search}`;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function requireString(value: unknown, reason: string, hint: string): string {
  const result = readString(value);
  if (!result) {
    throw new AuthError('Invalid DPoP proof.', {
      status: 401,
      code: 'auth.invalid_token',
      reason,
      hint,
    });
  }
  return result;
}

function tokenBindingJkt(claims: Record<string, unknown>): string | undefined {
  const cnf = (claims.cnf ?? {}) as Record<string, unknown>;
  return typeof cnf.jkt === 'string' ? cnf.jkt : undefined;
}

function hashAccessToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('base64url');
}

export async function verifyDpopProof(
  claims: Record<string, unknown>,
  accessToken: string,
  request: DpopRequest,
  config: DpopConfig,
): Promise<void> {
  const proof = request.proof;
  if (!proof) {
    if (config.required) {
      throw new AuthError('Missing DPoP proof.', {
        status: 401,
        code: 'auth.invalid_token',
        reason: 'dpop_missing_proof',
        hint: 'To fix this, include a DPoP header.',
      });
    }
    return;
  }

  const allowedAlgorithms = config.allowedAlgorithms ?? DEFAULT_ALGORITHMS;
  const header = decodeProtectedHeader(proof);
  const jwk = header.jwk as JWK | undefined;
  if (!jwk) {
    throw new AuthError('DPoP proof missing jwk.', {
      status: 401,
      code: 'auth.invalid_token',
      reason: 'dpop_missing_jwk',
      hint: 'To fix this, include a public JWK in the DPoP header.',
    });
  }
  if ('d' in jwk) {
    throw new AuthError('DPoP proof jwk must be public.', {
      status: 401,
      code: 'auth.invalid_token',
      reason: 'dpop_private_jwk',
      hint: 'To fix this, include only the public JWK in the DPoP header.',
    });
  }
  if (!header.alg) {
    throw new AuthError('DPoP proof missing alg.', {
      status: 401,
      code: 'auth.invalid_token',
      reason: 'dpop_missing_alg',
      hint: 'To fix this, include alg in the DPoP header.',
    });
  }
  if (!allowedAlgorithms.includes(header.alg)) {
    throw new AuthError('DPoP proof algorithm is not allowed.', {
      status: 401,
      code: 'auth.invalid_token',
      reason: 'dpop_alg_not_allowed',
      hint: 'To fix this, use an allowed DPoP algorithm.',
    });
  }
  const key = await importJWK(jwk, header.alg);
  const { payload, protectedHeader } = await jwtVerify(proof, key, {
    algorithms: allowedAlgorithms,
  });
  if (protectedHeader.typ && protectedHeader.typ.toLowerCase() !== 'dpop+jwt') {
    throw new AuthError('Invalid DPoP proof type.', {
      status: 401,
      code: 'auth.invalid_token',
      reason: 'dpop_invalid_typ',
      hint: 'To fix this, set typ to dpop+jwt.',
    });
  }

  const htm = requireString(payload.htm, 'dpop_missing_htm', 'To fix this, include htm in the DPoP proof.');
  const htu = requireString(payload.htu, 'dpop_missing_htu', 'To fix this, include htu in the DPoP proof.');
  const jti = requireString(payload.jti, 'dpop_missing_jti', 'To fix this, include jti in the DPoP proof.');
  const iatValue = payload.iat;
  if (typeof iatValue !== 'number') {
    throw new AuthError('DPoP proof missing iat.', {
      status: 401,
      code: 'auth.invalid_token',
      reason: 'dpop_missing_iat',
      hint: 'To fix this, include iat in the DPoP proof.',
    });
  }

  const requestMethod = request.method.toUpperCase();
  if (htm.toUpperCase() !== requestMethod) {
    throw new AuthError('DPoP proof method mismatch.', {
      status: 401,
      code: 'auth.invalid_token',
      reason: 'dpop_htm_mismatch',
      hint: 'To fix this, ensure the DPoP htm matches the request method.',
    });
  }

  const requestUrl = normalizeHtu(request.url);
  if (normalizeHtu(htu) !== requestUrl) {
    throw new AuthError('DPoP proof URL mismatch.', {
      status: 401,
      code: 'auth.invalid_token',
      reason: 'dpop_htu_mismatch',
      hint: 'To fix this, ensure the DPoP htu matches the request URL.',
    });
  }

  const now = Date.now() / 1000;
  const maxSkew = config.maxClockSkewSeconds ?? 300;
  if (iatValue > now + maxSkew || iatValue < now - maxSkew) {
    throw new AuthError('DPoP proof is outside the allowed time window.', {
      status: 401,
      code: 'auth.invalid_token',
      reason: 'dpop_iat_skew',
      hint: 'To fix this, ensure the DPoP iat is within the server time window.',
    });
  }

  if (config.replayGuard.seen(jti)) {
    throw new AuthError('DPoP proof replay detected.', {
      status: 401,
      code: 'auth.replay_detected',
      reason: 'dpop_replay',
      hint: 'To fix this, use a fresh DPoP proof.',
    });
  }

  if (request.nonce && payload.nonce !== request.nonce) {
    throw new AuthError('DPoP proof nonce mismatch.', {
      status: 401,
      code: 'auth.invalid_token',
      reason: 'dpop_nonce_mismatch',
      hint: 'To fix this, include the provided DPoP nonce.',
    });
  }

  const jkt = tokenBindingJkt(claims);
  if (!jkt) {
    throw new AuthError('Token missing DPoP binding.', {
      status: 401,
      code: 'auth.invalid_token',
      reason: 'dpop_missing_cnf',
      hint: 'To fix this, request a DPoP-bound access token.',
    });
  }

  const thumbprint = await calculateJwkThumbprint(jwk);
  if (thumbprint !== jkt) {
    throw new AuthError('DPoP key mismatch.', {
      status: 401,
      code: 'auth.invalid_token',
      reason: 'dpop_jkt_mismatch',
      hint: 'To fix this, use the key bound to the access token.',
    });
  }

  const ath = readString(payload.ath);
  if (config.requireAth ?? true) {
    if (!ath) {
      throw new AuthError('DPoP proof missing ath.', {
        status: 401,
        code: 'auth.invalid_token',
        reason: 'dpop_missing_ath',
        hint: 'To fix this, include the access token hash in ath.',
      });
    }
  }
  if (ath) {
    const expectedAth = await hashAccessToken(accessToken);
    if (ath !== expectedAth) {
      throw new AuthError('DPoP proof access token hash mismatch.', {
        status: 401,
        code: 'auth.invalid_token',
        reason: 'dpop_ath_mismatch',
        hint: 'To fix this, ensure ath matches the access token.',
      });
    }
  }
}
