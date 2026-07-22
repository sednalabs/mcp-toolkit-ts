import { createServer, type Server } from 'node:http';

export type CallbackResult = {
  code: string;
  state?: string;
  error?: string;
  errorDescription?: string;
};

export async function startCallbackServer(
  redirectHost: string,
  redirectPort: number,
  expectedState: string,
): Promise<{ server: Server; result: Promise<CallbackResult> }> {
  let resolveResult: (value: CallbackResult) => void = () => undefined;
  const result = new Promise<CallbackResult>((resolve) => {
    resolveResult = resolve;
  });

  const server = createServer((req, res) => {
    if (!req.url) {
      res.statusCode = 400;
      res.end('Invalid request');
      return;
    }
    const url = new URL(req.url, `http://${redirectHost}:${redirectPort}`);
    if (!url.pathname.startsWith('/oauth/callback')) {
      res.statusCode = 404;
      res.end('Not found');
      return;
    }
    const code = url.searchParams.get('code') ?? '';
    const state = url.searchParams.get('state') ?? undefined;
    const error = url.searchParams.get('error') ?? undefined;
    const errorDescription = url.searchParams.get('error_description') ?? undefined;
    const payload: CallbackResult = {
      code,
      ...(state !== undefined ? { state } : {}),
      ...(error !== undefined ? { error } : {}),
      ...(errorDescription !== undefined ? { errorDescription } : {}),
    };
    if (payload.state && payload.state !== expectedState) {
      res.statusCode = 400;
      res.end('Invalid state');
      resolveResult({ ...payload, error: 'invalid_state' });
      return;
    }
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/plain');
    res.end('Authorization complete. You can close this window.');
    resolveResult(payload);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(redirectPort, redirectHost, () => resolve());
  });

  return { server, result };
}
