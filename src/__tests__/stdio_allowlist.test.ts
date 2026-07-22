import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { runProbe } from '../client/probe/runner.js';

const fixturePath = path.resolve('tests/fixtures/fake_server.mjs');

describe('stdio allowlist', () => {
  let priorAllowStdio: string | undefined;

  beforeEach(() => {
    priorAllowStdio = process.env.MCP_PROBE_ALLOW_STDIO;
    delete process.env.MCP_PROBE_ALLOW_STDIO;
  });

  afterEach(() => {
    if (priorAllowStdio === undefined) {
      delete process.env.MCP_PROBE_ALLOW_STDIO;
    } else {
      process.env.MCP_PROBE_ALLOW_STDIO = priorAllowStdio;
    }
  });

  it('blocks stdio when not explicitly enabled', async () => {
    const report = await runProbe({
      transportType: 'stdio',
      command: process.execPath,
      args: [fixturePath],
      timeoutMs: 5000,
    });

    const step = report.steps.find((entry) => entry.name === 'stdio.allowlist');
    expect(report.ok).toBe(false);
    expect(step?.status).toBe('error');
  });
});
