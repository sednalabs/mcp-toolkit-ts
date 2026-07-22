/**
 * # MCP Transports
 *
 * Factory for creating and configuring MCP client transports.
 *
 * ## Rationale
 * Provides a unified way to initialize Stdio, SSE, and Streamable HTTP transports
 * with standard configuration (headers, env, working directories). It ensures
 * that transport-level concerns like executable resolution are handled consistently.
 *
 * ## Security Boundaries
 * * **Executable Isolation**: Uses `findActualExecutable` to safely resolve stdio commands.
 * * **Environment Sanitization**: Merges host environment with explicit overrides.
 */

import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { findActualExecutable } from './internal/exec_resolver.js';

export type TransportType = 'stdio' | 'sse' | 'streamable-http';

export type TransportOptions = {
  transportType: TransportType;
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  cwd?: string;
  env?: Record<string, string>;
};

function createStdioTransport(options: TransportOptions): Transport {
  const args = options.args ?? [];
  const processEnv: Record<string, string> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      processEnv[key] = value;
    }
  }

  const env = {
    ...getDefaultEnvironment(),
    ...processEnv,
    ...(options.env ?? {}),
  };

  const { cmd: actualCommand, args: actualArgs } = findActualExecutable(
    options.command ?? '',
    args,
  );

  return new StdioClientTransport({
    command: actualCommand,
    args: actualArgs,
    env,
    ...(options.cwd ? { cwd: options.cwd } : {}),
    stderr: 'pipe',
  });
}

export function createTransport(options: TransportOptions): Transport {
  const { transportType } = options;

  if (transportType === 'stdio') {
    if (!options.command) {
      throw new Error('command must be provided for stdio transport.');
    }
    return createStdioTransport(options);
  }

  if (!options.url) {
    throw new Error('url must be provided for sse/streamable-http transport.');
  }

  const url = new URL(options.url);
  const transportOptions = options.headers
    ? {
        requestInit: {
          headers: options.headers,
        },
      }
    : undefined;

  if (transportType === 'sse') {
    return new SSEClientTransport(url, transportOptions);
  }

  if (transportType === 'streamable-http') {
    return new StreamableHTTPClientTransport(url, transportOptions) as Transport;
  }

  throw new Error(`Unsupported transport type: ${transportType}`);
}
