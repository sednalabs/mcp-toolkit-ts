import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createTransport, type TransportOptions } from '../../transport.js';
import {
  attachTraceToTransport,
  captureStdioStderr,
  createTraceCollector,
  type StdioCapture,
  type StdioSnapshot,
  type TraceCollector,
  type TraceEntry,
} from './telemetry.js';
import { withRetry, withTimeout } from './probe_timing.js';
import type { ProbeOptions } from './probe_options.js';

const DEFAULT_STDIO_STDERR_LINES = 200;
const DEFAULT_TRACE_LIMIT = 200;
const DEFAULT_TRACE_MAX_BYTES = 4096;

export type ProbeConnectTarget = TransportOptions & {
  trace?: boolean;
  traceLimit?: number;
  traceMaxBytes?: number;
};

export type ProbeConnection = {
  client: Client;
  transport: Transport;
  stdio?: StdioCapture;
  trace?: TraceCollector;
};

export async function connectWithRetry(
  target: ProbeConnectTarget,
  probeOptions: ProbeOptions,
  clientInfo?: { name: string; version: string },
): Promise<ProbeConnection> {
  const attempt = async () => {
    const client = new Client(
      clientInfo ?? { name: 'sednalabs-mcp-toolkit-ts', version: '0.1.0' },
    );
    const transport = createTransport(target);
    const stdio =
      target.transportType === 'stdio'
        ? captureStdioStderr(transport, DEFAULT_STDIO_STDERR_LINES)
        : undefined;
    const trace = target.trace
      ? createTraceCollector(
          target.traceLimit ?? DEFAULT_TRACE_LIMIT,
          target.traceMaxBytes ?? DEFAULT_TRACE_MAX_BYTES,
        )
      : undefined;
    if (trace) {
      attachTraceToTransport(transport, trace);
    }
    try {
      await withTimeout(client.connect(transport), probeOptions.timeoutMs, 'connect');
      return {
        client,
        transport,
        ...(stdio ? { stdio } : {}),
        ...(trace ? { trace } : {}),
      };
    } catch (error) {
      if (stdio) {
        (error as { stdio?: StdioSnapshot }).stdio = stdio.snapshot();
        stdio.stop();
      }
      if (trace) {
        (error as { trace?: TraceEntry[] }).trace = trace.entries();
      }
      await transport.close().catch(() => undefined);
      throw error;
    }
  };

  return await withRetry(attempt, probeOptions.retries, probeOptions.retryDelayMs);
}
