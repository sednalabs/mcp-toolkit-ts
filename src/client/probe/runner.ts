import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { z } from 'zod';
import {
  type AuthDiscovery,
  nowIso,
  type ProbeReport,
  type ProbeStep,
  type TraceEntry,
} from '../../report.js';
import type { TransportOptions } from '../../transport.js';
import { createLogger, type LogFormat, type LogLevel } from '../../logging.js';
import { ensureHostAllowed, parseAllowedHostsEnv } from '../auth/allowlist.js';
import { describeError, errorData } from './errors.js';
import type { StdioCapture, StdioSnapshot, TraceCollector } from './telemetry.js';
import { discoverAuth, extractResourceMetadataUrl } from './auth.js';
import { applyExpectAuthRequired, enforceHostAllowlist, enforceStdioAllowlist } from './probe_allowlist.js';
import { connectWithRetry } from './probe_connect.js';
import { fetchJson, fetchWithTimeout } from './probe_http.js';
import { resolveProbeOptions } from './probe_options.js';
import { checkStreamableHttpSseCompatibility } from './streamable_http_sse.js';
import { withRetry, withTimeout } from './probe_timing.js';

export type ProbeTarget = TransportOptions & {
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  expectAuthRequired?: boolean;
  logLevel?: LogLevel;
  logFormat?: LogFormat;
  logStream?: NodeJS.WritableStream;
  trace?: boolean;
  traceLimit?: number;
  traceMaxBytes?: number;
};

export type AuthDiscoveryTarget = {
  url?: string;
  timeoutMs?: number;
  expectAuthRequired?: boolean;
};

export type HttpSmokeTarget = AuthDiscoveryTarget;

export type RawRequestTarget = ProbeTarget & {
  method: string;
  params?: unknown;
  expectError?: boolean | string;
};

export type AuthDiscoveryReport = {
  ok: boolean;
  started_at: string;
  finished_at: string;
  steps: ProbeStep[];
  auth?: AuthDiscovery;
};

export type HttpSmokeReport = {
  ok: boolean;
  started_at: string;
  finished_at: string;
  steps: ProbeStep[];
  auth?: AuthDiscovery;
};

export type RawRequestReport = {
  ok: boolean;
  started_at: string;
  finished_at: string;
  steps: ProbeStep[];
  server_info?: unknown;
  capabilities?: unknown;
  result?: unknown;
  error?: string;
  auth?: AuthDiscovery;
  trace?: TraceEntry[];
};


function resolveExpectError(expectError?: boolean | string): { enabled: boolean; match?: string } {
  if (!expectError) {
    return { enabled: false };
  }
  if (typeof expectError === 'string') {
    return { enabled: true, match: expectError };
  }
  return { enabled: true };
}


export async function runProbe(
  target: ProbeTarget,
  clientInfo?: { name: string; version: string },
): Promise<ProbeReport> {
  const startedAt = nowIso();
  const steps: ProbeStep[] = [];
  const probeOptions = resolveProbeOptions(target);
  const allowedHosts = parseAllowedHostsEnv();
  const logger = target.logLevel
    ? createLogger({
        level: target.logLevel,
        format: target.logFormat ?? 'json',
        ...(target.logStream ? { stream: target.logStream } : {}),
      })
    : undefined;
  const stdioOk = enforceStdioAllowlist(target.transportType, steps);
  const allowlistOk = stdioOk ? enforceHostAllowlist(target, steps, allowedHosts) : false;
  const auth = stdioOk && allowlistOk
    ? await discoverAuth(target, steps, probeOptions.timeoutMs, allowedHosts)
    : undefined;

  if (!stdioOk || !allowlistOk) {
    return {
      ok: false,
      started_at: startedAt,
      finished_at: nowIso(),
      steps,
      ...(auth !== undefined ? { auth } : {}),
    };
  }

  applyExpectAuthRequired(steps, target.expectAuthRequired);

  if (target.transportType === 'streamable-http' && target.url) {
    const streamableResult = await checkStreamableHttpSseCompatibility(target.url, probeOptions.timeoutMs);
    steps.push(...streamableResult.steps);
    if (!streamableResult.ok) {
      return {
        ok: false,
        started_at: startedAt,
        finished_at: nowIso(),
        steps,
        ...(auth !== undefined ? { auth } : {}),
      };
    }
  }

  let activeClient: Client | undefined;
  let activeTransport: Transport | undefined;
  let stdioCapture: StdioCapture | undefined;
  let traceCollector: TraceCollector | undefined;
  try {
    logger?.info('probe.connect.start');
    const { client, transport, stdio, trace } = await connectWithRetry(
      target,
      probeOptions,
      clientInfo,
    );
    activeClient = client;
    activeTransport = transport;
    stdioCapture = stdio;
    traceCollector = trace;
    steps.push({ name: 'connect', status: 'ok' });
    logger?.info('probe.connect.ok');
  } catch (error) {
    const details = describeError(error);
    const errorStdio = (error as { stdio?: StdioSnapshot }).stdio;
    const errorTrace = (error as { trace?: TraceEntry[] }).trace;
    const data = {
      ...(errorData(details) ?? {}),
      ...(errorStdio !== undefined ? { stdio: errorStdio } : {}),
      ...(errorTrace !== undefined ? { trace: errorTrace } : {}),
    };
    steps.push({
      name: 'connect',
      status: 'error',
      detail: details.message,
      ...(Object.keys(data).length > 0 ? { data } : {}),
    });
    logger?.error('probe.connect.error', {
      detail: details.message,
      ...(Object.keys(data).length > 0 ? { data } : {}),
    });
    return {
      ok: false,
      started_at: startedAt,
      finished_at: nowIso(),
      steps,
    };
  }

  if (!activeClient || !activeTransport) {
    return {
      ok: false,
      started_at: startedAt,
      finished_at: nowIso(),
      steps: [
        ...steps,
        {
          name: 'connect',
          status: 'error',
          detail: 'Failed to initialize transport.',
        },
      ],
    };
  }

  const serverInfo = activeClient.getServerVersion?.() ?? undefined;
  const serverInfoDetail = serverInfo ? undefined : 'not available';
  const capabilities = activeClient.getServerCapabilities?.() ?? undefined;
  let toolsResponse: unknown = undefined;
  let resourcesResponse: unknown = undefined;
  let promptsResponse: unknown = undefined;

  try {
    steps.push({
      name: 'server.info',
      status: 'ok',
      ...(serverInfoDetail !== undefined ? { detail: serverInfoDetail } : {}),
    });

    const capabilitiesDetail = capabilities ? undefined : 'not available';
    steps.push({
      name: 'capabilities',
      status: 'ok',
      ...(capabilitiesDetail !== undefined ? { detail: capabilitiesDetail } : {}),
    });

    try {
      toolsResponse = await withRetry(
        () => withTimeout(activeClient.listTools({}), probeOptions.timeoutMs, 'tools.list'),
        probeOptions.retries,
        probeOptions.retryDelayMs,
      );
      steps.push({ name: 'tools.list', status: 'ok' });
      logger?.info('probe.tools.list.ok');
    } catch (error) {
      const details = describeError(error);
      steps.push({
        name: 'tools.list',
        status: 'error',
        detail: details.message,
        ...(errorData(details) ? { data: errorData(details) } : {}),
      });
      logger?.error('probe.tools.list.error', {
        detail: details.message,
        ...(errorData(details) ? { data: errorData(details) } : {}),
      });
    }

    const resourcesSupported =
      capabilities && typeof capabilities === 'object' && 'resources' in capabilities;
    if (resourcesSupported && activeClient.listResources) {
      try {
        resourcesResponse = await withRetry(
          () => withTimeout(activeClient.listResources({}), probeOptions.timeoutMs, 'resources.list'),
          probeOptions.retries,
          probeOptions.retryDelayMs,
        );
        steps.push({ name: 'resources.list', status: 'ok' });
        logger?.info('probe.resources.list.ok');
      } catch (error) {
        const details = describeError(error);
        steps.push({
          name: 'resources.list',
          status: 'error',
          detail: details.message,
          ...(errorData(details) ? { data: errorData(details) } : {}),
        });
        logger?.error('probe.resources.list.error', {
          detail: details.message,
          ...(errorData(details) ? { data: errorData(details) } : {}),
        });
      }
    } else {
      steps.push({
        name: 'resources.list',
        status: 'ok',
        detail: 'not supported',
      });
    }

    const promptsSupported =
      capabilities && typeof capabilities === 'object' && 'prompts' in capabilities;
    if (promptsSupported && activeClient.listPrompts) {
      try {
        promptsResponse = await withRetry(
          () => withTimeout(activeClient.listPrompts({}), probeOptions.timeoutMs, 'prompts.list'),
          probeOptions.retries,
          probeOptions.retryDelayMs,
        );
        steps.push({ name: 'prompts.list', status: 'ok' });
        logger?.info('probe.prompts.list.ok');
      } catch (error) {
        const details = describeError(error);
        steps.push({
          name: 'prompts.list',
          status: 'error',
          detail: details.message,
          ...(errorData(details) ? { data: errorData(details) } : {}),
        });
        logger?.error('probe.prompts.list.error', {
          detail: details.message,
          ...(errorData(details) ? { data: errorData(details) } : {}),
        });
      }
    } else {
      steps.push({
        name: 'prompts.list',
        status: 'ok',
        detail: 'not supported',
      });
    }
  } finally {
    try {
      await activeTransport.close();
      steps.push({ name: 'disconnect', status: 'ok' });
      logger?.info('probe.disconnect.ok');
    } catch (error) {
      const details = describeError(error);
      steps.push({
        name: 'disconnect',
        status: 'error',
        detail: details.message,
        ...(errorData(details) ? { data: errorData(details) } : {}),
      });
      logger?.error('probe.disconnect.error', {
        detail: details.message,
        ...(errorData(details) ? { data: errorData(details) } : {}),
      });
    } finally {
      if (stdioCapture) {
        const snapshot = stdioCapture.snapshot();
        stdioCapture.stop();
        if (snapshot.lines.length > 0 || snapshot.exit_code !== undefined || snapshot.signal) {
          steps.push({ name: 'stdio.stderr', status: 'ok', data: snapshot });
        }
      }
    }
  }

  const finishedAt = nowIso();
  const ok = steps.every((step) => step.status === 'ok');

  logger?.info('probe.finished', { ok });
  return {
    ok,
    started_at: startedAt,
    finished_at: finishedAt,
    steps,
    ...(auth !== undefined ? { auth } : {}),
    ...(serverInfo !== undefined ? { server_info: serverInfo } : {}),
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(toolsResponse !== undefined ? { tools: toolsResponse } : {}),
    ...(resourcesResponse !== undefined ? { resources: resourcesResponse } : {}),
    ...(promptsResponse !== undefined ? { prompts: promptsResponse } : {}),
    ...(traceCollector ? { trace: traceCollector.entries() } : {}),
  };
}

export async function runAuthDiscovery(
  target: AuthDiscoveryTarget,
): Promise<AuthDiscoveryReport> {
  const startedAt = nowIso();
  const steps: ProbeStep[] = [];
  const allowedHosts = parseAllowedHostsEnv();
  const probeOptions = resolveProbeOptions({
    ...(target.timeoutMs !== undefined ? { timeoutMs: target.timeoutMs } : {}),
  });

  const allowlistOk = enforceHostAllowlist(
    {
      transportType: 'streamable-http',
      ...(target.url !== undefined ? { url: target.url } : {}),
    },
    steps,
    allowedHosts,
  );
  const auth = allowlistOk
    ? await discoverAuth(
        {
          transportType: 'streamable-http',
          ...(target.url !== undefined ? { url: target.url } : {}),
        },
        steps,
        probeOptions.timeoutMs,
        allowedHosts,
      )
    : undefined;

  if (!allowlistOk) {
    return {
      ok: false,
      started_at: startedAt,
      finished_at: nowIso(),
      steps,
      ...(auth !== undefined ? { auth } : {}),
    };
  }

  applyExpectAuthRequired(steps, target.expectAuthRequired);

  const finishedAt = nowIso();
  const ok = steps.every((step) => step.status === 'ok');
  return {
    ok,
    started_at: startedAt,
    finished_at: finishedAt,
    steps,
    ...(auth !== undefined ? { auth } : {}),
  };
}

export async function runProbeHandshake(
  target: ProbeTarget,
  clientInfo?: { name: string; version: string },
): Promise<ProbeReport> {
  const startedAt = nowIso();
  const steps: ProbeStep[] = [];
  const probeOptions = resolveProbeOptions(target);
  const allowedHosts = parseAllowedHostsEnv();
  const logger = target.logLevel
    ? createLogger({
        level: target.logLevel,
        format: target.logFormat ?? 'json',
        ...(target.logStream ? { stream: target.logStream } : {}),
      })
    : undefined;

  const stdioOk = enforceStdioAllowlist(target.transportType, steps);
  const allowlistOk = stdioOk ? enforceHostAllowlist(target, steps, allowedHosts) : false;
  const auth = stdioOk && allowlistOk
    ? await discoverAuth(target, steps, probeOptions.timeoutMs, allowedHosts)
    : undefined;

  if (!stdioOk || !allowlistOk) {
    return {
      ok: false,
      started_at: startedAt,
      finished_at: nowIso(),
      steps,
      ...(auth !== undefined ? { auth } : {}),
    };
  }

  applyExpectAuthRequired(steps, target.expectAuthRequired);

  if (target.transportType === 'streamable-http' && target.url) {
    const streamableResult = await checkStreamableHttpSseCompatibility(target.url, probeOptions.timeoutMs);
    steps.push(...streamableResult.steps);
    if (!streamableResult.ok) {
      return {
        ok: false,
        started_at: startedAt,
        finished_at: nowIso(),
        steps,
        ...(auth !== undefined ? { auth } : {}),
      };
    }
  }

  let activeClient: Client | undefined;
  let activeTransport: Transport | undefined;
  let stdioCapture: StdioCapture | undefined;
  let traceCollector: TraceCollector | undefined;

  try {
    logger?.info('probe.connect.start');
    const { client, transport, stdio, trace } = await connectWithRetry(
      target,
      probeOptions,
      clientInfo,
    );
    activeClient = client;
    activeTransport = transport;
    stdioCapture = stdio;
    traceCollector = trace;
    steps.push({ name: 'connect', status: 'ok' });
    logger?.info('probe.connect.ok');
  } catch (error) {
    const details = describeError(error);
    const errorStdio = (error as { stdio?: StdioSnapshot }).stdio;
    const errorTrace = (error as { trace?: TraceEntry[] }).trace;
    const data = {
      ...(errorData(details) ?? {}),
      ...(errorStdio !== undefined ? { stdio: errorStdio } : {}),
      ...(errorTrace !== undefined ? { trace: errorTrace } : {}),
    };
    steps.push({
      name: 'connect',
      status: 'error',
      detail: details.message,
      ...(Object.keys(data).length > 0 ? { data } : {}),
    });
    logger?.error('probe.connect.error', {
      detail: details.message,
      ...(Object.keys(data).length > 0 ? { data } : {}),
    });
    return {
      ok: false,
      started_at: startedAt,
      finished_at: nowIso(),
      steps,
      ...(auth !== undefined ? { auth } : {}),
    };
  }

  if (!activeClient || !activeTransport) {
    return {
      ok: false,
      started_at: startedAt,
      finished_at: nowIso(),
      steps: [
        ...steps,
        {
          name: 'connect',
          status: 'error',
          detail: 'Failed to initialize transport.',
        },
      ],
      ...(auth !== undefined ? { auth } : {}),
    };
  }

  const serverInfo = activeClient.getServerVersion?.() ?? undefined;
  const serverInfoDetail = serverInfo ? undefined : 'not available';
  steps.push({
    name: 'server.info',
    status: 'ok',
    ...(serverInfoDetail !== undefined ? { detail: serverInfoDetail } : {}),
  });

  const capabilities = activeClient.getServerCapabilities?.() ?? undefined;
  const capabilitiesDetail = capabilities ? undefined : 'not available';
  steps.push({
    name: 'capabilities',
    status: 'ok',
    ...(capabilitiesDetail !== undefined ? { detail: capabilitiesDetail } : {}),
  });

  let pingResponse: unknown = undefined;
  try {
    pingResponse = await withRetry(
      () => withTimeout(activeClient.ping(), probeOptions.timeoutMs, 'ping'),
      probeOptions.retries,
      probeOptions.retryDelayMs,
    );
    steps.push({
      name: 'ping',
      status: 'ok',
      ...(pingResponse !== undefined ? { data: pingResponse } : {}),
    });
    logger?.info('probe.ping.ok');
  } catch (error) {
    const details = describeError(error);
    steps.push({
      name: 'ping',
      status: 'error',
      detail: details.message,
      ...(errorData(details) ? { data: errorData(details) } : {}),
    });
    logger?.error('probe.ping.error', {
      detail: details.message,
      ...(errorData(details) ? { data: errorData(details) } : {}),
    });
  }

  let toolsResponse: unknown = undefined;
  try {
    toolsResponse = await withRetry(
      () => withTimeout(activeClient.listTools({}), probeOptions.timeoutMs, 'tools.list'),
      probeOptions.retries,
      probeOptions.retryDelayMs,
    );
    steps.push({ name: 'tools.list', status: 'ok' });
    logger?.info('probe.tools.list.ok');
  } catch (error) {
    const details = describeError(error);
    steps.push({
      name: 'tools.list',
      status: 'error',
      detail: details.message,
      ...(errorData(details) ? { data: errorData(details) } : {}),
    });
    logger?.error('probe.tools.list.error', {
      detail: details.message,
      ...(errorData(details) ? { data: errorData(details) } : {}),
    });
  } finally {
    try {
      await activeTransport.close().catch(() => undefined);
    } finally {
      if (stdioCapture) {
        const snapshot = stdioCapture.snapshot();
        stdioCapture.stop();
        if (snapshot.lines.length > 0 || snapshot.exit_code !== undefined || snapshot.signal) {
          steps.push({ name: 'stdio.stderr', status: 'ok', data: snapshot });
        }
      }
    }
  }

  const finishedAt = nowIso();
  const ok = steps.every((step) => step.status === 'ok');

  logger?.info('probe.handshake.finished', { ok });
  return {
    ok,
    started_at: startedAt,
    finished_at: finishedAt,
    steps,
    ...(auth !== undefined ? { auth } : {}),
    ...(serverInfo !== undefined ? { server_info: serverInfo } : {}),
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(toolsResponse !== undefined ? { tools: toolsResponse } : {}),
    ...(traceCollector ? { trace: traceCollector.entries() } : {}),
  };
}

export async function runHttpSmoke(target: HttpSmokeTarget): Promise<HttpSmokeReport> {
  const startedAt = nowIso();
  const steps: ProbeStep[] = [];
  const allowedHosts = parseAllowedHostsEnv();
  const probeOptions = resolveProbeOptions({
    ...(target.timeoutMs !== undefined ? { timeoutMs: target.timeoutMs } : {}),
  });

  const allowlistOk = enforceHostAllowlist(
    {
      transportType: 'streamable-http',
      ...(target.url !== undefined ? { url: target.url } : {}),
    },
    steps,
    allowedHosts,
  );

  if (!allowlistOk) {
    return {
      ok: false,
      started_at: startedAt,
      finished_at: nowIso(),
      steps,
    };
  }

  if (!target.url) {
    return {
      ok: false,
      started_at: startedAt,
      finished_at: nowIso(),
      steps: [
        ...steps,
        {
          name: 'http.get',
          status: 'error',
          detail: 'Missing target URL.',
        },
      ],
    };
  }

  const auth: AuthDiscovery = {};
  let response: Response | undefined;
  try {
    response = await fetchWithTimeout(target.url, { method: 'GET' }, probeOptions.timeoutMs);
    const okStatus = response.ok || response.status === 401 || response.status === 403;
    steps.push({
      name: 'http.get',
      status: okStatus ? 'ok' : 'error',
      detail: `HTTP ${response.status}`,
    });
  } catch (error) {
    const details = describeError(error);
    steps.push({
      name: 'http.get',
      status: 'error',
      detail: details.message,
      ...(errorData(details) ? { data: errorData(details) } : {}),
    });
    return {
      ok: false,
      started_at: startedAt,
      finished_at: nowIso(),
      steps,
    };
  }

  const status = response.status;
  const wwwAuthenticate = response.headers.get('www-authenticate');
  const resourceMetadataUrl = extractResourceMetadataUrl(wwwAuthenticate);

  if (status === 401 || status === 403) {
    if (!resourceMetadataUrl) {
      steps.push({
        name: 'auth.prm',
        status: 'error',
        detail: 'Missing resource_metadata in WWW-Authenticate header',
      });
    } else {
      try {
        ensureHostAllowed(resourceMetadataUrl, allowedHosts, 'PRM');
        auth.resource_metadata_url = resourceMetadataUrl;
        steps.push({ name: 'auth.prm', status: 'ok' });
      } catch (error) {
        const details = describeError(error);
        steps.push({
          name: 'auth.prm',
          status: 'error',
          detail: details.message,
          ...(errorData(details) ? { data: errorData(details) } : {}),
        });
      }
    }
  } else if (response.ok) {
    steps.push({
      name: 'auth.prm',
      status: 'ok',
      detail: 'no auth required',
    });
  } else {
    steps.push({
      name: 'auth.prm',
      status: 'error',
      detail: `Unexpected status ${status}`,
    });
  }

  if (auth.resource_metadata_url) {
    const prmResult = await fetchJson(auth.resource_metadata_url, probeOptions.timeoutMs);
    if (!prmResult.ok) {
      steps.push({
        name: 'auth.prm.fetch',
        status: 'error',
        detail: prmResult.error ?? 'Failed to fetch PRM metadata',
      });
    } else {
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
            auth.authorization_server = candidate;
          } catch (error) {
            const details = describeError(error);
            steps.push({
              name: 'auth.oauth.fetch',
              status: 'error',
              detail: details.message,
              ...(errorData(details) ? { data: errorData(details) } : {}),
            });
          }
        }
      }
    }
  }

  if (auth.authorization_server) {
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
    }
    let oauthResult = await fetchJson(oidcUrl, probeOptions.timeoutMs);
    let oauthMetadataUrl = oidcUrl;
    if (!oauthResult.ok) {
      oauthResult = await fetchJson(oauthUrl, probeOptions.timeoutMs);
      oauthMetadataUrl = oauthResult.ok ? oauthUrl : oidcUrl;
    }
    if (!oauthResult.ok) {
      steps.push({
        name: 'auth.oauth.fetch',
        status: 'error',
        detail: oauthResult.error ?? 'Failed to fetch OAuth metadata',
      });
    } else {
      auth.oauth_metadata_url = oauthMetadataUrl;
      auth.oauth_metadata = oauthResult.data;
      steps.push({ name: 'auth.oauth.fetch', status: 'ok' });
    }
  } else if (steps.some((step) => step.name === 'auth.prm.fetch' && step.status === 'ok')) {
    steps.push({
      name: 'auth.oauth.fetch',
      status: 'error',
      detail: 'No authorization server found in PRM metadata',
    });
  }

  applyExpectAuthRequired(steps, target.expectAuthRequired);

  const finishedAt = nowIso();
  const ok = steps.every((step) => step.status === 'ok');
  return {
    ok,
    started_at: startedAt,
    finished_at: finishedAt,
    steps,
    ...(Object.keys(auth).length > 0 ? { auth } : {}),
  };
}

export async function runRawRequest(
  target: RawRequestTarget,
  clientInfo?: { name: string; version: string },
): Promise<RawRequestReport> {
  const startedAt = nowIso();
  const steps: ProbeStep[] = [];
  const probeOptions = resolveProbeOptions(target);
  const allowedHosts = parseAllowedHostsEnv();
  const logger = target.logLevel
    ? createLogger({
        level: target.logLevel,
        format: target.logFormat ?? 'json',
        ...(target.logStream ? { stream: target.logStream } : {}),
      })
    : undefined;

  const stdioOk = enforceStdioAllowlist(target.transportType, steps);
  const allowlistOk = stdioOk ? enforceHostAllowlist(target, steps, allowedHosts) : false;
  const auth = stdioOk && allowlistOk
    ? await discoverAuth(target, steps, probeOptions.timeoutMs, allowedHosts)
    : undefined;

  if (!stdioOk || !allowlistOk) {
    return {
      ok: false,
      started_at: startedAt,
      finished_at: nowIso(),
      steps,
      ...(auth !== undefined ? { auth } : {}),
    };
  }

  applyExpectAuthRequired(steps, target.expectAuthRequired);

  if (target.transportType === 'streamable-http' && target.url) {
    const streamableResult = await checkStreamableHttpSseCompatibility(target.url, probeOptions.timeoutMs);
    steps.push(...streamableResult.steps);
    if (!streamableResult.ok) {
      return {
        ok: false,
        started_at: startedAt,
        finished_at: nowIso(),
        steps,
        ...(auth !== undefined ? { auth } : {}),
      };
    }
  }

  let activeClient: Client | undefined;
  let activeTransport: Transport | undefined;
  let stdioCapture: StdioCapture | undefined;
  let traceCollector: TraceCollector | undefined;

  try {
    logger?.info('probe.connect.start');
    const { client, transport, stdio, trace } = await connectWithRetry(
      target,
      probeOptions,
      clientInfo,
    );
    activeClient = client;
    activeTransport = transport;
    stdioCapture = stdio;
    traceCollector = trace;
    steps.push({ name: 'connect', status: 'ok' });
    logger?.info('probe.connect.ok');
  } catch (error) {
    const details = describeError(error);
    const errorStdio = (error as { stdio?: StdioSnapshot }).stdio;
    const errorTrace = (error as { trace?: TraceEntry[] }).trace;
    const data = {
      ...(errorData(details) ?? {}),
      ...(errorStdio !== undefined ? { stdio: errorStdio } : {}),
      ...(errorTrace !== undefined ? { trace: errorTrace } : {}),
    };
    steps.push({
      name: 'connect',
      status: 'error',
      detail: details.message,
      ...(Object.keys(data).length > 0 ? { data } : {}),
    });
    logger?.error('probe.connect.error', {
      detail: details.message,
      ...(Object.keys(data).length > 0 ? { data } : {}),
    });
    return {
      ok: false,
      started_at: startedAt,
      finished_at: nowIso(),
      steps,
      ...(auth !== undefined ? { auth } : {}),
    };
  }

  if (!activeClient || !activeTransport) {
    return {
      ok: false,
      started_at: startedAt,
      finished_at: nowIso(),
      steps: [
        ...steps,
        {
          name: 'connect',
          status: 'error',
          detail: 'Failed to initialize transport.',
        },
      ],
      ...(auth !== undefined ? { auth } : {}),
    };
  }

  const serverInfo = activeClient.getServerVersion?.() ?? undefined;
  const serverInfoDetail = serverInfo ? undefined : 'not available';
  steps.push({
    name: 'server.info',
    status: 'ok',
    ...(serverInfoDetail !== undefined ? { detail: serverInfoDetail } : {}),
  });

  const capabilities = activeClient.getServerCapabilities?.() ?? undefined;
  const capabilitiesDetail = capabilities ? undefined : 'not available';
  steps.push({
    name: 'capabilities',
    status: 'ok',
    ...(capabilitiesDetail !== undefined ? { detail: capabilitiesDetail } : {}),
  });

  let result: unknown = undefined;
  let errorMessage: string | undefined;
  const expectError = resolveExpectError(target.expectError);
  const requestName = `request:${target.method}`;
  const requestPayload =
    target.params === undefined || target.params === null
      ? { method: target.method }
      : { method: target.method, params: target.params as Record<string, unknown> };

  try {
    result = await withRetry(
      () =>
        withTimeout(
          activeClient.request(requestPayload, z.any()),
          probeOptions.timeoutMs,
          requestName,
        ),
      probeOptions.retries,
      probeOptions.retryDelayMs,
    );

    if (expectError.enabled) {
      steps.push({
        name: requestName,
        status: 'error',
        detail: 'Expected request to fail but it succeeded.',
      });
    } else {
      steps.push({ name: requestName, status: 'ok' });
    }
  } catch (error) {
    const details = describeError(error);
    errorMessage = details.message;
    const matches = expectError.enabled
      ? expectError.match
        ? errorMessage.includes(expectError.match)
        : true
      : false;
    steps.push({
      name: requestName,
      status: matches ? 'ok' : 'error',
      detail: errorMessage,
      ...(errorData(details) ? { data: errorData(details) } : {}),
    });
  } finally {
    try {
      await activeTransport.close().catch(() => undefined);
    } finally {
      if (stdioCapture) {
        const snapshot = stdioCapture.snapshot();
        stdioCapture.stop();
        if (snapshot.lines.length > 0 || snapshot.exit_code !== undefined || snapshot.signal) {
          steps.push({ name: 'stdio.stderr', status: 'ok', data: snapshot });
        }
      }
    }
  }

  const finishedAt = nowIso();
  const ok = steps.every((step) => step.status === 'ok');

  logger?.info('probe.raw_request.finished', { ok });
  return {
    ok,
    started_at: startedAt,
    finished_at: finishedAt,
    steps,
    ...(auth !== undefined ? { auth } : {}),
    ...(serverInfo !== undefined ? { server_info: serverInfo } : {}),
    ...(capabilities !== undefined ? { capabilities } : {}),
    ...(result !== undefined ? { result } : {}),
    ...(errorMessage !== undefined ? { error: errorMessage } : {}),
    ...(traceCollector ? { trace: traceCollector.entries() } : {}),
  };
}
