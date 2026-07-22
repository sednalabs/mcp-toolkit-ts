import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { nowIso, type TraceEntry } from '../../report.js';
import { serializeUnknown } from './errors.js';

export type { TraceEntry } from '../../report.js';

export type StdioSnapshot = {
  lines: string[];
  exit_code?: number | null;
  signal?: string | null;
};

export type StdioCapture = {
  snapshot: () => StdioSnapshot;
  stop: () => void;
};

export type TraceCollector = {
  add: (direction: TraceEntry['direction'], message: unknown) => void;
  entries: () => TraceEntry[];
};

export function summarizeTraceMessage(message: unknown): Pick<TraceEntry, 'method' | 'id'> {
  if (!message || typeof message !== 'object') {
    return {};
  }
  const record = message as Record<string, unknown>;
  const method = typeof record.method === 'string' ? record.method : undefined;
  const id = record.id;
  const resolvedId = typeof id === 'string' || typeof id === 'number' ? id : undefined;
  return {
    ...(method ? { method } : {}),
    ...(resolvedId !== undefined ? { id: resolvedId } : {}),
  };
}

export function sanitizeTraceMessage(message: unknown, maxBytes: number): unknown {
  const sanitized = serializeUnknown(message);
  try {
    const json = JSON.stringify(sanitized);
    if (json.length <= maxBytes) {
      return sanitized;
    }
    return {
      truncated: true,
      bytes: json.length,
      preview: json.slice(0, maxBytes),
    };
  } catch (error) {
    return {
      truncated: true,
      preview: `Unserializable trace payload: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function createTraceCollector(
  limit: number,
  maxBytes: number,
): TraceCollector {
  const entries: TraceEntry[] = [];
  return {
    add: (direction, message) => {
      const summary = summarizeTraceMessage(message);
      const entry: TraceEntry = {
        direction,
        timestamp: nowIso(),
        message: sanitizeTraceMessage(message, maxBytes),
        ...summary,
      };
      entries.push(entry);
      if (entries.length > limit) {
        entries.shift();
      }
    },
    entries: () => [...entries],
  };
}

export function attachTraceToTransport(transport: Transport, trace: TraceCollector): void {
  const originalSend = transport.send?.bind(transport);
  if (originalSend) {
    transport.send = async (message: unknown) => {
      trace.add('client->server', message);
      return await originalSend(message as never);
    };
  }

  let currentHandler = transport.onmessage as
    | ((message: unknown, ...rest: unknown[]) => void)
    | undefined;
  Object.defineProperty(transport, 'onmessage', {
    configurable: true,
    get() {
      return currentHandler;
    },
    set(handler: ((message: unknown, ...rest: unknown[]) => void) | undefined) {
      if (handler) {
        currentHandler = (message: unknown, ...rest: unknown[]) => {
          trace.add('server->client', message);
          handler(message, ...rest);
        };
      } else {
        currentHandler = undefined;
      }
    },
  });

  if (currentHandler) {
    transport.onmessage = currentHandler;
  }
}

export function captureStdioStderr(transport: Transport, maxLines: number): StdioCapture | undefined {
  const stderr =
    (transport as unknown as { stderr?: NodeJS.ReadableStream }).stderr ??
    (transport as unknown as { process?: { stderr?: NodeJS.ReadableStream } }).process?.stderr;
  if (!stderr || typeof stderr.on !== 'function') {
    return undefined;
  }
  const lines: string[] = [];
  let buffer = '';
  let exitCode: number | null | undefined;
  let signal: string | null | undefined;

  const pushLine = (line: string) => {
    lines.push(line);
    if (lines.length > maxLines) {
      lines.shift();
    }
  };

  const onData = (chunk: Buffer | string) => {
    buffer += chunk.toString();
    const parts = buffer.split(/\r?\n/);
    buffer = parts.pop() ?? '';
    for (const part of parts) {
      pushLine(part);
    }
  };

  const onExit = (code: number | null, sig: NodeJS.Signals | null) => {
    exitCode = code;
    signal = sig;
  };

  stderr.on('data', onData);
  const proc = (transport as unknown as { process?: NodeJS.EventEmitter & { on?: Function } })
    .process;
  if (proc && typeof proc.on === 'function') {
    proc.on('exit', onExit);
    proc.on('close', onExit);
  }

  return {
    snapshot: () => {
      const output = buffer.length > 0 ? [...lines, buffer] : [...lines];
      return {
        lines: output,
        ...(exitCode !== undefined ? { exit_code: exitCode } : {}),
        ...(signal !== undefined ? { signal } : {}),
      };
    },
    stop: () => {
      if (typeof stderr.off === 'function') {
        stderr.off('data', onData);
      } else if (typeof (stderr as NodeJS.EventEmitter).removeListener === 'function') {
        (stderr as NodeJS.EventEmitter).removeListener('data', onData);
      }
      if (proc && typeof proc.off === 'function') {
        proc.off('exit', onExit);
        proc.off('close', onExit);
      } else if (proc && typeof (proc as NodeJS.EventEmitter).removeListener === 'function') {
        (proc as NodeJS.EventEmitter).removeListener('exit', onExit);
        (proc as NodeJS.EventEmitter).removeListener('close', onExit);
      }
    },
  };
}
