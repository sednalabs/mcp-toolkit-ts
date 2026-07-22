import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { runScriptScenario, type ScriptScenario } from '../client/scenarios/runner.js';

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

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-probe-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('runScriptScenario', () => {
  it('writes and reuses snapshots for tool calls', async () => {
    await withTempDir(async (dir) => {
      const scenarioPath = path.join(dir, 'scenario.json');
      const scenario: ScriptScenario = {
        name: 'ping snapshot',
        transport: 'stdio',
        command: process.execPath,
        args: [fixturePath],
        steps: [
          {
            id: 'ping',
            tool: 'ping',
            snapshot: true,
          },
        ],
      };
      await writeFile(scenarioPath, JSON.stringify(scenario, null, 2), 'utf8');

      const first = await runScriptScenario(scenario, {
        scenarioPath,
        snapshotWrite: true,
      });
      expect({
        ok: first.ok,
        steps: first.steps.map((step) => ({ name: step.name, status: step.status })),
      }).toEqual({
        ok: true,
        steps: [
          { name: 'stdio.allowlist', status: 'ok' },
          { name: 'host.allowlist', status: 'ok' },
          { name: 'connect', status: 'ok' },
          { name: 'tool.ping', status: 'ok' },
          { name: 'disconnect', status: 'ok' },
        ],
      });

      const snapshotPath = `${scenarioPath}.snapshots.json`;
      const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as {
        version: number;
        snapshots: Record<string, unknown>;
      };
      expect({
        version: snapshot.version,
        keys: Object.keys(snapshot.snapshots),
      }).toEqual({
        version: 1,
        keys: ['ping'],
      });

      const second = await runScriptScenario(scenario, { scenarioPath });
      expect({
        ok: second.ok,
        steps: second.steps.map((step) => ({ name: step.name, status: step.status })),
      }).toEqual({
        ok: true,
        steps: [
          { name: 'stdio.allowlist', status: 'ok' },
          { name: 'host.allowlist', status: 'ok' },
          { name: 'connect', status: 'ok' },
          { name: 'tool.ping', status: 'ok' },
          { name: 'disconnect', status: 'ok' },
        ],
      });
    });
  });

  it('matches expect_error strings against serialized tool error payloads', async () => {
    const scenario: ScriptScenario = {
      name: 'error matcher',
      transport: 'stdio',
      command: process.execPath,
      args: [fixturePath],
      steps: [
        {
          id: 'fail',
          tool: 'fail',
          expect_error: 'Synthetic failure',
        },
      ],
    };

    const report = await runScriptScenario(scenario);
    expect({
      ok: report.ok,
      steps: report.steps.map((step) => ({ name: step.name, status: step.status })),
    }).toEqual({
      ok: true,
      steps: [
        { name: 'stdio.allowlist', status: 'ok' },
        { name: 'host.allowlist', status: 'ok' },
        { name: 'connect', status: 'ok' },
        { name: 'tool.fail', status: 'ok' },
        { name: 'disconnect', status: 'ok' },
      ],
    });
  });
});
