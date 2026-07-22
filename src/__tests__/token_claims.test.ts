import { describe, expect, it } from 'vitest';
import { NonAuthoritativeClaims } from '../server/auth/token_claims.js';

describe('NonAuthoritativeClaims', () => {
  it('filters to allow-listed claims only', () => {
    const claims = NonAuthoritativeClaims.fromRaw({
      sub: 'user-1',
      aud: ['mcp-toolkit', 'other'],
      client_id: 'client-1',
      exp: 123,
      scope: 'ops:read',
      custom: 'ignored',
    });

    expect(claims.get('aud')).toEqual(['mcp-toolkit', 'other']);
    expect(claims.get('client_id')).toBe('client-1');
    expect(claims.get('exp')).toBe(123);
    expect(claims.get('iss')).toBeUndefined();
    expect(JSON.parse(JSON.stringify(claims))).toEqual({
      aud: ['mcp-toolkit', 'other'],
      client_id: 'client-1',
      exp: 123,
    });
  });
});
