import { describe, expect, it, vi } from 'vitest';
import { exchangeAccessToken, exchangeToken } from '../server/auth/token_exchange.js';

describe('token exchange', () => {
  it('posts RFC8693 parameters and returns access token', async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = init.body as URLSearchParams;
      expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:token-exchange');
      expect(body.get('subject_token')).toBe('subject');
      expect(body.get('subject_token_type')).toBe(
        'urn:ietf:params:oauth:token-type:access_token',
      );
      expect(body.get('audience')).toBe('aud');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ access_token: 'exchanged', token_type: 'Bearer' }),
      } as Response;
    });

    const result = await exchangeToken(
      {
        tokenEndpoint: 'https://issuer.test/token',
        clientId: 'client',
        clientSecret: 'secret',
        fetch: fetchMock as unknown as typeof fetch,
      },
      {
        subjectToken: 'subject',
        audience: 'aud',
      },
    );
    expect(result.access_token).toBe('exchanged');
  });

  it('requires audience or resource by default', async () => {
    const fetchMock = vi.fn();
    await expect(
      exchangeAccessToken(
        {
          tokenEndpoint: 'https://issuer.test/token',
          clientId: 'client',
          clientSecret: 'secret',
          fetch: fetchMock as unknown as typeof fetch,
        },
        {
          subjectToken: 'subject',
        },
      ),
    ).rejects.toMatchObject({ code: 'auth.exchange_invalid_request' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects refresh tokens unless allowed', async () => {
    const fetchMock = vi.fn(async () => {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ access_token: 'exchanged', refresh_token: 'unexpected' }),
      } as Response;
    });

    await expect(
      exchangeAccessToken(
        {
          tokenEndpoint: 'https://issuer.test/token',
          clientId: 'client',
          clientSecret: 'secret',
          fetch: fetchMock as unknown as typeof fetch,
        },
        {
          subjectToken: 'subject',
          audience: 'aud',
        },
      ),
    ).rejects.toMatchObject({ code: 'auth.exchange_invalid_response' });
  });
});
