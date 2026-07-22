import { describe, expect, it } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { DiscoveryRegistry, registerDiscoveryResources } from '../server/discovery.js';

describe('DiscoveryRegistry', () => {
  it('builds a stable tool index snapshot', () => {
    const registry = new DiscoveryRegistry({
      now: () => new Date('2025-01-01T00:00:00Z'),
    });
    registry.registerTool({
      name: 'alpha.list',
      exampleUri: 'mcp-toolkit://examples/alpha.list',
      title: 'Alpha list',
      description: 'List alpha resources.',
      categories: ['alpha'],
      tags: ['fast'],
    });

    const snapshot = registry.snapshotIndex();
    const parsed = JSON.parse(snapshot.json) as {
      tool_count: number;
      tools: Array<Record<string, unknown>>;
      generated_at: string;
    };

    expect(parsed.tool_count).toBe(1);
    expect(parsed.generated_at).toBe('2025-01-01T00:00:00.000Z');
    expect(parsed.tools[0]).toMatchObject({
      name: 'alpha.list',
      example_uri: 'mcp-toolkit://examples/alpha.list',
      title: 'Alpha list',
      description: 'List alpha resources.',
      categories: ['alpha'],
      tags: ['fast'],
    });
  });

  it('enforces payload budgets on registration', () => {
    const registry = new DiscoveryRegistry({ maxPayloadBytes: 80 });
    expect(() =>
      registry.registerTool({
        name: 'alpha',
        exampleUri: 'mcp-toolkit://examples/alpha',
        description: 'x'.repeat(200),
      }),
    ).toThrow('Discovery tool index exceeds payload budget');
  });
});

describe('registerDiscoveryResources', () => {
  it('registers discovery resources with expected URIs', () => {
    const registry = new DiscoveryRegistry();
    registry.registerTool({
      name: 'alpha',
      exampleUri: 'mcp-toolkit://examples/alpha',
    });

    const registered: Array<{
      name: string;
      uri: string | ResourceTemplate;
      handler: (...args: unknown[]) => unknown;
    }> = [];

    const server = {
      registerResource: (
        name: string,
        uri: string | ResourceTemplate,
        _config: unknown,
        handler: (...args: unknown[]) => unknown,
      ) => {
        registered.push({ name, uri, handler });
      },
    } as unknown as McpServer;

    registerDiscoveryResources(server, registry, {
      baseUri: 'mcp-toolkit://discovery',
      capabilities: { tools: {}, resources: {} },
    });

    const tools = registered.find((entry) => entry.name === 'discovery.tools');
    const examples = registered.find((entry) => entry.name === 'discovery.examples');
    const attest = registered.find((entry) => entry.name === 'discovery.attest');

    expect(tools?.uri).toBe('mcp-toolkit://discovery/tools');
    expect(examples?.uri).toBeInstanceOf(ResourceTemplate);
    expect(String((examples?.uri as ResourceTemplate).uriTemplate)).toBe(
      'mcp-toolkit://discovery/examples/{tool}',
    );
    expect(attest?.uri).toBe('mcp-toolkit://discovery/attest');

    const toolsPayload = tools?.handler();
    const toolsJson = JSON.parse((toolsPayload as { contents: [{ text: string }] }).contents[0].text);
    expect(toolsJson.tool_count).toBe(1);

    const examplesPayload = examples?.handler('mcp-toolkit://discovery/examples/alpha', {
      tool: 'alpha',
    });
    const examplesJson = JSON.parse(
      (examplesPayload as { contents: [{ text: string }] }).contents[0].text,
    );
    expect(examplesJson.example_uri).toBe('mcp-toolkit://examples/alpha');

    const attestPayload = attest?.handler();
    const attestJson = JSON.parse(
      (attestPayload as { contents: [{ text: string }] }).contents[0].text,
    );
    expect(attestJson.capabilities).toEqual({ tools: {}, resources: {} });
  });
});
