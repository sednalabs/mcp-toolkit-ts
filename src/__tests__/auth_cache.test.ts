import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { readAccessTokenFromPath, readRefreshTokenFromPath } from '../client/auth/cache.js';

let tokenDir: string;
let otherDir: string;
const originalTokenDir = process.env.MCP_PROBE_TOKEN_DIR;

async function makeTempDir(prefix: string): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), prefix));
}

beforeEach(async () => {
  tokenDir = await makeTempDir('mcp-probe-token-');
  otherDir = await makeTempDir('mcp-probe-other-');
  process.env.MCP_PROBE_TOKEN_DIR = tokenDir;
});

afterEach(async () => {
  if (tokenDir) {
    await rm(tokenDir, { recursive: true, force: true });
  }
  if (otherDir) {
    await rm(otherDir, { recursive: true, force: true });
  }
  if (originalTokenDir === undefined) {
    delete process.env.MCP_PROBE_TOKEN_DIR;
  } else {
    process.env.MCP_PROBE_TOKEN_DIR = originalTokenDir;
  }
});

describe('readAccessTokenFromPath', () => {
  it('reads a raw token file', async () => {
    const tokenPath = path.join(tokenDir, 'token.txt');
    await writeFile(tokenPath, ' raw-token \n', 'utf8');

    const token = await readAccessTokenFromPath('token.txt');
    expect(token).toBe('raw-token');
  });

  it('reads a JSON token file', async () => {
    const tokenPath = path.join(tokenDir, 'token.json');
    await writeFile(tokenPath, JSON.stringify({ access_token: 'json-token' }), 'utf8');

    const token = await readAccessTokenFromPath(tokenPath);
    expect(token).toBe('json-token');
  });

  it('rejects token files outside the allowed directory', async () => {
    const tokenPath = path.join(otherDir, 'token.txt');
    await writeFile(tokenPath, 'outside-token', 'utf8');

    await expect(readAccessTokenFromPath(tokenPath)).rejects.toThrow(
      /outside the allowed directory/i,
    );
  });

  it('rejects JSON without access_token', async () => {
    const tokenPath = path.join(tokenDir, 'token.json');
    await writeFile(tokenPath, JSON.stringify({ token: 'missing' }), 'utf8');

    await expect(readAccessTokenFromPath(tokenPath)).rejects.toThrow(
      /access_token/i,
    );
  });
});

describe('readRefreshTokenFromPath', () => {
  it('reads a raw refresh token file', async () => {
    const tokenPath = path.join(tokenDir, 'refresh.txt');
    await writeFile(tokenPath, ' refresh-token \n', 'utf8');

    const token = await readRefreshTokenFromPath('refresh.txt');
    expect(token.refresh_token).toBe('refresh-token');
  });

  it('reads a JSON refresh token file with metadata', async () => {
    const tokenPath = path.join(tokenDir, 'refresh.json');
    await writeFile(
      tokenPath,
      JSON.stringify({
        refresh_token: 'refresh-token',
        client_id: 'client-id',
        client_secret: 'client-secret',
        token_endpoint: 'http://localhost/token',
        scope: 'openid',
        server_url: 'http://localhost/mcp',
      }),
      'utf8',
    );

    const token = await readRefreshTokenFromPath(tokenPath);
    expect(token.refresh_token).toBe('refresh-token');
    expect(token.client_id).toBe('client-id');
    expect(token.client_secret).toBe('client-secret');
    expect(token.token_endpoint).toBe('http://localhost/token');
    expect(token.scope).toBe('openid');
    expect(token.server_url).toBe('http://localhost/mcp');
  });
});
