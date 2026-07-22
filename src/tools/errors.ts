import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

type BasePayload = {
  status: 'error';
  code: string;
  message: string;
  origin: 'downstream';
  tool?: string;
  downstream_status?: number;
  hint?: string;
  request_id?: string;
};

export type DownstreamForbiddenOptions = {
  tool?: string;
  requestId?: string;
  downstreamStatus?: number;
  hint?: string;
  code?: string;
  message?: string;
};

export function downstreamForbiddenPayload(
  options: DownstreamForbiddenOptions = {},
): BasePayload {
  const payload: BasePayload = {
    status: 'error',
    code: options.code ?? 'downstream.forbidden',
    message: options.message ?? 'Authorization denied by downstream service.',
    origin: 'downstream',
  };
  if (options.tool) {
    payload.tool = options.tool;
  }
  if (options.downstreamStatus !== undefined) {
    payload.downstream_status = options.downstreamStatus;
  } else {
    payload.downstream_status = 403;
  }
  if (options.hint) {
    payload.hint = options.hint;
  } else {
    payload.hint = 'Verify the MCP server has permission for this operation.';
  }
  if (options.requestId) {
    payload.request_id = options.requestId;
  }
  return payload;
}

export function downstreamForbiddenToolError(
  options: DownstreamForbiddenOptions = {},
): CallToolResult {
  const payload = downstreamForbiddenPayload(options);
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload),
      },
    ],
  };
}
