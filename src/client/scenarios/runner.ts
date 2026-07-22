import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ProbeStep } from '../../report.js';
import type { LogFormat, LogLevel } from '../../logging.js';
import type { TransportType } from '../../transport.js';
import { createLogger } from '../../logging.js';
import { createTransport } from '../../transport.js';
import { nowIso } from '../../report.js';
import { parseAllowedHostsEnv } from '../auth/allowlist.js';
import { enforceStdioAllowlist } from './allowlist.js';
import { resolveAuthHeaders } from './scenario_auth.js';
import { enforceHostAllowlist } from './scenario_allowlist.js';
import { resolveScenarioTiming } from './scenario_options.js';
import { loadSnapshots, saveSnapshots } from './scenario_snapshots.js';
import { withRetry, withTimeout } from './scenario_timing.js';
import {
  buildScenarioSummary,
  resolveSnapshotPath,
  resolveStepKey,
  usesSnapshots,
  validateScenario,
} from './scenario_validation.js';
import {
  applyRedactions,
  diffObjects,
  filterDiffEntries,
  formatDiff,
  resolveIgnorePatterns,
  type DiffEntry,
} from './compare.js';

export type ScriptStep = {
  id?: string;
  name?: string;
  tool: string;
  input?: Record<string, unknown>;
  expect?: unknown;
  expect_error?: boolean | string;
  snapshot?: boolean | string;
  ignore_paths?: string[];
};

export type ScriptScenario = {
  name?: string;
  description?: string;
  transport: TransportType;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  timeout_ms?: number;
  retries?: number;
  retry_delay_ms?: number;
  log_level?: LogLevel;
  log_format?: LogFormat;
  use_auth?: boolean;
  access_token?: string;
  access_token_path?: string;
  refresh_token?: string;
  refresh_token_path?: string;
  client_id?: string;
  client_secret?: string;
  token_endpoint?: string;
  scope?: string;
  steps: ScriptStep[];
  snapshot_path?: string;
  ignore_paths?: string[];
};

export type ScriptReport = {
  ok: boolean;
  started_at: string;
  finished_at: string;
  steps: ProbeStep[];
  scenario?: {
    name?: string;
    description?: string;
    path?: string;
    snapshot_path?: string;
  };
};

export type ScriptClientInfo = {
  name: string;
  version: string;
};

type ScriptRunOptions = {
  snapshotWrite?: boolean;
  scenarioPath?: string;
  clientInfo?: ScriptClientInfo;
  logStream?: NodeJS.WritableStream;
};

const DEFAULT_CLIENT_INFO: ScriptClientInfo = {
  name: 'sednalabs-mcp-toolkit-ts',
  version: '0.1.0',
};

async function connect(client: Client, transport: Transport): Promise<void> {
  await client.connect(transport);
}

async function disconnect(transport: Transport): Promise<void> {
  await transport.close();
}


function hasToolError(result: unknown): boolean {
  if (!result || typeof result !== 'object') {
    return false;
  }
  if (!('isError' in result)) {
    return false;
  }
  return Boolean((result as { isError?: unknown }).isError);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatToolIsErrorDetail(actual: unknown): string {
  const base = 'Tool returned isError=true';
  try {
    return `${base}: ${JSON.stringify(actual)}`;
  } catch {
    return base;
  }
}


function normalizeExpected(expected: unknown, ignorePaths: string[]): unknown {
  return applyRedactions(expected, ignorePaths);
}

function normalizeActual(actual: unknown, ignorePaths: string[]): unknown {
  return applyRedactions(actual, ignorePaths);
}

function resolveExpectError(expectError?: boolean | string): { enabled: boolean; match?: string } {
  if (!expectError) {
    return { enabled: false };
  }
  if (typeof expectError === 'string') {
    return { enabled: true, match: expectError };
  }
  return { enabled: true };
}

function buildDiff(
  expected: unknown,
  actual: unknown,
  ignorePaths: string[],
): { diff: DiffEntry[]; detail?: string } {
  const diff = filterDiffEntries(diffObjects(expected, actual), ignorePaths);
  const detail = formatDiff(diff);
  return detail ? { diff, detail } : { diff };
}


export async function runScriptScenario(
  scenario: ScriptScenario,
  options: ScriptRunOptions = {},
): Promise<ScriptReport> {
  const startedAt = nowIso();
  const steps: ProbeStep[] = [];
  const allowedHosts = parseAllowedHostsEnv();
  const clientInfo = options.clientInfo ?? DEFAULT_CLIENT_INFO;

  try {
    validateScenario(scenario);
  } catch (error) {
    steps.push({ name: 'script', status: 'error', detail: formatError(error) });
    return {
      ok: false,
      started_at: startedAt,
      finished_at: nowIso(),
      steps,
      scenario: buildScenarioSummary(scenario, options.scenarioPath),
    };
  }

  const stdioOk = enforceStdioAllowlist(scenario.transport, steps);
  const allowlistOk = stdioOk ? enforceHostAllowlist(scenario, steps, allowedHosts) : false;
  if (!stdioOk || !allowlistOk) {
    return {
      ok: false,
      started_at: startedAt,
      finished_at: nowIso(),
      steps,
      scenario: buildScenarioSummary(scenario, options.scenarioPath),
    };
  }

  const { timeoutMs, retries, retryDelayMs } = resolveScenarioTiming(scenario);

  const logger = scenario.log_level
    ? createLogger({
        level: scenario.log_level,
        format: scenario.log_format ?? 'json',
        ...(options.logStream ? { stream: options.logStream } : {}),
      })
    : undefined;

  const authResult = await resolveAuthHeaders(scenario);
  if (!authResult.ok) {
    steps.push({ name: 'auth', status: 'error', detail: authResult.detail });
    return {
      ok: false,
      started_at: startedAt,
      finished_at: nowIso(),
      steps,
      scenario: buildScenarioSummary(scenario, options.scenarioPath),
    };
  }
  const headers = authResult.headers;

  const target = {
    transportType: scenario.transport,
    ...(scenario.command !== undefined ? { command: scenario.command } : {}),
    ...(scenario.args !== undefined ? { args: scenario.args } : {}),
    ...(scenario.cwd !== undefined ? { cwd: scenario.cwd } : {}),
    ...(scenario.env !== undefined ? { env: scenario.env } : {}),
    ...(scenario.url !== undefined ? { url: scenario.url } : {}),
    ...(headers !== undefined ? { headers } : {}),
  };

  let snapshotPath: string | undefined;
  if (usesSnapshots(scenario)) {
    snapshotPath = resolveSnapshotPath(scenario, options.scenarioPath);
    if (!snapshotPath) {
      steps.push({
        name: 'snapshot',
        status: 'error',
        detail: 'snapshot_path is required when using snapshots',
      });
      return {
        ok: false,
        started_at: startedAt,
        finished_at: nowIso(),
        steps,
        scenario: buildScenarioSummary(scenario, options.scenarioPath),
      };
    }
  }

  const snapshots = snapshotPath
    ? await loadSnapshots(snapshotPath)
    : { version: 1, snapshots: {} };
  let snapshotUpdated = false;

  let client: Client | undefined;
  let transport: Transport | undefined;

  const connectAttempt = async () => {
    if (transport) {
      await disconnect(transport).catch(() => undefined);
    }
    client = new Client(clientInfo);
    transport = createTransport(target);
    try {
      if (!transport) throw new Error('Transport not initialized');
      await withTimeout(connect(client, transport), timeoutMs, 'connect');
    } catch (error) {
      if (transport) {
        await disconnect(transport).catch(() => undefined);
      }
      transport = undefined;
      client = undefined;
      throw error;
    }
  };

  try {
    logger?.info('script.connect.start');
    await withRetry(connectAttempt, retries, retryDelayMs);
    steps.push({ name: 'connect', status: 'ok' });
    logger?.info('script.connect.ok');
  } catch (error) {
    steps.push({ name: 'connect', status: 'error', detail: formatError(error) });
    logger?.error('script.connect.error', { detail: formatError(error) });
    return {
      ok: false,
      started_at: startedAt,
      finished_at: nowIso(),
      steps,
      scenario: buildScenarioSummary(scenario, options.scenarioPath, snapshotPath),
    };
  }

  if (!client || !transport) {
    steps.push({ name: 'connect', status: 'error', detail: 'Failed to initialize transport.' });
    return {
      ok: false,
      started_at: startedAt,
      finished_at: nowIso(),
      steps,
      scenario: buildScenarioSummary(scenario, options.scenarioPath, snapshotPath),
    };
  }

  const activeClient = client;
  const activeTransport = transport;

  for (const [index, step] of scenario.steps.entries()) {
    const stepKey = resolveStepKey(step, index);
    const stepName = `tool.${stepKey}`;
    const ignorePaths = resolveIgnorePatterns(scenario.ignore_paths, step.ignore_paths);
    const snapshotKey = step.snapshot
      ? typeof step.snapshot === 'string'
        ? step.snapshot
        : stepKey
      : undefined;

    let callResult: unknown = undefined;
    let callError: string | undefined;

    try {
      callResult = await withRetry(
        () =>
          withTimeout(
            activeClient.callTool({
              name: step.tool,
              arguments: step.input ?? {},
            }),
            timeoutMs,
            `tools.call:${step.tool}`,
          ),
        retries,
        retryDelayMs,
      );
      if (hasToolError(callResult)) {
        callError = formatToolIsErrorDetail(callResult);
      }
    } catch (error) {
      callError = formatError(error);
    }

    const expectError = resolveExpectError(step.expect_error);
    const redactedActual = normalizeActual(callResult, ignorePaths);
    const expectedFromStep = step.expect;
    let expected: unknown = expectedFromStep;
    let snapshotWritten = false;
    let diffDetail: string | undefined;
    let diffEntries: DiffEntry[] = [];

    if (expected === undefined && snapshotKey) {
      expected = snapshots.snapshots[snapshotKey];
      if (expected === undefined) {
        if (options.snapshotWrite) {
          snapshots.snapshots[snapshotKey] = redactedActual;
          expected = redactedActual;
          snapshotUpdated = true;
          snapshotWritten = true;
        } else {
          callError = callError ?? `Missing snapshot for ${snapshotKey}`;
        }
      }
    }

    const redactedExpected =
      expected !== undefined ? normalizeExpected(expected, ignorePaths) : undefined;

    let status: 'ok' | 'error' = 'ok';
    let detail: string | undefined;

    if (expectError.enabled) {
      if (!callError) {
        status = 'error';
        detail = 'Expected tool call to fail but it succeeded';
      } else if (expectError.match && !callError.includes(expectError.match)) {
        status = 'error';
        detail = `Expected error containing "${expectError.match}"`;
      }
    } else if (callError) {
      status = 'error';
      detail = callError;
    } else if (redactedExpected !== undefined) {
      const diff = buildDiff(redactedExpected, redactedActual, ignorePaths);
      diffEntries = diff.diff;
      diffDetail = diff.detail;
      if (diffEntries.length > 0) {
        status = 'error';
        detail = diffDetail;
        if (options.snapshotWrite && snapshotKey) {
          snapshots.snapshots[snapshotKey] = redactedActual;
          snapshotUpdated = true;
          snapshotWritten = true;
          status = 'ok';
          detail = 'Snapshot updated';
        }
      }
    } else {
      detail = 'No assertion provided';
    }

    const stepData: Record<string, unknown> = {
      tool: step.tool,
      input: step.input ?? {},
      expected: redactedExpected,
      actual: redactedActual,
      diff: diffEntries,
      diff_text: diffDetail,
      snapshot_key: snapshotKey,
      snapshot_written: snapshotWritten,
      ignore_paths: ignorePaths.length > 0 ? ignorePaths : undefined,
      expect_error: expectError.enabled ? step.expect_error : undefined,
    };

    if (callError) {
      stepData.error = { message: callError };
    }

    steps.push({
      name: stepName,
      status,
      data: stepData,
      ...(detail !== undefined ? { detail } : {}),
    });
  }

  try {
    await disconnect(activeTransport);
    steps.push({ name: 'disconnect', status: 'ok' });
  } catch (error) {
    steps.push({ name: 'disconnect', status: 'error', detail: formatError(error) });
  }

  if (snapshotPath && snapshotUpdated) {
    await saveSnapshots(snapshotPath, snapshots);
  }

  const ok = steps.every((step) => step.status === 'ok');
  return {
    ok,
    started_at: startedAt,
    finished_at: nowIso(),
    steps,
    scenario: buildScenarioSummary(scenario, options.scenarioPath, snapshotPath),
  };
}
