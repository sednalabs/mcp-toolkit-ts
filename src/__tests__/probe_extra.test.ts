import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import {
  runAuthDiscovery,
  runHttpSmoke,
  runProbeHandshake,
  runRawRequest,
} from '../client/probe/runner.js';

const fixturePath = path.resolve('tests/fixtures/fake_server.mjs');
let priorAllowStdio: string | undefined;

beforeAll(() => {
  priorAllowStdio = process.env.MCP_PROBE_ALLOW_STDIO;
  process.env.MCP_PROBE_ALLOW_STDIO = '1';
});

afterAll(() => {
  if (priorAllowStdio === undefined) {
    delete process.env.MCP_PROBE_ALLOW_STDIO;
  } else {
    process.env.MCP_PROBE_ALLOW_STDIO = priorAllowStdio;
  }
});

type AuthServerFixture = {
  baseUrl: string;
  close: () => Promise<void>;
};

async function startAuthFixtureServer(): Promise<AuthServerFixture> {
  let resolveReady: (value: AuthServerFixture) => void = () => undefined;
  const ready = new Promise<AuthServerFixture>((resolve) => {
    resolveReady = resolve;
  });

  const server: Server = createServer((req, res) => {
    const host = req.headers.host ?? '127.0.0.1';
    const url = new URL(req.url ?? '/', `http://${host}`);
    const baseUrl = `http://${host}`;

    if (url.pathname === '/mcp-unquoted') {
      res.statusCode = 401;
      res.setHeader(
        'WWW-Authenticate',
        `Bearer resource_metadata=${baseUrl}/.well-known/oauth-protected-resource`,
      );
      res.end('unauthorized');
      return;
    }

    if (url.pathname === '/mcp') {
      res.statusCode = 401;
      res.setHeader(
        'WWW-Authenticate',
        `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource"`,
      );
      res.end('unauthorized');
      return;
    }

    if (url.pathname === '/.well-known/oauth-protected-resource') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          resource: `${baseUrl}/mcp`,
          authorization_servers: [`${baseUrl}/oauth`],
        }),
      );
      return;
    }

    if (url.pathname === '/oauth/.well-known/openid-configuration') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          issuer: `${baseUrl}/oauth`,
          authorization_endpoint: `${baseUrl}/oauth/auth`,
          token_endpoint: `${baseUrl}/oauth/token`,
        }),
      );
      return;
    }

    res.statusCode = 404;
    res.end('not found');
  });

  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Failed to bind auth fixture server.');
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

describe('runProbeHandshake', () => {
  it('returns expected steps for stdio handshake', async () => {
    const report = await runProbeHandshake({
      transportType: 'stdio',
      command: process.execPath,
      args: [fixturePath],
      timeoutMs: 5000,
    });

    expect(report.ok).toBe(true);
    expect(report.steps.map((step) => step.name)).toEqual([
      'stdio.allowlist',
      'host.allowlist',
      'auth.prm',
      'connect',
      'server.info',
      'capabilities',
      'ping',
      'tools.list',
    ]);
  });
});

describe('runRawRequest', () => {
  it('returns tool list for raw request', async () => {
    const report = await runRawRequest({
      transportType: 'stdio',
      command: process.execPath,
      args: [fixturePath],
      method: 'tools/list',
      timeoutMs: 5000,
    });

    expect(report.ok).toBe(true);
    const tools = (report.result as { tools?: { name: string }[] }).tools ?? [];
    expect(tools.map((tool) => tool.name)).toContain('ping');
  });

  it('omits null params safely', async () => {
    const report = await runRawRequest({
      transportType: 'stdio',
      command: process.execPath,
      args: [fixturePath],
      method: 'tools/list',
      params: null,
      timeoutMs: 5000,
    });

    expect(report.ok).toBe(true);
  });

  it('captures structured server errors', async () => {
    const report = await runRawRequest({
      transportType: 'stdio',
      command: process.execPath,
      args: [fixturePath],
      method: 'probe/fail',
      expectError: true,
      timeoutMs: 5000,
    });

    const step = report.steps.find((entry) => entry.name === 'request:probe/fail');
    expect(step?.status).toBe('ok');
    expect(step?.data).toMatchObject({
      code: -32603,
      data: { reason: 'boom' },
    });
  });

  it('redacts sensitive values in trace output', async () => {
    const ghToken = `ghp_${'a'.repeat(36)}`;
    const report = await runRawRequest({
      transportType: 'stdio',
      command: process.execPath,
      args: [fixturePath],
      method: 'probe/fail',
      params: {
        note: `Bearer secret-token github_pat=${ghToken} access_token=topsecret postgresql://user:pass@host/db`,
      },
      trace: true,
      expectError: true,
      timeoutMs: 5000,
    });

    const traceText = JSON.stringify(report.trace ?? []);
    expect(traceText).not.toContain('secret-token');
    expect(traceText).not.toContain(ghToken);
    expect(traceText).not.toContain('postgresql://user:pass@host/db');
    expect(traceText).toContain('Bearer REDACTED');
    expect(traceText).toContain('github_pat=REDACTED');
    expect(traceText).toContain('access_token=REDACTED');
    expect(traceText).toContain('postgresql://REDACTED');
  });
});

describe('auth discovery helpers', () => {
  let fixture: AuthServerFixture | undefined;

  beforeAll(async () => {
    fixture = await startAuthFixtureServer();
  });

  afterAll(async () => {
    if (fixture) {
      await fixture.close();
    }
  });

  it('discovers auth metadata for HTTP targets', async () => {
    if (!fixture) {
      throw new Error('Auth fixture not initialized.');
    }

    const report = await runAuthDiscovery({
      url: `${fixture.baseUrl}/mcp`,
      timeoutMs: 2000,
    });

    expect(report.ok).toBe(true);
    expect(report.auth?.resource_metadata_url).toContain('/.well-known/oauth-protected-resource');
    expect(report.auth?.oauth_metadata_url).toContain('/.well-known/openid-configuration');
  });

  it('parses unquoted resource_metadata values', async () => {
    if (!fixture) {
      throw new Error('Auth fixture not initialized.');
    }

    const report = await runAuthDiscovery({
      url: `${fixture.baseUrl}/mcp-unquoted`,
      timeoutMs: 2000,
    });

    expect(report.ok).toBe(true);
    expect(report.auth?.resource_metadata_url).toContain('/.well-known/oauth-protected-resource');
  });

  it('runs HTTP smoke checks for auth metadata', async () => {
    if (!fixture) {
      throw new Error('Auth fixture not initialized.');
    }

    const report = await runHttpSmoke({
      url: `${fixture.baseUrl}/mcp`,
      timeoutMs: 2000,
    });

    expect(report.ok).toBe(true);
    const stepNames = report.steps.map((step) => step.name);
    expect(stepNames).toContain('http.get');
    expect(stepNames).toContain('auth.prm');
    expect(stepNames).toContain('auth.prm.fetch');
    expect(stepNames).toContain('auth.oauth.fetch');
  });
});
