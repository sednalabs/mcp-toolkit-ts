import { describe, expect, it } from 'vitest';
import { MCP_LOGGING_SCHEMA, McpLogEmitter } from '../mcp_logging.js';

describe('McpLogEmitter', () => {
  it('redacts sensitive keys and strips stacks', async () => {
    const calls: Array<{ payload: Record<string, unknown> }> = [];
    const emitter = new McpLogEmitter(
      async (payload) => {
        calls.push({ payload: payload.data });
      },
      {
        enabled: true,
        serverLevel: 'info',
        maxLevel: 'info',
        rateLimitPerSecond: 100,
        rateLimitBurst: 100,
      },
    );

    await emitter.emit({
      sessionId: 'sess-1',
      level: 'info',
      message: 'resource.subscribe.start',
      data: {
        token: 'secret',
        stack: 'trace',
        nested: { password: 'nope' },
      },
    });

    expect(calls.length).toBe(1);
    const payload = calls[0]!.payload;
    expect(payload.event).toBe('resource.subscribe.start');
    expect(payload.token).toBe('<redacted>');
    expect(payload.stack).toBeUndefined();
    expect((payload.nested as Record<string, unknown>).password).toBe('<redacted>');
  });

  it('rate limits info logs', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const emitter = new McpLogEmitter(
      async (payload) => {
        calls.push(payload.data);
      },
      {
        enabled: true,
        serverLevel: 'info',
        maxLevel: 'info',
        rateLimitPerSecond: 1,
        rateLimitBurst: 1,
      },
    );

    await emitter.emit({ sessionId: 'sess-2', level: 'info', message: 'event.one' });
    await emitter.emit({ sessionId: 'sess-2', level: 'info', message: 'event.two' });

    expect(calls.length).toBe(1);
  });

  it('documents throttled tool error fields', () => {
    const toolError = MCP_LOGGING_SCHEMA.events.find(
      (event) => event.name === 'tool.call.error',
    );
    expect(toolError).toBeDefined();
    expect(toolError?.fields).toMatchObject({
      tool_name: 'string',
      error: 'string',
      reason: 'string',
      retry_after_s: 'number',
    });
  });
});
