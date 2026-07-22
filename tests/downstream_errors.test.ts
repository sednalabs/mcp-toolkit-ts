import { describe, expect, it } from 'vitest';
import { downstreamForbiddenPayload, downstreamForbiddenToolError } from '../src/tools/errors.js';

describe('downstream forbidden helpers', () => {
  it('builds the default payload', () => {
    expect(downstreamForbiddenPayload()).toEqual({
      status: 'error',
      code: 'downstream.forbidden',
      message: 'Authorization denied by downstream service.',
      origin: 'downstream',
      downstream_status: 403,
      hint: 'Verify the MCP server has permission for this operation.',
    });
  });

  it('adds optional fields when provided', () => {
    const payload = downstreamForbiddenPayload({
      tool: 'events.list',
      requestId: 'req-1',
      downstreamStatus: 403,
      hint: 'Check roles.',
    });
    expect(payload).toEqual({
      status: 'error',
      code: 'downstream.forbidden',
      message: 'Authorization denied by downstream service.',
      origin: 'downstream',
      downstream_status: 403,
      hint: 'Check roles.',
      tool: 'events.list',
      request_id: 'req-1',
    });
  });

  it('wraps payload into a tool error', () => {
    const result = downstreamForbiddenToolError({ requestId: 'req-2' });
    expect(result.isError).toBe(true);
    const payload = JSON.parse(result.content?.[0]?.text ?? '{}');
    expect(payload.request_id).toBe('req-2');
    expect(payload.code).toBe('downstream.forbidden');
  });
});
