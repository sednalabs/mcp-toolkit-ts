import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { refreshAccessToken } from '../client/auth/refresh.js';

type TokenServerFixture = {
  baseUrl: string;
  close: () => Promise<void>;
};

async function startTokenServer(): Promise<TokenServerFixture> {
  let resolveReady: (value: TokenServerFixture) => void = () => undefined;
  const ready = new Promise<TokenServerFixture>((resolve) => {
    resolveReady = resolve;
  });

  const server: Server = createServer((req, res) => {
    const host = req.headers.host ?? '127.0.0.1';
    const url = new URL(req.url ?? '/', `http://${host}`);
    if (url.pathname !== '/oauth/token') {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const grantType = params.get('grant_type');
      const refreshToken = params.get('refresh_token');
      const clientId = params.get('client_id');
      if (grantType !== 'refresh_token' || !refreshToken || !clientId) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'invalid_request' }));
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          access_token: `access-${refreshToken}-${clientId}`,
          token_type: 'Bearer',
          expires_in: 3600,
        }),
      );
    });
  });

  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to bind token server.');
    }
    const baseUrl = `http://127.0.0.1:${address.port}`;
    resolveReady({
      baseUrl,
      close: () =>
        new Promise<void>((resolve, reject) => {
          server.close((err) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
        }),
    });
  });

  return ready;
}

describe('refreshAccessToken', () => {
  let fixture: TokenServerFixture | undefined;

  beforeAll(async () => {
    fixture = await startTokenServer();
  });

  afterAll(async () => {
    if (fixture) {
      await fixture.close();
    }
  });

  it('refreshes access tokens via token endpoint', async () => {
    if (!fixture) {
      throw new Error('Token server not initialized.');
    }
    const result = await refreshAccessToken({
      refreshToken: 'refresh-token',
      clientId: 'client-id',
      tokenEndpoint: `${fixture.baseUrl}/oauth/token`,
      timeoutMs: 2000,
    });

    expect(result.access_token).toBe('access-refresh-token-client-id');
    expect(result.token_type).toBe('Bearer');
    expect(result.expires_in).toBe(3600);
  });
});
