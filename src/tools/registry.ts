import type { AnySchema } from '@modelcontextprotocol/sdk/server/zod-compat.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  requireScopes,
  toolContextFromExtra,
  type ScopeGuardContext,
  type ToolContext,
  type ToolExtra,
} from './guards.js';

export type ToolNameMode = 'dot' | 'safe';

export type ToolCallOutcome = {
  tool: string;
  status: 'success' | 'error';
  durationMs: number;
  context: ToolContext;
};

export type ScopeGuard = (
  extra: ToolExtra,
  requiredScopes: string[],
  context?: ScopeGuardContext,
) => CallToolResult | ToolContext;

export type ToolRegistryOptions = {
  nameMode?: ToolNameMode;
  registry?: Map<string, string>;
  scopeGuard?: ScopeGuard;
  onCall?: (event: ToolCallOutcome) => void;
};

type ToolHandler<Args, Result extends CallToolResult = CallToolResult> = (
  args: Args,
  extra: ToolExtra,
) => Promise<Result> | Result;

type ToolDefinition = {
  title?: string;
  description?: string;
  inputSchema?: AnySchema;
  outputSchema?: AnySchema;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
  requiredScopes?: string[];
};

const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const defaultRegistry = new Map<string, string>();

function assertObjectSchema(
  toolName: string,
  label: 'inputSchema' | 'outputSchema',
  schema: unknown,
): void {
  if (!schema) return;
  if (!(schema instanceof z.ZodType)) {
    throw new Error(`Tool ${toolName} ${label} must be a Zod schema.`);
  }
  if (!(schema instanceof z.ZodObject)) {
    throw new Error(`Tool ${toolName} ${label} must be a Zod object schema (z.object(...)).`);
  }
}

function normalizeToolName(name: string, mode: ToolNameMode): string {
  if (mode === 'dot') {
    return name;
  }
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (!TOOL_NAME_PATTERN.test(safe)) {
    throw new Error(`Tool name ${name} normalized to invalid name ${safe}.`);
  }
  return safe;
}

function isCallToolResult(value: ToolContext | CallToolResult): value is CallToolResult {
  return typeof value === 'object' && value !== null && 'content' in value;
}

function isToolExtra(value: unknown): value is ToolExtra {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { requestId?: unknown; signal?: unknown };
  if (candidate.requestId === undefined || candidate.signal === undefined) return false;
  const signal = candidate.signal as { aborted?: unknown } | undefined;
  return typeof signal?.aborted === 'boolean';
}

export function registerTool<Args, Result extends CallToolResult = CallToolResult>(
  server: McpServer,
  name: string,
  definition: ToolDefinition,
  handler: ToolHandler<Args, Result>,
  options?: ToolRegistryOptions,
): void {
  const registry = options?.registry ?? defaultRegistry;
  const nameMode = options?.nameMode ?? 'dot';
  const logicalName = name;
  const exposedName = normalizeToolName(name, nameMode);
  const existing = registry.get(exposedName);
  if (existing && existing !== logicalName) {
    throw new Error(`Tool name collision: ${logicalName} and ${existing} both map to ${exposedName}.`);
  }
  registry.set(exposedName, logicalName);
  assertObjectSchema(logicalName, 'inputSchema', definition.inputSchema);
  assertObjectSchema(logicalName, 'outputSchema', definition.outputSchema);

  const { requiredScopes, ...toolDefinition } = definition;
  const scopeGuard = options?.scopeGuard ?? requireScopes;

  server.registerTool(exposedName, toolDefinition, async (args: Args, extra: ToolExtra) => {
    let toolArgs = args;
    let toolExtra = extra;
    if (!definition.inputSchema && !extra && isToolExtra(args)) {
      toolExtra = args;
      toolArgs = undefined as Args;
    }
    const start = Date.now();
    let status: 'success' | 'error' = 'success';
    let context = toolContextFromExtra(toolExtra);
    try {
      if (requiredScopes && requiredScopes.length > 0) {
        const guardResult = scopeGuard(toolExtra, requiredScopes, { tool: logicalName });
        if (isCallToolResult(guardResult)) {
          status = 'error';
          return guardResult as Result;
        }
        context = guardResult;
      }
      const result = await handler(toolArgs, toolExtra);
      status =
        typeof result === 'object' && result !== null && 'isError' in result && result.isError
          ? 'error'
          : 'success';
      return result;
    } catch (err) {
      status = 'error';
      throw err;
    } finally {
      const duration = Date.now() - start;
      options?.onCall?.({
        tool: logicalName,
        status,
        durationMs: duration,
        context,
      });
    }
  });
}
