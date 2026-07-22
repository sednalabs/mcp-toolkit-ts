import { describe, expect, it, vi } from 'vitest';
import { Metrics } from '../telemetry/metrics.js';

describe('Metrics', () => {
  it('renders label values as one valid Prometheus sample', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const metrics = new Metrics();
    metrics.recordRequestTimeout({ reason: 'quote" slash\\ newline\nnext' });

    expect(metrics.renderPrometheus()).toBe(
      [
        '# HELP mcp_uptime_seconds MCP server uptime in seconds',
        '# TYPE mcp_uptime_seconds gauge',
        'mcp_uptime_seconds 0',
        '# HELP mcp_auth_rejects_total Total auth rejects',
        '# TYPE mcp_auth_rejects_total counter',
        '# HELP mcp_request_timeouts_total Total MCP request timeouts',
        '# TYPE mcp_request_timeouts_total counter',
        'mcp_request_timeouts_total{reason="quote\\" slash\\\\ newline\\nnext"} 1',
        '# HELP mcp_tool_calls_total Tool call count',
        '# TYPE mcp_tool_calls_total counter',
        '# HELP mcp_tool_call_duration_ms Tool call latency in ms',
        '# TYPE mcp_tool_call_duration_ms histogram',
        '',
      ].join('\n'),
    );

    now.mockRestore();
  });

  it('rejects label names that cannot be represented safely', () => {
    const metrics = new Metrics();

    expect(() => metrics.recordRequestTimeout({ 'invalid-label': 'value' })).toThrowError(
      'Prometheus label names must start with a letter or underscore and contain only letters, digits, and underscores',
    );
  });
});
