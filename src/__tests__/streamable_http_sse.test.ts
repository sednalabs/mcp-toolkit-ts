import { describe, expect, it, vi } from 'vitest';

import { checkStreamableHttpSseCompatibility } from '../client/probe/streamable_http_sse.js';

type MockResponse = {
  status: number;
  body?: string;
  headers?: Record<string, string>;
};

const fetchWithTimeout = vi.hoisted(() => vi.fn());

vi.mock('../client/probe/probe_http.js', () => ({
  fetchWithTimeout,
}));

function mockResponse({
  status,
  body = '',
  headers = {},
}: MockResponse): Response {
  const normalizedHeaders = new Map<string, string>();
  for (const [key, value] of Object.entries(headers)) {
    normalizedHeaders.set(key.toLowerCase(), value);
  }

  return {
    status,
    text: async () => body,
    headers: {
      get: (name: string) => normalizedHeaders.get(name.toLowerCase()) ?? null,
    },
  } as Response;
}

describe('checkStreamableHttpSseCompatibility', () => {
  it('treats target compatible when canonical URL returns 400 missing session ID', async () => {
    const baseUrl = 'http://127.0.0.1:9011';
    const responses = new Map<string, MockResponse>([
      [`${baseUrl}/mcp`, { status: 400, body: '{\"error\":\"Missing session ID\"}' }],
      [`${baseUrl}/mcp/`, { status: 404, body: 'not found' }],
    ]);

    fetchWithTimeout.mockImplementation((url: string) =>
      Promise.resolve(mockResponse(responses.get(url) ?? { status: 500 })),
    );

    const result = await checkStreamableHttpSseCompatibility(`${baseUrl}/mcp`, 500);
    expect(result.ok).toBe(true);
    expect(result.steps).toEqual([
      {
        name: 'streamable-http.sse.target',
        status: 'ok',
        detail: expect.stringContaining('Missing session ID'),
        data: {
          url: `${baseUrl}/mcp`,
          http_status: 400,
        },
      },
      {
        name: 'streamable-http.sse.alternate',
        status: 'ok',
        detail: expect.stringContaining('SSE probe returned 404'),
        data: {
          url: `${baseUrl}/mcp/`,
          http_status: 404,
        },
      },
    ]);
    expect(fetchWithTimeout).toHaveBeenCalledTimes(2);
  });

  it('succeeds with suggestion when canonical path returns 404 but trailing variant is compatible', async () => {
    const baseUrl = 'http://127.0.0.1:9012';
    const responses = new Map<string, MockResponse>([
      [`${baseUrl}/mcp`, { status: 404, body: 'not found' }],
      [`${baseUrl}/mcp/`, { status: 400, body: '{\"error\":\"Missing session ID\"}' }],
    ]);

    fetchWithTimeout.mockImplementation((url: string) =>
      Promise.resolve(mockResponse(responses.get(url) ?? { status: 500 })),
    );

    const result = await checkStreamableHttpSseCompatibility(`${baseUrl}/mcp`, 500);
    expect(result.ok).toBe(false);
    expect(result.steps.map((step) => step.name)).toEqual([
      'streamable-http.sse.target',
      'streamable-http.sse.alternate',
      'streamable-http.sse.suggestion',
    ]);
    const targetStep = result.steps.find((step) => step.name === 'streamable-http.sse.target');
    expect(targetStep?.status).toBe('error');
    expect(targetStep?.detail).toContain('Try http://127.0.0.1:9012/mcp/');
  });

  it('treats auth challenge as compatible and captures resource_metadata', async () => {
    const baseUrl = 'http://127.0.0.1:9013';
    const metadataUrl = `${baseUrl}/.well-known/oauth-protected-resource`;
    const response: MockResponse = {
      status: 401,
      headers: { 'www-authenticate': `Bearer resource_metadata="${metadataUrl}"` },
    };

    fetchWithTimeout.mockResolvedValue(mockResponse(response));

    const result = await checkStreamableHttpSseCompatibility(`${baseUrl}/mcp/`, 500);
    expect(result.ok).toBe(true);
    expect(result.steps).toContainEqual(
      expect.objectContaining({
        name: 'streamable-http.sse.target',
        status: 'ok',
        detail: expect.stringContaining('requires auth'),
        data: {
          url: `${baseUrl}/mcp/`,
          http_status: 401,
          resource_metadata_url: metadataUrl,
        },
      }),
    );
  });

  it('treats 405 as compatible (GET not supported for SSE setup)', async () => {
    const baseUrl = 'http://127.0.0.1:9014';
    fetchWithTimeout.mockResolvedValue(mockResponse({ status: 405 }));

    const result = await checkStreamableHttpSseCompatibility(`${baseUrl}/mcp`, 500);
    expect(result.ok).toBe(true);
    expect(result.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'streamable-http.sse.target',
          status: 'ok',
          detail: expect.stringContaining('405'),
        }),
      ]),
    );
  });
});
