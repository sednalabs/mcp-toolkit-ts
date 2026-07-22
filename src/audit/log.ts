import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export type AuditActor = {
  subject?: string;
  client_id?: string;
  scopes?: string[];
  roles?: string[];
};

export type AuditOutcome = {
  status: 'success' | 'error';
  duration_ms: number;
};

export type AuditEvent = {
  schema_version: 'v1';
  event_type: 'tool.call';
  ts: string;
  request_id?: string;
  prev_hash?: string | null;
  hash?: string;
  actor?: AuditActor;
  tool: {
    name: string;
  };
  outcome: AuditOutcome;
};

export type AuditCheckpoint = {
  schema_version: 'v1';
  ts: string;
  last_hash?: string | null;
  log_path?: string;
  state_path?: string;
  checkpoint_path?: string;
};

export type AuditLogOptions = {
  maxEntries: number;
  filePath?: string;
  maxBytes: number;
  maxFiles: number;
  onError?: (err: unknown) => void;
};

type FileState = {
  path: string;
  maxBytes: number;
  maxFiles: number;
  size: number;
};

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    return value.map((entry) => (entry === undefined ? null : sortValue(entry)));
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const next = sortValue(obj[key]);
      if (next !== undefined) {
        out[key] = next;
      }
    }
    return out;
  }
  return value;
}

function sha256(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}

export class AuditLog {
  private readonly entries: AuditEvent[] = [];
  private readonly options: AuditLogOptions;
  private readonly file?: FileState;
  private readonly ready: Promise<void>;
  private writeQueue: Promise<void> = Promise.resolve();
  private lastErrorMessage?: string;
  private statePath?: string;
  private lastHash?: string;
  private checkpointPath?: string;

  constructor(options: AuditLogOptions) {
    this.options = options;
    const filePath = options.filePath?.trim();
    if (filePath) {
      const maxFiles = Math.max(1, options.maxFiles);
      const maxBytes = Math.max(1, options.maxBytes);
      this.file = { path: filePath, maxBytes, maxFiles, size: 0 };
      this.statePath = `${filePath}.state`;
      this.checkpointPath = `${filePath}.checkpoint.json`;
    }
    this.ready = this.initialize();
  }

  record(event: AuditEvent): void {
    const entry: AuditEvent = { ...event };
    this.entries.push(entry);
    if (this.entries.length > this.options.maxEntries) {
      this.entries.splice(0, this.entries.length - this.options.maxEntries);
    }
    if (this.file) {
      this.enqueueWrite(entry);
    }
  }

  snapshot(limit?: number): AuditEvent[] {
    if (!limit || limit <= 0 || limit >= this.entries.length) {
      return [...this.entries];
    }
    return this.entries.slice(this.entries.length - limit);
  }

  async flush(): Promise<void> {
    await this.writeQueue;
  }

  async checkpoint(): Promise<AuditCheckpoint> {
    await this.flush();
    const checkpoint: AuditCheckpoint = {
      schema_version: 'v1',
      ts: new Date().toISOString(),
      last_hash: this.lastHash ?? null,
      ...(this.file?.path ? { log_path: this.file.path } : {}),
      ...(this.statePath ? { state_path: this.statePath } : {}),
      ...(this.checkpointPath ? { checkpoint_path: this.checkpointPath } : {}),
    };
    if (this.checkpointPath) {
      const payload = `${stableStringify(checkpoint)}
`;
      await fs.writeFile(this.checkpointPath, payload, { encoding: 'utf8', mode: 0o600 });
    }
    return checkpoint;
  }

  private enqueueWrite(event: AuditEvent): void {
    this.writeQueue = this.writeQueue
      .then(() => this.writeEntry(event))
      .catch((err) => this.reportError(err));
  }

  private async initialize(): Promise<void> {
    if (!this.file) return;
    const dir = path.dirname(this.file.path);
    await fs.mkdir(dir, { recursive: true });
    const handle = await fs.open(this.file.path, 'a', 0o600);
    await handle.close();
    try {
      const stat = await fs.stat(this.file.path);
      if ((stat.mode & 0o077) !== 0) {
        await fs.chmod(this.file.path, 0o600);
      }
      this.file.size = stat.size;
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        this.file.size = 0;
      } else {
        throw err;
      }
    }
    await this.loadState();
  }

  private async writeEntry(event: AuditEvent): Promise<void> {
    if (!this.file) return;
    await this.ready;
    const chained = this.chainEvent(event);
    Object.assign(event, chained);
    const payload = stableStringify(chained);
    const line = `${payload}\n`;
    const bytes = Buffer.byteLength(line, 'utf8');
    await this.rotateIfNeeded(bytes);
    await fs.appendFile(this.file.path, line, { encoding: 'utf8', mode: 0o600 });
    this.file.size += bytes;
    if (chained.hash) {
      this.lastHash = chained.hash;
      await this.writeState(chained.hash);
    }
  }

  private async rotateIfNeeded(appendBytes: number): Promise<void> {
    if (!this.file) return;
    if (this.file.size + appendBytes <= this.file.maxBytes) return;
    await this.rotateFiles();
    this.file.size = 0;
  }

  private async rotateFiles(): Promise<void> {
    if (!this.file) return;
    const { path: filePath, maxFiles } = this.file;
    if (maxFiles < 1) return;
    const last = `${filePath}.${maxFiles}`;
    await fs.rm(last, { force: true });
    for (let i = maxFiles - 1; i >= 1; i -= 1) {
      const src = `${filePath}.${i}`;
      const dest = `${filePath}.${i + 1}`;
      try {
        await fs.rename(src, dest);
      } catch (err) {
        if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
          continue;
        }
        throw err;
      }
    }
    try {
      await fs.rename(filePath, `${filePath}.1`);
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
        return;
      }
      throw err;
    }
  }

  private chainEvent(event: AuditEvent): AuditEvent {
    const prev = this.lastHash ?? null;
    const base: AuditEvent = { ...event, prev_hash: prev };
    const payload = stableStringify(base);
    const hash = sha256(payload);
    return { ...base, hash };
  }

  private async loadState(): Promise<void> {
    if (!this.statePath || !this.file) return;
    try {
      const data = await fs.readFile(this.statePath, 'utf8');
      const value = data.trim();
      if (value) {
        this.lastHash = value;
        return;
      }
    } catch (err) {
      if (!(err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT')) {
        throw err;
      }
    }
    await this.loadLastHashFromLog();
  }

  private async loadLastHashFromLog(): Promise<void> {
    if (!this.file) return;
    try {
      const stat = await fs.stat(this.file.path);
      if (stat.size === 0) return;
      const readSize = Math.min(stat.size, 64 * 1024);
      const handle = await fs.open(this.file.path, 'r');
      try {
        const buffer = Buffer.alloc(readSize);
        await handle.read(buffer, 0, readSize, stat.size - readSize);
        const text = buffer.toString('utf8');
        const lines = text.trim().split('\n');
        for (let i = lines.length - 1; i >= 0; i -= 1) {
          const line = lines[i];
          if (!line) continue;
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed) as { hash?: string };
            if (parsed && typeof parsed.hash === 'string' && parsed.hash.length > 0) {
              this.lastHash = parsed.hash;
              return;
            }
          } catch {
            continue;
          }
        }
      } finally {
        await handle.close();
      }
    } catch (err) {
      if (!(err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT')) {
        throw err;
      }
    }
  }

  private async writeState(hash: string): Promise<void> {
    if (!this.statePath) return;
    await fs.writeFile(this.statePath, `${hash}\n`, { encoding: 'utf8', mode: 0o600 });
  }

  private reportError(err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    if (message && message === this.lastErrorMessage) {
      return;
    }
    this.lastErrorMessage = message;
    this.options.onError?.(err);
  }
}
