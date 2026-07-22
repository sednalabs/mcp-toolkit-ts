import { describe, expect, it } from 'vitest';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import {
  mergeTraceContext,
  traceContextFromAuthInfo,
  traceContextFromHeaders,
  traceContextToDbSettings,
  traceContextToEnv,
  traceContextToLogFields,
} from '../trace_context.js';

describe('trace_context', () => {
  it('extracts request and actor ids from headers', () => {
    const ctx = traceContextFromHeaders({
      'x-request-id': 'req-1',
      'x-ops-actor-id': 'agent-1',
    });

    expect(ctx).toEqual({ requestId: 'req-1', actorId: 'agent-1' });
  });

  it('extracts request and actor ids from auth info', () => {
    const authInfo: AuthInfo = {
      token: 't',
      clientId: 'c',
      scopes: [],
      extra: {
        request_id: 'req-2',
        subject: 'user-9',
      },
    };

    expect(traceContextFromAuthInfo(authInfo)).toEqual({
      requestId: 'req-2',
      actorId: 'user-9',
    });
  });

  it('merges trace context with primary precedence', () => {
    expect(
      mergeTraceContext({ requestId: 'req-3' }, { requestId: 'req-4', actorId: 'agent-2' }),
    ).toEqual({
      requestId: 'req-3',
      actorId: 'agent-2',
    });
  });

  it('renders env, db, and log fields', () => {
    const ctx = { requestId: 'req-5', actorId: 'agent-3' };

    expect(traceContextToEnv(ctx, 'ops')).toEqual({
      OPS_REQUEST_ID: 'req-5',
      OPS_ACTOR_ID: 'agent-3',
    });

    expect(traceContextToDbSettings(ctx, 'ops')).toEqual({
      'ops.request_id': 'req-5',
      'ops.actor_id': 'agent-3',
    });

    expect(traceContextToLogFields(ctx)).toEqual({
      request_id: 'req-5',
      actor_id: 'agent-3',
    });
  });
});
