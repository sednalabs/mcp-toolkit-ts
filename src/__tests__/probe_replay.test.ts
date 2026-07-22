import { describe, expect, it } from 'vitest';
import { runReplayProbe } from '../client/probe/replay.js';

describe('runReplayProbe', () => {
  it('rejects non-streamable transports', async () => {
    const report = await runReplayProbe({ transportType: 'stdio' });
    expect(report.ok).toBe(false);
    expect(report.steps[0]?.name).toBe('replay.transport');
  });
});
