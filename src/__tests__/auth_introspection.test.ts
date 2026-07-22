import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthConfig } from '../server/auth/validator.js';
import { authenticateToken } from '../server/auth/validator.js';

const fetchMock = vi.fn();

afterEach(() => {
  fetchMock.mockReset();
});

function responseWith(payload: Record<string, unknown>) {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

describe('authenticateToken introspection', () => {
  it('accepts active tokens and filters claims', async () => {
    fetchMock.mockResolvedValue(
      responseWith({
        active: true,
        sub: 'user-1',
        scope: 'ops:read',
        client_id: 'client-1',
        aud: 'mcp-toolkit',
        exp: 123,
        custom: 'nope',
      }),
    );

    const config: AuthConfig = {
      mode: 'introspection',
      audience: 'mcp-toolkit',
      introspection: {
        url: 'https://issuer.test/introspect',
        clientId: 'mcp',
        clientSecret: 'secret',
        fetch: fetchMock as unknown as typeof fetch,
      },
    };

    const ctx = await authenticateToken('token', config);
    expect(ctx.subject).toBe('user-1');
    expect(ctx.scopes).toEqual(['ops:read']);
    expect(ctx.tokenClaims.get('aud')).toBe('mcp-toolkit');
    expect(ctx.tokenClaims.get('client_id')).toBe('client-1');
    expect(ctx.tokenClaims.get('exp')).toBe(123);
    expect(ctx.tokenClaims.get('iss')).toBeUndefined();
  });

  it('rejects inactive tokens', async () => {
    fetchMock.mockResolvedValue(
      responseWith({
        active: false,
        sub: 'user-1',
      }),
    );

    const config: AuthConfig = {
      mode: 'introspection',
      introspection: {
        url: 'https://issuer.test/introspect',
        clientId: 'mcp',
        clientSecret: 'secret',
        fetch: fetchMock as unknown as typeof fetch,
      },
    };

    await expect(authenticateToken('token', config)).rejects.toMatchObject({
      code: 'auth.invalid_token',
      reason: 'inactive_token',
    });
  });
});
