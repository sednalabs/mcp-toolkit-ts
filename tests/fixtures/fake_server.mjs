#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError, RequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({
  name: 'mcp-probe-test-server',
  version: '0.0.0',
  instructions: 'Fake MCP server fixture for probe tests.',
});

const FailRequestSchema = RequestSchema.extend({
  method: z.literal('probe/fail'),
});

server.server.setRequestHandler(FailRequestSchema, async () => {
  throw new McpError(ErrorCode.InternalError, 'Synthetic request failure', {
    reason: 'boom',
  });
});

server.registerTool(
  'ping',
  {
    title: 'Ping',
    description: 'Return a pong response.',
    inputSchema: z.object({}),
  },
  async () => ({
    content: [{ type: 'text', text: 'pong' }],
  }),
);

server.registerTool(
  'fail',
  {
    title: 'Fail',
    description: 'Return a structured MCP error for testing.',
    inputSchema: z.object({}),
  },
  async () => {
    throw new McpError(ErrorCode.InternalError, 'Synthetic failure', { reason: 'boom' });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
