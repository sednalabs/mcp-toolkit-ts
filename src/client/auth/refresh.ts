import {
  discoverAuthorizationServerMetadata,
  discoverOAuthProtectedResourceMetadata,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { ensureHostAllowed, parseAllowedHostsEnv } from './allowlist.js';

export type RefreshTokenOptions = {
  refreshToken: string;
  clientId: string;
  clientSecret?: string;
  scope?: string;
  serverUrl?: string;
  tokenEndpoint?: string;
  timeoutMs?: number;
};

export type RefreshTokenResult = {
  access_token: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
};

const DEFAULT_TIMEOUT_MS = 10_000;

async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  if (timeoutMs <= 0) {
    return fetch(url, options);
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function buildFormBody(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

async function resolveTokenEndpoint(options: RefreshTokenOptions): Promise<string> {
  if (options.tokenEndpoint) {
    return options.tokenEndpoint;
  }
  if (!options.serverUrl) {
    throw new Error('token_endpoint or serverUrl is required to refresh tokens.');
  }

  const allowedHosts = parseAllowedHostsEnv();
  ensureHostAllowed(options.serverUrl, allowedHosts, 'Server');

  let resourceMetadata: Awaited<ReturnType<typeof discoverOAuthProtectedResourceMetadata>> | null =
    null;
  try {
    resourceMetadata = await discoverOAuthProtectedResourceMetadata(options.serverUrl);
  } catch {
    resourceMetadata = null;
  }

  let authServerUrl = new URL('/', options.serverUrl).toString();
  if (resourceMetadata?.authorization_servers?.length) {
    const candidate = resourceMetadata.authorization_servers[0];
    if (candidate) {
      authServerUrl = candidate;
    }
  }
  ensureHostAllowed(authServerUrl, allowedHosts, 'Authorization server');

  const metadata = await discoverAuthorizationServerMetadata(new URL(authServerUrl));
  if (!metadata || typeof metadata.token_endpoint !== 'string') {
    throw new Error('Failed to discover OAuth token endpoint.');
  }

  ensureHostAllowed(metadata.token_endpoint, allowedHosts, 'Token endpoint');
  return metadata.token_endpoint;
}

export async function refreshAccessToken(
  options: RefreshTokenOptions,
): Promise<RefreshTokenResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const tokenEndpoint = await resolveTokenEndpoint(options);
  const allowedHosts = parseAllowedHostsEnv();
  ensureHostAllowed(tokenEndpoint, allowedHosts, 'Token endpoint');

  const body: Record<string, string> = {
    grant_type: 'refresh_token',
    refresh_token: options.refreshToken,
    client_id: options.clientId,
  };
  if (options.clientSecret) {
    body.client_secret = options.clientSecret;
  }
  if (options.scope) {
    body.scope = options.scope;
  }

  const response = await fetchWithTimeout(
    tokenEndpoint,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: buildFormBody(body),
    },
    timeoutMs,
  );

  const raw = await response.text();
  if (!response.ok) {
    const detail = raw.trim() ? ` ${raw.trim()}` : '';
    throw new Error(`Token endpoint HTTP ${response.status}.${detail}`);
  }

  let parsed: unknown;
  try {
    parsed = raw ? (JSON.parse(raw) as unknown) : {};
  } catch (error) {
    throw new Error(
      `Token endpoint returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Token endpoint response must be a JSON object.');
  }

  const record = parsed as Record<string, unknown>;
  const accessToken = record.access_token;
  if (typeof accessToken !== 'string' || accessToken.trim().length === 0) {
    throw new Error('Token endpoint response missing access_token.');
  }

  return {
    access_token: accessToken,
    ...(typeof record.refresh_token === 'string'
      ? { refresh_token: record.refresh_token }
      : {}),
    ...(typeof record.token_type === 'string' ? { token_type: record.token_type } : {}),
    ...(typeof record.expires_in === 'number' ? { expires_in: record.expires_in } : {}),
    ...(typeof record.scope === 'string' ? { scope: record.scope } : {}),
  };
}
