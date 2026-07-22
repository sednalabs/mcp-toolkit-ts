import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export type CachedTokens = {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  scope?: string;
  expires_at?: number;
  obtained_at: string;
};

export type RefreshTokenFile = {
  refresh_token: string;
  client_id?: string;
  client_secret?: string;
  token_endpoint?: string;
  scope?: string;
  server_url?: string;
};

export type TokenCacheEntry = {
  server_url: string;
  tokens: CachedTokens;
  client_id?: string;
  client_secret?: string;
  updated_at: string;
};

export type TokenCache = {
  version: number;
  entries: Record<string, TokenCacheEntry>;
};

const DEFAULT_CACHE_RELATIVE = path.join('.codex', 'mcp-probe', 'tokens.json');

export function resolveTokenCachePath(): string {
  const override = process.env.MCP_PROBE_TOKEN_CACHE;
  if (override) {
    return override;
  }
  return path.join(os.homedir(), DEFAULT_CACHE_RELATIVE);
}

export function resolveTokenDir(): string {
  const override = process.env.MCP_PROBE_TOKEN_DIR;
  if (override) {
    return override;
  }
  return path.dirname(resolveTokenCachePath());
}

function normalizeServerKey(serverUrl: string): string {
  const parsed = new URL(serverUrl);
  const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return `${parsed.origin}${pathname}`;
}

async function loadCache(pathname: string): Promise<TokenCache> {
  try {
    const raw = await readFile(pathname, 'utf8');
    const parsed = JSON.parse(raw) as TokenCache;
    return {
      version: parsed.version ?? 1,
      entries: parsed.entries ?? {},
    };
  } catch {
    return { version: 1, entries: {} };
  }
}

async function saveCache(pathname: string, cache: TokenCache): Promise<void> {
  await mkdir(path.dirname(pathname), { recursive: true });
  const payload = JSON.stringify(cache, null, 2);
  await writeFile(pathname, payload, { mode: 0o600 });
}

export function isTokenExpired(token: CachedTokens): boolean {
  if (!token.expires_at) {
    return false;
  }
  const now = Math.floor(Date.now() / 1000);
  return token.expires_at <= now + 30;
}

export async function storeTokens(
  serverUrl: string,
  tokens: CachedTokens,
  clientId?: string,
  clientSecret?: string,
): Promise<void> {
  const cachePath = resolveTokenCachePath();
  const cache = await loadCache(cachePath);
  const key = normalizeServerKey(serverUrl);
  const entry: TokenCacheEntry = {
    server_url: key,
    tokens,
    updated_at: new Date().toISOString(),
    ...(clientId !== undefined ? { client_id: clientId } : {}),
    ...(clientSecret !== undefined ? { client_secret: clientSecret } : {}),
  };
  cache.entries[key] = entry;
  await saveCache(cachePath, cache);
}

export async function getCachedTokens(serverUrl: string): Promise<TokenCacheEntry | undefined> {
  const cachePath = resolveTokenCachePath();
  const cache = await loadCache(cachePath);
  const key = normalizeServerKey(serverUrl);
  return cache.entries[key];
}

export async function resolveAccessToken(serverUrl: string): Promise<string> {
  const entry = await getCachedTokens(serverUrl);
  if (!entry) {
    throw new Error(
      'No cached tokens found for this server URL. Run `mcp-probe auth` first, or pass access_token_path/refresh_token_path (token files must live under MCP_PROBE_TOKEN_DIR).',
    );
  }
  if (isTokenExpired(entry.tokens)) {
    throw new Error(
      'Cached access token has expired. Run `mcp-probe auth` again, or pass access_token_path/refresh_token_path (token files must live under MCP_PROBE_TOKEN_DIR).',
    );
  }
  return entry.tokens.access_token;
}

export async function attachAuthHeader(
  headers: Record<string, string> | undefined,
  serverUrl: string,
): Promise<Record<string, string>> {
  const existing = Object.keys(headers ?? {}).find(
    (key) => key.toLowerCase() === 'authorization',
  );
  if (existing) {
    throw new Error('Authorization header already provided; remove it or disable auth.');
  }
  const token = await resolveAccessToken(serverUrl);
  return {
    ...(headers ?? {}),
    Authorization: `Bearer ${token}`,
  };
}

export function attachAccessToken(
  headers: Record<string, string> | undefined,
  accessToken: string,
): Record<string, string> {
  const existing = Object.keys(headers ?? {}).find(
    (key) => key.toLowerCase() === 'authorization',
  );
  if (existing) {
    throw new Error('Authorization header already provided; remove it or disable auth.');
  }
  return {
    ...(headers ?? {}),
    Authorization: `Bearer ${accessToken}`,
  };
}

function isPathWithin(baseDir: string, targetPath: string): boolean {
  const relative = path.relative(baseDir, targetPath);
  if (relative === '') {
    return true;
  }
  return !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function resolveTokenPath(tokenPath: string): Promise<string> {
  const baseDir = resolveTokenDir();
  const baseResolved = path.resolve(baseDir);
  const candidate = path.isAbsolute(tokenPath)
    ? tokenPath
    : path.resolve(baseResolved, tokenPath);

  const resolvedBase = await realpath(baseResolved).catch(() => baseResolved);
  const resolvedCandidate = await realpath(candidate).catch(() => path.resolve(candidate));

  if (!isPathWithin(resolvedBase, resolvedCandidate)) {
    throw new Error(
      `Token path is outside the allowed directory: ${resolvedBase}. Set MCP_PROBE_TOKEN_DIR to allow other locations.`,
    );
  }

  return resolvedCandidate;
}

export async function readAccessTokenFromPath(tokenPath: string): Promise<string> {
  const resolvedPath = await resolveTokenPath(tokenPath);
  const raw = await readFile(resolvedPath, 'utf8');
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Token file is empty.');
  }
  if (trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch (error) {
      throw new Error(
        `Token file contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Token JSON must be an object with an access_token field.');
    }
    const token = (parsed as { access_token?: unknown }).access_token;
    if (typeof token !== 'string' || token.trim().length === 0) {
      throw new Error('Token JSON must include a non-empty access_token string.');
    }
    return token.trim();
  }
  return trimmed;
}

export async function readRefreshTokenFromPath(tokenPath: string): Promise<RefreshTokenFile> {
  const resolvedPath = await resolveTokenPath(tokenPath);
  const raw = await readFile(resolvedPath, 'utf8');
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error('Token file is empty.');
  }
  if (trimmed.startsWith('{')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch (error) {
      throw new Error(
        `Token file contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Token JSON must be an object with a refresh_token field.');
    }
    const token = (parsed as { refresh_token?: unknown }).refresh_token;
    if (typeof token !== 'string' || token.trim().length === 0) {
      throw new Error('Token JSON must include a non-empty refresh_token string.');
    }
    const record = parsed as Record<string, unknown>;
    return {
      refresh_token: token.trim(),
      ...(typeof record.client_id === 'string' ? { client_id: record.client_id } : {}),
      ...(typeof record.client_secret === 'string'
        ? { client_secret: record.client_secret }
        : {}),
      ...(typeof record.token_endpoint === 'string'
        ? { token_endpoint: record.token_endpoint }
        : {}),
      ...(typeof record.scope === 'string' ? { scope: record.scope } : {}),
      ...(typeof record.server_url === 'string' ? { server_url: record.server_url } : {}),
    };
  }
  return { refresh_token: trimmed };
}

export function normalizeTokens(tokens: {
  access_token: string;
  refresh_token?: string | undefined;
  token_type?: string | undefined;
  scope?: string | undefined;
  expires_in?: number | undefined;
  expires_at?: number | undefined;
}): CachedTokens {
  const now = Math.floor(Date.now() / 1000);
  const expires_at =
    tokens.expires_at ??
    (typeof tokens.expires_in === 'number' ? now + tokens.expires_in : undefined);
  return {
    access_token: tokens.access_token,
    obtained_at: new Date().toISOString(),
    ...(tokens.refresh_token !== undefined ? { refresh_token: tokens.refresh_token } : {}),
    ...(tokens.token_type !== undefined ? { token_type: tokens.token_type } : {}),
    ...(tokens.scope !== undefined ? { scope: tokens.scope } : {}),
    ...(expires_at !== undefined ? { expires_at } : {}),
  };
}
