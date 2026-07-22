import { describe, expect, it } from 'vitest';
import { requireScopes } from '../tools/guards.js';

describe('requireScopes', () => {
  it('returns a structured error when scopes are missing', () => {
    const extra = {
      authInfo: {
        scopes: ['mcp:read'],
        clientId: 'client-1',
        extra: {
          request_id: 'req-1',
        },
      },
    } as const;

    const result = requireScopes(extra as unknown as Parameters<typeof requireScopes>[0], [
      'mcp:write',
    ]);

    expect(result).toEqual({
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            status: 'error',
            code: 'auth.missing_scopes',
            message: 'Token missing required scopes: mcp:write',
            missing_scopes: ['mcp:write'],
            hint: 'To fix this, obtain a token with the scope: mcp:write.',
            hints: [
              {
                type: 'scope_request',
                scope: 'mcp:write',
                action: 'request_scope',
              },
            ],
            request_id: 'req-1',
          }),
        },
      ],
    });
  });

  it('returns tool context when required scopes are satisfied', () => {
    const extra = {
      authInfo: {
        scopes: ['mcp:read', 'mcp:write'],
        clientId: 'client-2',
        extra: {
          request_id: 'req-2',
          subject: 'user-123',
          roles: ['devtools'],
        },
      },
    } as const;

    const result = requireScopes(extra as unknown as Parameters<typeof requireScopes>[0], [
      'mcp:write',
    ]);

    expect(result).toEqual({
      scopes: ['mcp:read', 'mcp:write'],
      requestId: 'req-2',
      actorId: 'user-123',
      subject: 'user-123',
      clientId: 'client-2',
      roles: ['devtools'],
    });
  });
});
