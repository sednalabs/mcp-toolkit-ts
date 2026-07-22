import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { missingScopes } from '../http_access.js';
import { traceContextFromExtra } from '../trace_context.js';

export type ToolContext = {
  scopes: string[];
  requestId?: string;
  actorId?: string;
  subject?: string;
  clientId?: string;
  roles?: string[];
};

export type ToolExtra =
  | RequestHandlerExtra<ServerRequest, ServerNotification>
  | undefined;

export type ScopeGuardOptions = {
  errorCode?: string;
  errorMessage?: string;
  hint?: string;
  hintTools?: string[];
  hintResources?: string[];
};

export type ScopeGuardContext = {
  tool?: string;
};

type ScopeHint = {
  type: 'scope_request' | 'tool_retry' | 'resource_check' | 'tool_call';
  scope?: string;
  tool?: string;
  resource?: string;
  action?: string;
};

export function toolContextFromExtra(extra?: ToolExtra): ToolContext {
  const authInfo = extra?.authInfo ?? (extra as any)?.request?.auth;
  const traceContext = traceContextFromExtra(extra);
  const requestId = traceContext.requestId;
  const actorId = traceContext.actorId;
  const subject = authInfo?.extra?.subject as string | undefined;
  const roles = (authInfo?.extra?.roles as string[] | undefined) ?? [];
  const clientId = authInfo?.clientId;
  return {
    scopes: authInfo?.scopes ?? [],
    roles,
    ...(requestId !== undefined ? { requestId } : {}),
    ...(actorId !== undefined ? { actorId } : {}),
    ...(subject !== undefined ? { subject } : {}),
    ...(clientId !== undefined ? { clientId } : {}),
  };
}

function renderList(values: string[]): string {
  return values.map((value) => `"${value}"`).join(', ');
}

function buildScopeHints(
  missing: string[],
  context: ScopeGuardContext | undefined,
  options: ScopeGuardOptions | undefined,
): ScopeHint[] {
  const hints: ScopeHint[] = missing.map((scope) => ({
    type: 'scope_request',
    scope,
    action: 'request_scope',
  }));

  const hintTools = options?.hintTools ?? [];
  for (const tool of hintTools) {
    hints.push({ type: 'tool_call', tool, action: 'call' });
  }

  const hintResources = options?.hintResources ?? [];
  for (const resource of hintResources) {
    hints.push({ type: 'resource_check', resource, action: 'check' });
  }

  if (context?.tool) {
    hints.push({ type: 'tool_retry', tool: context.tool, action: 'retry' });
  }

  return hints;
}

function buildScopeHintText(
  missing: string[],
  context: ScopeGuardContext | undefined,
  options: ScopeGuardOptions | undefined,
): string {
  if (options?.hint) {
    return options.hint;
  }

  const parts: string[] = [];
  if (missing.length === 1) {
    parts.push(`To fix this, obtain a token with the scope: ${missing[0]}.`);
  } else {
    parts.push(`To fix this, obtain a token with scopes: ${missing.join(', ')}.`);
  }

  if (options?.hintTools && options.hintTools.length > 0) {
    parts.push(`Use tool${options.hintTools.length === 1 ? '' : 's'} ${renderList(options.hintTools)}.`);
  }

  if (options?.hintResources && options.hintResources.length > 0) {
    parts.push(
      `Check resource${options.hintResources.length === 1 ? '' : 's'} ${renderList(options.hintResources)}.`,
    );
  }

  if (context?.tool) {
    parts.push(`Then retry tool "${context.tool}".`);
  }

  return parts.join(' ');
}

export function requireScopes(
  extra: ToolExtra,
  requiredScopes: string[],
  options?: ScopeGuardOptions,
  context?: ScopeGuardContext,
): CallToolResult | ToolContext {
  const ctx = toolContextFromExtra(extra);
  if (requiredScopes.length === 0) {
    return ctx;
  }
  const missing = missingScopes(requiredScopes, ctx.scopes);
  if (missing.length > 0) {
    const errorCode = options?.errorCode ?? 'auth.missing_scopes';
    const errorMessage =
      options?.errorMessage ?? `Token missing required scopes: ${missing.join(', ')}`;
    const hint = buildScopeHintText(missing, context, options);
    const hints = buildScopeHints(missing, context, options);
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            status: 'error',
            code: errorCode,
            message: errorMessage,
            missing_scopes: missing,
            hint,
            hints,
            request_id: ctx.requestId,
          }),
        },
      ],
    };
  }
  return ctx;
}
