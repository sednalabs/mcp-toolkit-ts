import type { AuthDiscovery, ProbeStep } from '../../report.js';
import type { TransportOptions } from '../../transport.js';
import { ensureHostAllowed } from '../auth/allowlist.js';
import { describeError, errorData } from './errors.js';

export function extractResourceMetadataUrl(header: string | null): string | undefined {
  if (!header) return undefined;
  const quotedMatch = header.match(/resource_metadata="([^"]+)"/i);
  if (quotedMatch?.[1]) return quotedMatch[1];
  const bareMatch = header.match(/resource_metadata=([^,\s]+)/i);
  return bareMatch?.[1];
}

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

async function fetchJson(
  url: string,
  timeoutMs: number,
): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  try {
    const response = await fetchWithTimeout(
      url,
      {
        headers: { Accept: 'application/json' },
      },
      timeoutMs,
    );
    if (!response.ok) {
      return { ok: false, error: `HTTP ${response.status}` };
    }
    const data = (await response.json()) as unknown;
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function discoverAuth(
  target: TransportOptions,
  steps: ProbeStep[],
  timeoutMs: number,
  allowedHosts?: string[],
): Promise<AuthDiscovery | undefined> {
  if (target.transportType === 'stdio' || !target.url) {
    steps.push({ name: 'auth.prm', status: 'ok', detail: 'not applicable' });
    return undefined;
  }

  try {
    ensureHostAllowed(target.url, allowedHosts, 'Target');
  } catch (error) {
    const details = describeError(error);
    steps.push({
      name: 'auth.prm',
      status: 'error',
      detail: details.message,
      ...(errorData(details) ? { data: errorData(details) } : {}),
    });
    return undefined;
  }

  let prmUrl: string | undefined;
  const auth: AuthDiscovery = {};

  try {
    const response = await fetchWithTimeout(target.url, { method: 'GET' }, timeoutMs);
    if (response.status === 401 || response.status === 403) {
      prmUrl = extractResourceMetadataUrl(response.headers.get('www-authenticate'));
      if (!prmUrl) {
        steps.push({
          name: 'auth.prm',
          status: 'error',
          detail: 'Missing resource_metadata in WWW-Authenticate header',
        });
        return auth;
      }
      try {
        ensureHostAllowed(prmUrl, allowedHosts, 'PRM');
      } catch (error) {
        const details = describeError(error);
        steps.push({
          name: 'auth.prm',
          status: 'error',
          detail: details.message,
          ...(errorData(details) ? { data: errorData(details) } : {}),
        });
        return auth;
      }
      auth.resource_metadata_url = prmUrl;
      steps.push({ name: 'auth.prm', status: 'ok' });
    } else if (response.ok) {
      steps.push({
        name: 'auth.prm',
        status: 'ok',
        detail: 'no auth required',
      });
      return auth;
    } else {
      steps.push({
        name: 'auth.prm',
        status: 'error',
        detail: `Unexpected status ${response.status}`,
      });
      return auth;
    }
  } catch (error) {
    const details = describeError(error);
    steps.push({
      name: 'auth.prm',
      status: 'error',
      detail: details.message,
      ...(errorData(details) ? { data: errorData(details) } : {}),
    });
    return auth;
  }

  if (prmUrl) {
    const prmResult = await fetchJson(prmUrl, timeoutMs);
    if (!prmResult.ok) {
      steps.push({
        name: 'auth.prm.fetch',
        status: 'error',
        detail: prmResult.error ?? 'Failed to fetch PRM metadata',
      });
      return auth;
    }
    auth.resource_metadata = prmResult.data;
    steps.push({ name: 'auth.prm.fetch', status: 'ok' });
    const metadata = prmResult.data as { authorization_servers?: unknown };
    const servers = Array.isArray(metadata?.authorization_servers)
      ? metadata.authorization_servers.filter((value): value is string => typeof value === 'string')
      : [];
    if (servers.length > 0) {
      const candidate = servers[0];
      if (candidate) {
        try {
          ensureHostAllowed(candidate, allowedHosts, 'Authorization server');
        } catch (error) {
          const details = describeError(error);
          steps.push({
            name: 'auth.oauth.fetch',
            status: 'error',
            detail: details.message,
            ...(errorData(details) ? { data: errorData(details) } : {}),
          });
          return auth;
        }
        auth.authorization_server = candidate;
      }
    }
  }

  if (!auth.authorization_server) {
    steps.push({
      name: 'auth.oauth.fetch',
      status: 'error',
      detail: 'No authorization server found in PRM metadata',
    });
    return auth;
  }

  const issuer = auth.authorization_server.endsWith('/')
    ? auth.authorization_server
    : `${auth.authorization_server}/`;
  const oidcUrl = new URL('.well-known/openid-configuration', issuer).toString();
  const oauthUrl = new URL('.well-known/oauth-authorization-server', issuer).toString();
  try {
    ensureHostAllowed(oidcUrl, allowedHosts, 'OAuth metadata');
    ensureHostAllowed(oauthUrl, allowedHosts, 'OAuth metadata');
  } catch (error) {
    const details = describeError(error);
    steps.push({
      name: 'auth.oauth.fetch',
      status: 'error',
      detail: details.message,
      ...(errorData(details) ? { data: errorData(details) } : {}),
    });
    return auth;
  }
  let oauthResult = await fetchJson(oidcUrl, timeoutMs);
  let oauthMetadataUrl = oidcUrl;
  if (!oauthResult.ok) {
    oauthResult = await fetchJson(oauthUrl, timeoutMs);
    oauthMetadataUrl = oauthResult.ok ? oauthUrl : oidcUrl;
  }
  if (!oauthResult.ok) {
    steps.push({
      name: 'auth.oauth.fetch',
      status: 'error',
      detail: oauthResult.error ?? 'Failed to fetch OAuth metadata',
    });
    return auth;
  }
  auth.oauth_metadata_url = oauthMetadataUrl;
  auth.oauth_metadata = oauthResult.data;
  steps.push({ name: 'auth.oauth.fetch', status: 'ok' });
  return auth;
}
