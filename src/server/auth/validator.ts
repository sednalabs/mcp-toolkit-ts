/**
 * # Server Auth Validator
 *
 * Token validation and identity extraction for MCP servers.
 *
 * ## Rationale
 * Centralizes the logic for verifying inbound bearer tokens using either local
 * JWKS verification or remote introspection. It ensures that the produced
 * `AuthContext` is trustworthy and contains the necessary actor metadata.
 *
 * ## Security Boundaries
 * * **Untrusted Input**: All HTTP headers are treated as untrusted until validated.
 * * **Fail-Closed**: Any failure in JWT verification or introspection result in an `AuthError`.
 * * **Replay Guard**: Optional JTI tracking to prevent token reuse.
 */

import type { ReplayGuard } from './replay_guard.js';
import { AuthError } from './errors.js';
import type { IntrospectionConfig } from './introspection.js';
import { NonAuthoritativeClaims } from './token_claims.js';
import {
  verifySenderConstraints,
  type SenderConstraintConfig,
  type SenderConstraintRequest,
} from './sender_constraints.js';
import {
  checkTokenType,
  ensureAudience,
  ensureIssuer,
  isClientAllowed,
  requireConfigValue,
  resolveMode,
} from './auth_rules.js';
import {
  extractRoles,
  extractScopes,
  readClientId,
  readSubject,
  readString,
  readTokenType,
} from './claims.js';
import { introspectToken } from './introspection_flow.js';
import { verifyJwtToken } from './jwt_verifier.js';

export { extractRoles, extractScopes } from './claims.js';
export { checkTokenType, isClientAllowed, isTokenTypeAllowed } from './auth_rules.js';

export type AuthContext = {
  clientId: string;
  scopes: string[];
  roles: string[];
  subject: string;
  expiresAt?: number;
  tokenClaims: NonAuthoritativeClaims;
};

export type AuthConfig = {
  mode?: 'jwks' | 'introspection';
  jwksUrl?: string;
  issuer?: string;
  audience?: string;
  clockSkewSeconds?: number;
  allowedClientIds?: string[];
  strictTokenType?: boolean;
  replayGuard?: ReplayGuard;
  introspection?: IntrospectionConfig;
  senderConstraints?: SenderConstraintConfig;
  request?: SenderConstraintRequest;
};

export { AuthError } from './errors.js';

const bearerRegex = /^Bearer\s+(.+)$/i;

/**
 * Extract the Bearer token from the Authorization header.
 *
 * # Security
 * * **Strict Parsing**: Rejects malformed or multiple Authorization headers.
 */
export function extractBearerToken(
  headers: Record<string, string | string[] | undefined>,
): string | null {
  // Normalize headers.
  const normalized: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(headers)) {
    normalized[key.toLowerCase()] = value;
  }

  const rawHeader = normalized['authorization'];
  const header = Array.isArray(rawHeader) ? (rawHeader[0] ?? '') : (rawHeader ?? '');
  const match = bearerRegex.exec(header);
  if (!match) return null;
  return match[1] ?? null;
}

/**
 * Authenticates a token against the provided configuration.
 *
 * # Errors
 * * `AuthError` if the token is missing, expired, invalid, or client not allowed.
 *
 * # Security
 * * **Mode Selection**: Dynamically switches between `introspection` and `jwks` based on config.
 * * **Sender Constraints**: Validates DPoP or mTLS bindings if configured.
 * * **Replay Protection**: Checks JTI against the `replayGuard` if provided.
 */
export async function authenticateToken(token: string, config: AuthConfig): Promise<AuthContext> {
  const mode = resolveMode(config);
  if (mode === 'introspection') {
    const introspectionConfig = requireConfigValue(
      config.introspection,
      'introspection',
      'Configure introspection settings or switch to jwks mode.',
    );
    const response = await introspectToken(token, introspectionConfig);

    ensureAudience(response, config.audience);
    ensureIssuer(response, config.issuer);

    const tokenType = readTokenType(response);
    const typeCheck = checkTokenType(tokenType, config.strictTokenType ?? false);
    if (!typeCheck.allowed) {
      throw new AuthError('Invalid token type.', {
        status: 401,
        code: 'auth.invalid_token',
        reason: typeCheck.reason ?? 'token_type_invalid',
        hint: 'To fix this, use Bearer/at+jwt tokens or disable strict token type enforcement.',
      });
    }

    const subject = readSubject(response);
    if (!subject) {
      throw new AuthError('Token missing subject.', {
        status: 401,
        code: 'auth.invalid_token',
        reason: 'missing_subject',
        hint: 'To fix this, ensure the token includes a non-empty subject (sub) claim.',
      });
    }

    if (config.replayGuard) {
      const jti = readString(response.jti) ?? '';
      if (!jti) {
        throw new AuthError('Token missing jti.', {
          status: 401,
          code: 'auth.invalid_token',
          reason: 'missing_jti',
          hint: 'To fix this, include a unique jti claim or disable replay protection.',
        });
      }
      if (config.replayGuard.seen(jti)) {
        throw new AuthError('Token replay detected.', {
          status: 401,
          code: 'auth.replay_detected',
          reason: 'replay_detected',
          hint: 'To fix this, request a fresh token with a new jti.',
        });
      }
    }

    const clientId = readClientId(response);
    if (!isClientAllowed(clientId, config.allowedClientIds)) {
      throw new AuthError('Token client is not allowed.', {
        status: 403,
        code: 'auth.client_not_allowed',
        reason: 'client_not_allowed',
        hint: 'To fix this, use an allowed client_id or update the allowlist.',
      });
    }

    await verifySenderConstraints(response, token, config.senderConstraints, config.request);
    const scopes = extractScopes(response);
    const roles = extractRoles(response);
    const ctx: AuthContext = {
      clientId,
      scopes,
      roles,
      subject,
      tokenClaims: NonAuthoritativeClaims.fromRaw(response),
    };
    const exp = typeof response.exp === 'number' ? response.exp : undefined;
    if (exp !== undefined) {
      ctx.expiresAt = exp;
    }
    return ctx;
  }

  const jwksUrl = requireConfigValue(
    config.jwksUrl,
    'jwks_url',
    'Configure a JWKS URL or switch to introspection mode.',
  );
  const issuer = requireConfigValue(
    config.issuer,
    'issuer',
    'Configure a JWT issuer or switch to introspection mode.',
  );
  const audience = requireConfigValue(
    config.audience,
    'audience',
    'Configure a JWT audience or switch to introspection mode.',
  );

  const { payload, headerTyp } = await verifyJwtToken(token, {
    jwksUrl,
    issuer,
    audience,
    ...(config.clockSkewSeconds !== undefined ? { clockSkewSeconds: config.clockSkewSeconds } : {}),
  });

  const tokenType = readTokenType(payload as Record<string, unknown>, headerTyp);
  const typeCheck = checkTokenType(tokenType, config.strictTokenType ?? false);
  if (!typeCheck.allowed) {
    throw new AuthError('Invalid token type.', {
      status: 401,
      code: 'auth.invalid_token',
      reason: typeCheck.reason ?? 'token_type_invalid',
      hint: 'To fix this, use Bearer/at+jwt tokens or disable strict token type enforcement.',
    });
  }

  const subject = readSubject(payload as Record<string, unknown>);
  if (!subject) {
    throw new AuthError('Token missing subject.', {
      status: 401,
      code: 'auth.invalid_token',
      reason: 'missing_subject',
      hint: 'To fix this, ensure the token includes a non-empty subject (sub) claim.',
    });
  }

  if (config.replayGuard) {
    const jti = readString(payload.jti) ?? '';
    if (!jti) {
      throw new AuthError('Token missing jti.', {
        status: 401,
        code: 'auth.invalid_token',
        reason: 'missing_jti',
        hint: 'To fix this, include a unique jti claim or disable replay protection.',
      });
    }
    if (config.replayGuard.seen(jti)) {
      throw new AuthError('Token replay detected.', {
        status: 401,
        code: 'auth.replay_detected',
        reason: 'replay_detected',
        hint: 'To fix this, request a fresh token with a new jti.',
      });
    }
  }

  await verifySenderConstraints(payload as Record<string, unknown>, token, config.senderConstraints, config.request);
  const scopes = extractScopes(payload as Record<string, unknown>);
  const roles = extractRoles(payload as Record<string, unknown>);
  const clientId = readClientId(payload as Record<string, unknown>);

  if (!isClientAllowed(clientId, config.allowedClientIds)) {
    throw new AuthError('Token client is not allowed.', {
      status: 403,
      code: 'auth.client_not_allowed',
      reason: 'client_not_allowed',
      hint: 'To fix this, use an allowed client_id or update the allowlist.',
    });
  }

  const ctx: AuthContext = {
    clientId,
    scopes,
    roles,
    subject,
    tokenClaims: NonAuthoritativeClaims.fromRaw(payload as Record<string, unknown>),
  };
  if (payload.exp !== undefined) {
    ctx.expiresAt = payload.exp;
  }
  return ctx;
}
