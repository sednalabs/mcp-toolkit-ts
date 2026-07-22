/**
 * # Streamable HTTP replay probe
 *
 * ## Rationale
 * Validates Last-Event-ID replay for streamable HTTP servers by exercising
 * initialize, SSE streaming, and resume with the event store.
 *
 * ## Security Boundaries
 * - Treats URLs and headers as untrusted; host allowlist enforcement is mandatory.
 * - Does not persist tokens; uses provided headers only for this run.
 *
 * ## References
 * - `src/client/probe/index.ts` (public probe facade)
 */

import type { ProbeStep, ReplayProbeReport } from '../../report.js';
import { nowIso } from '../../report.js';
import type { TransportOptions } from '../../transport.js';
import { parseAllowedHostsEnv } from '../auth/allowlist.js';
import { describeError, errorData } from './errors.js';
import { enforceHostAllowlist } from './probe_allowlist.js';
import { fetchWithTimeout } from './probe_http.js';
import { resolveProbeOptions } from './probe_options.js';

export type ReplayProbeTarget = TransportOptions & {
  timeoutMs?: number;
  headers?: Record<string, string>;
};

type ReplayIds = {
  eventId: string;
  lastEventId: string;
};

const ACCEPT_MCP = 'application/json, text/event-stream';

function deriveReplayIds(eventId: string): ReplayIds | undefined {
  const match = eventId.trim().match(/^(-?\d+)(?:\/(.+))?$/);
  if (!match) return undefined;
  const index = Number(match[1]);
  if (!Number.isFinite(index)) return undefined;
  const prevIndex = index - 1;
  const suffix = match[2];
  const lastEventId = suffix ? `${prevIndex}/${suffix}` : `${prevIndex}`;
  return { eventId, lastEventId };
}

async function readSseEventId(
  response: Response,
  timeoutMs: number,
  abort: () => void,
): Promise<string | undefined> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    abort();
  }, timeoutMs);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('id:')) {
          return line.slice(3).trim();
        }
      }
    }
  } catch (error) {
    if (!timedOut) {
      throw error;
    }
  } finally {
    clearTimeout(timer);
    try {
      await reader.cancel();
    } catch {
      // ignore cancellation errors
    }
  }
  return undefined;
}

/**
 * Run a Last-Event-ID replay probe against a streamable HTTP endpoint.
 *
 * # Security
 * Enforces outbound host allowlists and never logs tokens.
 *
 * # Notes
 * Uses tools/list to generate a replayable event.
 */
export async function runReplayProbe(target: ReplayProbeTarget): Promise<ReplayProbeReport> {
  const startedAt = nowIso();
  const steps: ProbeStep[] = [];
  const probeOptions = resolveProbeOptions(target);
  const allowedHosts = parseAllowedHostsEnv();

  if (target.transportType && target.transportType !== 'streamable-http') {
    steps.push({
      name: 'replay.transport',
      status: 'error',
      detail: 'Replay probe only supports streamable-http transport.',
    });
    return { ok: false, started_at: startedAt, finished_at: nowIso(), steps };
  }

  const url = target.url;
  const allowlistOk = enforceHostAllowlist(
    {
      transportType: 'streamable-http',
      ...(url ? { url } : {}),
    },
    steps,
    allowedHosts,
  );
  if (!allowlistOk) {
    return { ok: false, started_at: startedAt, finished_at: nowIso(), steps };
  }
  if (!url) {
    steps.push({
      name: 'replay.init',
      status: 'error',
      detail: 'Missing target URL.',
    });
    return { ok: false, started_at: startedAt, finished_at: nowIso(), steps };
  }

  const baseHeaders = target.headers ?? {};
  let sessionId: string | undefined;
  let eventId: string | undefined;
  let lastEventId: string | undefined;

  try {
    const initResponse = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          ...baseHeaders,
          Accept: ACCEPT_MCP,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'mcp-probe', version: '0.1' },
          },
        }),
      },
      probeOptions.timeoutMs,
    );
    if (!initResponse.ok) {
      steps.push({
        name: 'replay.init',
        status: 'error',
        detail: `HTTP ${initResponse.status}`,
      });
      return { ok: false, started_at: startedAt, finished_at: nowIso(), steps };
    }
    sessionId = initResponse.headers.get('mcp-session-id')?.trim() || undefined;
    if (!sessionId) {
      steps.push({
        name: 'replay.init',
        status: 'error',
        detail: 'Missing Mcp-Session-Id header.',
      });
      return { ok: false, started_at: startedAt, finished_at: nowIso(), steps };
    }
    steps.push({ name: 'replay.init', status: 'ok' });

    const sseController = new AbortController();
    const sseResponse = await fetch(url, {
      method: 'GET',
      headers: {
        ...baseHeaders,
        Accept: 'text/event-stream',
        'Mcp-Session-Id': sessionId,
      },
      signal: sseController.signal,
    });
    if (!sseResponse.ok) {
      steps.push({
        name: 'replay.stream.open',
        status: 'error',
        detail: `HTTP ${sseResponse.status}`,
      });
      return { ok: false, started_at: startedAt, finished_at: nowIso(), steps };
    }
    steps.push({ name: 'replay.stream.open', status: 'ok' });

    const sseRead = readSseEventId(sseResponse, probeOptions.timeoutMs, () => {
      sseController.abort();
    });

    const listResponse = await fetchWithTimeout(
      url,
      {
        method: 'POST',
        headers: {
          ...baseHeaders,
          Accept: ACCEPT_MCP,
          'Content-Type': 'application/json',
          'Mcp-Session-Id': sessionId,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/list',
          params: {},
        }),
      },
      probeOptions.timeoutMs,
    );
    if (!listResponse.ok) {
      steps.push({
        name: 'replay.trigger',
        status: 'error',
        detail: `HTTP ${listResponse.status}`,
      });
    } else {
      steps.push({ name: 'replay.trigger', status: 'ok' });
    }

    eventId = await sseRead;
    try {
      sseController.abort();
    } catch {
      // ignore abort errors
    }

    if (!eventId) {
      steps.push({
        name: 'replay.capture',
        status: 'error',
        detail: 'No event id captured from SSE stream.',
      });
      return { ok: false, started_at: startedAt, finished_at: nowIso(), steps, session_id: sessionId };
    }

    const replayIds = deriveReplayIds(eventId);
    if (!replayIds) {
      steps.push({
        name: 'replay.capture',
        status: 'error',
        detail: `Unexpected event id format: ${eventId}`,
      });
      return { ok: false, started_at: startedAt, finished_at: nowIso(), steps, session_id: sessionId };
    }
    lastEventId = replayIds.lastEventId;
    steps.push({ name: 'replay.capture', status: 'ok' });

    const closeResponse = await fetchWithTimeout(
      url,
      {
        method: 'DELETE',
        headers: {
          ...baseHeaders,
          'Mcp-Session-Id': sessionId,
        },
      },
      probeOptions.timeoutMs,
    );
    if (!closeResponse.ok) {
      steps.push({
        name: 'replay.close',
        status: 'error',
        detail: `HTTP ${closeResponse.status}`,
      });
    } else {
      steps.push({ name: 'replay.close', status: 'ok' });
    }

    const replayController = new AbortController();
    const replayResponse = await fetch(url, {
      method: 'GET',
      headers: {
        ...baseHeaders,
        Accept: 'text/event-stream',
        'Mcp-Session-Id': sessionId,
        'Last-Event-ID': lastEventId,
      },
      signal: replayController.signal,
    });
    if (!replayResponse.ok) {
      steps.push({
        name: 'replay.resume',
        status: 'error',
        detail: `HTTP ${replayResponse.status}`,
      });
      return {
        ok: false,
        started_at: startedAt,
        finished_at: nowIso(),
        steps,
        session_id: sessionId,
        event_id: eventId,
        last_event_id: lastEventId,
      };
    }

    const replayEventId = await readSseEventId(replayResponse, probeOptions.timeoutMs, () => {
      replayController.abort();
    });
    try {
      replayController.abort();
    } catch {
      // ignore abort errors
    }
    if (!replayEventId) {
      steps.push({
        name: 'replay.resume',
        status: 'error',
        detail: 'No replay event received.',
      });
      return {
        ok: false,
        started_at: startedAt,
        finished_at: nowIso(),
        steps,
        session_id: sessionId,
        event_id: eventId,
        last_event_id: lastEventId,
      };
    }

    steps.push({ name: 'replay.resume', status: 'ok' });
    return {
      ok: steps.every((step) => step.status === 'ok'),
      started_at: startedAt,
      finished_at: nowIso(),
      steps,
      session_id: sessionId,
      event_id: eventId,
      last_event_id: lastEventId,
    };
  } catch (error) {
    const details = describeError(error);
    steps.push({
      name: 'replay.error',
      status: 'error',
      detail: details.message,
      ...(errorData(details) ? { data: errorData(details) } : {}),
    });
    return {
      ok: false,
      started_at: startedAt,
      finished_at: nowIso(),
      steps,
      ...(sessionId !== undefined ? { session_id: sessionId } : {}),
      ...(eventId !== undefined ? { event_id: eventId } : {}),
      ...(lastEventId !== undefined ? { last_event_id: lastEventId } : {}),
    };
  }
}
