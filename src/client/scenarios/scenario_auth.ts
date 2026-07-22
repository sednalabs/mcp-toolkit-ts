import type { TransportType } from '../../transport.js';
import {
  attachAccessToken,
  attachAuthHeader,
  readAccessTokenFromPath,
  readRefreshTokenFromPath,
} from '../auth/cache.js';
import { refreshAccessToken } from '../auth/refresh.js';
import { formatAuthSourceError } from '../auth/messages.js';

export type AuthHeaderResult =
  | { ok: true; headers?: Record<string, string> }
  | { ok: false; detail: string };

export type ScenarioAuthInput = {
  transport: TransportType;
  url?: string;
  headers?: Record<string, string>;
  use_auth?: boolean;
  access_token?: string;
  access_token_path?: string;
  refresh_token?: string;
  refresh_token_path?: string;
  client_id?: string;
  client_secret?: string;
  token_endpoint?: string;
  scope?: string;
  timeout_ms?: number;
};

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function okResult(headers?: Record<string, string>): AuthHeaderResult {
  return headers ? { ok: true, headers } : { ok: true };
}

export async function resolveAuthHeaders(scenario: ScenarioAuthInput): Promise<AuthHeaderResult> {
  let headers = scenario.headers;
  const authSources = [
    scenario.use_auth ? 'use_auth' : undefined,
    scenario.access_token ? 'access_token' : undefined,
    scenario.access_token_path ? 'access_token_path' : undefined,
    scenario.refresh_token ? 'refresh_token' : undefined,
    scenario.refresh_token_path ? 'refresh_token_path' : undefined,
  ].filter(Boolean);
  if (authSources.length > 1) {
    return { ok: false, detail: formatAuthSourceError(authSources) };
  }

  if (scenario.access_token) {
    if (!scenario.url) {
      return { ok: false, detail: 'access_token requires a target URL' };
    }
    try {
      headers = attachAccessToken(headers, scenario.access_token);
    } catch (error) {
      return { ok: false, detail: formatError(error) };
    }
    return okResult(headers);
  }

  if (scenario.access_token_path) {
    if (!scenario.url) {
      return { ok: false, detail: 'access_token_path requires a target URL' };
    }
    try {
      const token = await readAccessTokenFromPath(scenario.access_token_path);
      headers = attachAccessToken(headers, token);
    } catch (error) {
      return { ok: false, detail: formatError(error) };
    }
    return okResult(headers);
  }

  if (scenario.refresh_token || scenario.refresh_token_path) {
    if (scenario.transport === 'stdio') {
      return { ok: false, detail: 'refresh_token auth is only supported for HTTP transports.' };
    }
    if (!scenario.url) {
      return { ok: false, detail: 'refresh_token requires a target URL' };
    }
    try {
      const fileData = scenario.refresh_token_path
        ? await readRefreshTokenFromPath(scenario.refresh_token_path)
        : undefined;
      const refreshToken = scenario.refresh_token ?? fileData?.refresh_token;
      const clientId = scenario.client_id ?? fileData?.client_id;
      const clientSecret = scenario.client_secret ?? fileData?.client_secret;
      const tokenEndpoint = scenario.token_endpoint ?? fileData?.token_endpoint;
      const scope = scenario.scope ?? fileData?.scope;
      const serverUrl = scenario.url ?? fileData?.server_url;
      if (!refreshToken) {
        throw new Error('refresh_token is required.');
      }
      if (!clientId) {
        throw new Error('client_id is required to refresh tokens.');
      }
      const refreshed = await refreshAccessToken({
        refreshToken,
        clientId,
        ...(clientSecret !== undefined ? { clientSecret } : {}),
        ...(scope !== undefined ? { scope } : {}),
        ...(serverUrl !== undefined ? { serverUrl } : {}),
        ...(tokenEndpoint !== undefined ? { tokenEndpoint } : {}),
        ...(scenario.timeout_ms !== undefined ? { timeoutMs: scenario.timeout_ms } : {}),
      });
      headers = attachAccessToken(headers, refreshed.access_token);
    } catch (error) {
      return { ok: false, detail: formatError(error) };
    }
    return okResult(headers);
  }

  if (scenario.use_auth) {
    if (!scenario.url) {
      return { ok: false, detail: 'use_auth requires a target URL' };
    }
    try {
      headers = await attachAuthHeader(headers, scenario.url);
    } catch (error) {
      return { ok: false, detail: formatError(error) };
    }
    return okResult(headers);
  }

  return okResult(headers);
}
