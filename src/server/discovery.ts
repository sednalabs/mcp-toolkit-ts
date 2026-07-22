import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getStartupSourceFingerprint, initStartupSourceFingerprint } from './fingerprint.js';

const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;
const DEFAULT_MAX_TITLE_CHARS = 120;
const DEFAULT_MAX_DESCRIPTION_CHARS = 280;

export type DiscoveryToolMetadata = {
  exampleUri: string;
  categories?: string[];
  tags?: string[];
  title?: string;
  description?: string;
};

export type DiscoveryToolEntry = {
  name: string;
  example_uri: string;
  title?: string;
  description?: string;
  categories?: string[];
  tags?: string[];
  logical_name?: string;
};

export type DiscoveryToolIndex = {
  schema_version: 'v1';
  generated_at: string;
  tool_count: number;
  tools: DiscoveryToolEntry[];
};

export type DiscoveryRegistryOptions = {
  maxPayloadBytes?: number;
  maxTitleChars?: number;
  maxDescriptionChars?: number;
  now?: () => Date;
};

export type DiscoveryRegistrySnapshot = {
  index: DiscoveryToolIndex;
  json: string;
  sizeBytes: number;
};

type DiscoveryToolRegistration = {
  name: string;
  logicalName?: string;
  title?: string;
  description?: string;
  exampleUri: string;
  categories?: string[];
  tags?: string[];
};

function normalizeList(values?: string[]): string[] | undefined {
  if (!values) return undefined;
  const cleaned = values
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return cleaned.length > 0 ? cleaned : undefined;
}

function truncateText(value: string | undefined, maxChars: number): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, Math.max(0, maxChars - 3)).trim()}...`;
}

function buildIndex(
  entries: Map<string, DiscoveryToolEntry>,
  now: () => Date,
): DiscoveryRegistrySnapshot {
  const tools = Array.from(entries.values()).sort((left, right) =>
    left.name.localeCompare(right.name),
  );
  const index: DiscoveryToolIndex = {
    schema_version: 'v1',
    generated_at: now().toISOString(),
    tool_count: tools.length,
    tools,
  };
  const json = JSON.stringify(index);
  const sizeBytes = Buffer.byteLength(json, 'utf8');
  return { index, json, sizeBytes };
}

export class DiscoveryRegistry {
  private entries = new Map<string, DiscoveryToolEntry>();
  private snapshot: DiscoveryRegistrySnapshot;
  private maxPayloadBytes: number;
  private maxTitleChars: number;
  private maxDescriptionChars: number;
  private now: () => Date;

  constructor(options?: DiscoveryRegistryOptions) {
    this.maxPayloadBytes = options?.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.maxTitleChars = options?.maxTitleChars ?? DEFAULT_MAX_TITLE_CHARS;
    this.maxDescriptionChars = options?.maxDescriptionChars ?? DEFAULT_MAX_DESCRIPTION_CHARS;
    this.now = options?.now ?? (() => new Date());
    this.snapshot = buildIndex(this.entries, this.now);
  }

  registerTool(entry: DiscoveryToolRegistration): void {
    const exampleUri = entry.exampleUri?.trim();
    if (!exampleUri) {
      throw new Error(`Discovery entry for ${entry.name} requires exampleUri.`);
    }

    const title = truncateText(entry.title, this.maxTitleChars);
    const description = truncateText(entry.description, this.maxDescriptionChars);
    const categories = normalizeList(entry.categories);
    const tags = normalizeList(entry.tags);

    const nextEntries = new Map(this.entries);
    const normalized: DiscoveryToolEntry = {
      name: entry.name,
      example_uri: exampleUri,
      ...(entry.logicalName && entry.logicalName !== entry.name
        ? { logical_name: entry.logicalName }
        : {}),
      ...(title ? { title } : {}),
      ...(description ? { description } : {}),
      ...(categories ? { categories } : {}),
      ...(tags ? { tags } : {}),
    };
    nextEntries.set(entry.name, normalized);
    const nextSnapshot = buildIndex(nextEntries, this.now);
    if (nextSnapshot.sizeBytes > this.maxPayloadBytes) {
      throw new Error(
        `Discovery tool index exceeds payload budget (${nextSnapshot.sizeBytes} bytes > ${this.maxPayloadBytes} bytes).`,
      );
    }
    this.entries = nextEntries;
    this.snapshot = nextSnapshot;
  }

  getTool(name: string): DiscoveryToolEntry | undefined {
    return this.entries.get(name);
  }

  snapshotIndex(): DiscoveryRegistrySnapshot {
    return this.snapshot;
  }
}

export type DiscoveryResourceOptions = {
  baseUri?: string;
  toolsTitle?: string;
  toolsDescription?: string;
  examplesTitle?: string;
  examplesDescription?: string;
  attestTitle?: string;
  attestDescription?: string;
  sourceRoot?: string;
  capabilities?: unknown;
  guardConfig?: Record<string, unknown>;
};

function normalizeBaseUri(baseUri: string): string {
  return baseUri.endsWith('/') ? baseUri.slice(0, -1) : baseUri;
}

export function registerDiscoveryResources(
  server: McpServer,
  registry: DiscoveryRegistry,
  options?: DiscoveryResourceOptions,
): void {
  const baseUri = normalizeBaseUri(options?.baseUri ?? 'mcp-toolkit://discovery');
  const toolsUri = `${baseUri}/tools`;
  const attestUri = `${baseUri}/attest`;
  const examplesTemplate = new ResourceTemplate(`${baseUri}/examples/{tool}`, { list: undefined });

  if (options?.sourceRoot) {
    initStartupSourceFingerprint(options.sourceRoot);
  }

  const sourceFingerprint = getStartupSourceFingerprint();
  const attestPayload: Record<string, unknown> = {
    schema_version: 'v1',
    generated_at: new Date().toISOString(),
    source_fingerprint: sourceFingerprint,
  };
  if (options?.capabilities !== undefined) {
    attestPayload.capabilities = options.capabilities;
  }
  if (options?.guardConfig) {
    attestPayload.guard_config = options.guardConfig;
  }
  const attestJson = JSON.stringify(attestPayload);

  server.registerResource(
    'discovery.tools',
    toolsUri,
    {
      title: options?.toolsTitle ?? 'Discovery tool index',
      description:
        options?.toolsDescription ??
        'Structured index of tools with example URIs for cold-start discovery.',
      mimeType: 'application/json',
    },
    () => {
      const snapshot = registry.snapshotIndex();
      return {
        contents: [
          {
            uri: toolsUri,
            mimeType: 'application/json',
            text: snapshot.json,
          },
        ],
      };
    },
  );

  server.registerResource(
    'discovery.examples',
    examplesTemplate,
    {
      title: options?.examplesTitle ?? 'Discovery tool examples',
      description:
        options?.examplesDescription ??
        'Lookup helper that returns the example URI for a tool.',
      mimeType: 'application/json',
    },
    (_uri, variables) => {
      const toolName = typeof variables.tool === 'string' ? variables.tool : '';
      const entry = registry.getTool(toolName);
      if (!entry) {
        return {
          contents: [
            {
              uri: `${baseUri}/examples/${toolName}`,
              mimeType: 'application/json',
              text: JSON.stringify({
                tool: toolName,
                error: 'Unknown tool name.',
              }),
            },
          ],
        };
      }
      const payload = {
        tool: entry.name,
        example_uri: entry.example_uri,
        ...(entry.title ? { title: entry.title } : {}),
        ...(entry.description ? { description: entry.description } : {}),
      };
      return {
        contents: [
          {
            uri: `${baseUri}/examples/${toolName}`,
            mimeType: 'application/json',
            text: JSON.stringify(payload),
          },
        ],
      };
    },
  );

  server.registerResource(
    'discovery.attest',
    attestUri,
    {
      title: options?.attestTitle ?? 'Discovery attestation',
      description:
        options?.attestDescription ??
        'Source fingerprint and server capability manifest.',
      mimeType: 'application/json',
    },
    () => ({
      contents: [
        {
          uri: attestUri,
          mimeType: 'application/json',
          text: attestJson,
        },
      ],
    }),
  );
}
