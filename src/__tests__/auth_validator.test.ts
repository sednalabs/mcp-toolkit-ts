import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JWTPayload } from 'jose';
import { ReplayGuard } from '../server/auth/replay_guard.js';
import type { AuthConfig } from '../server/auth/validator.js';

const jwtVerifyMock = vi.hoisted(() => vi.fn());
const createRemoteJWKSetMock = vi.hoisted(() => vi.fn(() => ({})));

vi.mock('jose', () => ({
  createRemoteJWKSet: createRemoteJWKSetMock,
  jwtVerify: jwtVerifyMock,
  errors: {
    JWTExpired: class JWTExpired extends Error {},
    JWTClaimValidationFailed: class JWTClaimValidationFailed extends Error {
      claim?: string;
    },
    JWSSignatureVerificationFailed: class JWSSignatureVerificationFailed extends Error {},
    JWTInvalid: class JWTInvalid extends Error {},
  },
}));

const { authenticateToken, AuthError } = await import('../server/auth/validator.js');

const baseConfig: AuthConfig = {
  jwksUrl: 'https://example.test/jwks',
  issuer: 'https://issuer.test',
  audience: 'mcp-toolkit',
};

function payload(overrides: Partial<JWTPayload> = {}): JWTPayload {
  return {
    sub: 'user-1',
    aud: 'mcp-toolkit',
    scope: 'ops:read',
    ...overrides,
  };
}

beforeEach(() => {
  jwtVerifyMock.mockReset();
});

describe('authenticateToken replay guard', () => {
  it('does not require jti when no replay guard is configured', async () => {
    jwtVerifyMock.mockResolvedValue({
      payload: payload(),
      protectedHeader: {},
    });

    const ctx = await authenticateToken('token', baseConfig);
    expect(ctx.subject).toBe('user-1');
  });

  it('requires jti when replay guard is configured', async () => {
    jwtVerifyMock.mockResolvedValue({
      payload: payload(),
      protectedHeader: {},
    });

    const guard = new ReplayGuard({ ttlSeconds: 10, maxEntries: 100 });
    await expect(
      authenticateToken('token', { ...baseConfig, replayGuard: guard }),
    ).rejects.toMatchObject({
      code: 'auth.invalid_token',
      reason: 'missing_jti',
      hint: expect.stringContaining('jti'),
    });
  });

  it('rejects replayed jti values', async () => {
    jwtVerifyMock.mockResolvedValue({
      payload: payload({ jti: 'jti-1' }),
      protectedHeader: {},
    });

    const guard = new ReplayGuard({ ttlSeconds: 10, maxEntries: 100 });
    const first = await authenticateToken('token', { ...baseConfig, replayGuard: guard });
    expect(first.subject).toBe('user-1');

    await expect(
      authenticateToken('token', { ...baseConfig, replayGuard: guard }),
    ).rejects.toMatchObject({
      code: 'auth.replay_detected',
      reason: 'replay_detected',
      hint: expect.stringContaining('fresh token'),
    });
  });
});
