export type MetricLabels = Record<string, string>;

type CounterEntry = {
  labels: MetricLabels;
  value: number;
};

type HistogramEntry = {
  labels: MetricLabels;
  buckets: number[];
  counts: number[];
  sum: number;
  count: number;
};

function normalizeLabels(labels: MetricLabels = {}): MetricLabels {
  const ordered: MetricLabels = {};
  for (const key of Object.keys(labels).sort()) {
    ordered[key] = labels[key] ?? '';
  }
  return ordered;
}

function labelsKey(labels: MetricLabels = {}): string {
  return JSON.stringify(normalizeLabels(labels));
}

function formatLabels(labels: MetricLabels = {}): string {
  const entries = Object.entries(labels);
  if (entries.length === 0) return '';
  const rendered = entries
    .map(([key, value]) => {
      const val = String(value).replace(/"/g, '\"');
      return `${key}="${val}"`;
    })
    .join(',');
  return `{${rendered}}`;
}

export class Counter {
  private entries = new Map<string, CounterEntry>();

  inc(labels: MetricLabels = {}, value = 1): void {
    const key = labelsKey(labels);
    const existing = this.entries.get(key);
    if (existing) {
      existing.value += value;
      return;
    }
    this.entries.set(key, { labels: normalizeLabels(labels), value });
  }

  snapshot(): CounterEntry[] {
    return Array.from(this.entries.values()).map((entry) => ({ ...entry }));
  }
}

export class Histogram {
  private entries = new Map<string, HistogramEntry>();

  constructor(private readonly buckets: number[]) {}

  observe(labels: MetricLabels = {}, value: number): void {
    const key = labelsKey(labels);
    const entry =
      this.entries.get(key) ??
      ({
        labels: normalizeLabels(labels),
        buckets: [...this.buckets],
        counts: new Array<number>(this.buckets.length).fill(0),
        sum: 0,
        count: 0,
      } satisfies HistogramEntry);

    for (let i = 0; i < entry.buckets.length; i += 1) {
      const bucket = entry.buckets[i];
      if (bucket === undefined) continue;
      if (value <= bucket) {
        entry.counts[i] = (entry.counts[i] ?? 0) + 1;
      }
    }
    entry.sum += value;
    entry.count += 1;
    this.entries.set(key, entry);
  }

  snapshot(): HistogramEntry[] {
    return Array.from(this.entries.values()).map((entry) => ({
      labels: { ...entry.labels },
      buckets: [...entry.buckets],
      counts: [...entry.counts],
      sum: entry.sum,
      count: entry.count,
    }));
  }
}

export type MetricsSnapshot = {
  uptime_s: number;
  auth_rejects_total: CounterEntry[];
  request_timeouts_total: CounterEntry[];
  tool_calls_total: CounterEntry[];
  tool_call_duration_ms: HistogramEntry[];
};

export class Metrics {
  private readonly startedAt = Date.now();
  private readonly authRejects = new Counter();
  private readonly requestTimeouts = new Counter();
  private readonly toolCalls = new Counter();
  private readonly toolLatency = new Histogram([
    5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
  ]);

  uptimeSeconds(): number {
    return Math.floor((Date.now() - this.startedAt) / 1000);
  }

  recordAuthReject(code: string, reason: string): void {
    this.authRejects.inc({ code, reason });
  }

  recordRequestTimeout(labels: MetricLabels = {}): void {
    this.requestTimeouts.inc(labels);
  }

  recordToolCall(tool: string, status: 'success' | 'error', durationMs: number): void {
    this.toolCalls.inc({ tool, status });
    this.toolLatency.observe({ tool, status }, durationMs);
  }

  snapshot(): MetricsSnapshot {
    return {
      uptime_s: this.uptimeSeconds(),
      auth_rejects_total: this.authRejects.snapshot(),
      request_timeouts_total: this.requestTimeouts.snapshot(),
      tool_calls_total: this.toolCalls.snapshot(),
      tool_call_duration_ms: this.toolLatency.snapshot(),
    };
  }

  renderPrometheus(): string {
    const lines: string[] = [];
    lines.push('# HELP mcp_uptime_seconds MCP server uptime in seconds');
    lines.push('# TYPE mcp_uptime_seconds gauge');
    lines.push(`mcp_uptime_seconds ${this.uptimeSeconds()}`);

    lines.push('# HELP mcp_auth_rejects_total Total auth rejects');
    lines.push('# TYPE mcp_auth_rejects_total counter');
    for (const entry of this.authRejects.snapshot()) {
      lines.push(`mcp_auth_rejects_total${formatLabels(entry.labels)} ${entry.value}`);
    }

    lines.push('# HELP mcp_request_timeouts_total Total MCP request timeouts');
    lines.push('# TYPE mcp_request_timeouts_total counter');
    for (const entry of this.requestTimeouts.snapshot()) {
      lines.push(`mcp_request_timeouts_total${formatLabels(entry.labels)} ${entry.value}`);
    }

    lines.push('# HELP mcp_tool_calls_total Tool call count');
    lines.push('# TYPE mcp_tool_calls_total counter');
    for (const entry of this.toolCalls.snapshot()) {
      lines.push(`mcp_tool_calls_total${formatLabels(entry.labels)} ${entry.value}`);
    }

    lines.push('# HELP mcp_tool_call_duration_ms Tool call latency in ms');
    lines.push('# TYPE mcp_tool_call_duration_ms histogram');
    for (const entry of this.toolLatency.snapshot()) {
      let cumulative = 0;
      for (let i = 0; i < entry.buckets.length; i += 1) {
        const bucket = entry.buckets[i];
        if (bucket === undefined) continue;
        const count = entry.counts[i] ?? 0;
        cumulative += count;
        lines.push(
          `mcp_tool_call_duration_ms_bucket${formatLabels({
            ...entry.labels,
            le: String(bucket),
          })} ${cumulative}`,
        );
      }
      lines.push(
        `mcp_tool_call_duration_ms_bucket${formatLabels({
          ...entry.labels,
          le: '+Inf',
        })} ${entry.count}`,
      );
      lines.push(`mcp_tool_call_duration_ms_sum${formatLabels(entry.labels)} ${entry.sum}`);
      lines.push(`mcp_tool_call_duration_ms_count${formatLabels(entry.labels)} ${entry.count}`);
    }

    return `${lines.join('\n')}\n`;
  }
}

export function createMetrics(): Metrics {
  return new Metrics();
}