import { describe, expect, it, vi } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool } from '../tools/registry.js';

describe('registerTool', () => {
  it('rejects registry collisions after name normalization', () => {
    const registry = new Map<string, string>();
    const registered: string[] = [];
    const server = {
      registerTool: (name: string) => {
        registered.push(name);
      },
    } as unknown as McpServer;

    registerTool(
      server,
      'alpha.one',
      {
        title: 'Alpha One',
        inputSchema: z.object({}),
      },
      async () => ({ content: [] }),
      { nameMode: 'safe', registry },
    );

    expect(registered).toEqual(['alpha_one']);

    expect(() =>
      registerTool(
        server,
        'alpha_one',
        {
          title: 'Alpha Underscore',
          inputSchema: z.object({}),
        },
        async () => ({ content: [] }),
        { nameMode: 'safe', registry },
      ),
    ).toThrow('Tool name collision');
  });

  it('passes request extra for tools without input schema', async () => {
    let capturedHandler: ((...args: unknown[]) => Promise<unknown>) | undefined;
    const server = {
      registerTool: (_name: string, _definition: unknown, handler: (...args: unknown[]) => Promise<unknown>) => {
        capturedHandler = handler;
      },
    } as unknown as McpServer;
    const handler = vi.fn(async () => ({ content: [] }));

    registerTool(
      server,
      'realms.list',
      {
        title: 'List realms',
      },
      handler,
    );

    expect(capturedHandler).toBeDefined();
    const fakeExtra = {
      requestId: 1,
      signal: new AbortController().signal,
    };
    await capturedHandler?.(fakeExtra);

    expect(handler).toHaveBeenCalledWith(undefined, fakeExtra);
  });
});
