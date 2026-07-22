import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProbeStep, ProbeStepStatus } from '../report.js';
import path from 'node:path';
import { runProbe } from '../client/probe/runner.js';

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

function canonicalizeSteps(steps: ProbeStep[]) {
  return steps.map((step) => ({
    name: step.name,
    status: step.status,
    detail: step.detail,
  }));
}

function buildStep(name: string, status: ProbeStepStatus, detail?: string): ProbeStep {
  return {
    name,
    status,
    ...(detail !== undefined ? { detail } : {}),
  };
}

describe('runProbe', () => {
  it('returns a successful report with expected step ordering', async () => {
    const report = await runProbe({
      transportType: 'stdio',
      command: process.execPath,
      args: [fixturePath],
      timeoutMs: 5000,
    });

    const expectedSteps = [
      buildStep('stdio.allowlist', 'ok'),
      buildStep('host.allowlist', 'ok', 'not applicable'),
      buildStep('auth.prm', 'ok', 'not applicable'),
      buildStep('connect', 'ok'),
      buildStep('server.info', 'ok', report.server_info ? undefined : 'not available'),
      buildStep('capabilities', 'ok', report.capabilities ? undefined : 'not available'),
      buildStep('tools.list', 'ok'),
      buildStep('resources.list', 'ok', 'not supported'),
      buildStep('prompts.list', 'ok', 'not supported'),
      buildStep('disconnect', 'ok'),
    ];

    expect({
      ok: report.ok,
      steps: canonicalizeSteps(report.steps),
    }).toEqual({
      ok: true,
      steps: expectedSteps,
    });

    expect(report.tools).toBeDefined();
  });

  it('reports connect failures with a non-ok report', async () => {
    const report = await runProbe({
      transportType: 'stdio',
      command: process.execPath,
      args: ['missing-script.js'],
      timeoutMs: 2000,
      retries: 0,
    });

    expect({
      ok: report.ok,
      stepNames: report.steps.map((step: ProbeStep) => step.name),
      connectStatus: report.steps.find((step: ProbeStep) => step.name === 'connect')?.status,
    }).toEqual({
      ok: false,
      stepNames: ['stdio.allowlist', 'host.allowlist', 'auth.prm', 'connect'],
      connectStatus: 'error',
    });
  });
});
