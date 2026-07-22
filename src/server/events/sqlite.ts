import { promisify } from 'node:util';
import type { EventStore, EventId, StreamId } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';

type SqliteRunCallback = (err: Error | null) => void;
type SqliteRowCallback<T> = (err: Error | null, row: T) => void;
type SqliteAllCallback<T> = (err: Error | null, rows: T[]) => void;

type SqliteDatabase = {
  run: (
    sql: string,
    paramsOrCb?: unknown[] | Record<string, unknown> | SqliteRunCallback,
    cb?: SqliteRunCallback,
  ) => void;
  get: <T>(
    sql: string,
    paramsOrCb?: unknown[] | Record<string, unknown> | SqliteRowCallback<T>,
    cb?: SqliteRowCallback<T>,
  ) => void;
  all: <T>(
    sql: string,
    paramsOrCb?: unknown[] | Record<string, unknown> | SqliteAllCallback<T>,
    cb?: SqliteAllCallback<T>,
  ) => void;
  close: (cb: (err?: Error | null) => void) => void;
  serialize: (fn: () => void) => void;
};

type Sqlite3Module = {
  Database: new (path: string) => SqliteDatabase;
};

let sqlite3Module: Sqlite3Module | null | undefined;

function loadSqlite3(): Sqlite3Module {
  if (sqlite3Module === undefined) {
    try {
      const require = createRequire(import.meta.url);
      sqlite3Module = require('sqlite3') as Sqlite3Module;
    } catch {
      sqlite3Module = null;
    }
  }

  if (!sqlite3Module) {
    throw new Error(
      'sqlite3 is required for SqliteEventStore. Install it with `npm install sqlite3`.',
    );
  }

  return sqlite3Module;
}

export type SqliteEventStoreConfig = {
  path: string;
  maxStreams?: number;
  maxEventsPerStream?: number;
  ttlSeconds?: number;
};

export class SqliteEventStore implements EventStore {
  private readonly db: SqliteDatabase;
  private readonly config: Required<SqliteEventStoreConfig>;
  private readonly ready: Promise<void>;

  constructor(config: SqliteEventStoreConfig) {
    this.config = {
      path: config.path,
      maxStreams: Math.max(1, config.maxStreams ?? 1000),
      maxEventsPerStream: Math.max(1, config.maxEventsPerStream ?? 1000),
      ttlSeconds: Math.max(1, config.ttlSeconds ?? 300),
    };

    const sqlite3 = loadSqlite3();
    this.db = new sqlite3.Database(this.config.path);
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    if (this.config.path !== ':memory:') {
      await mkdir(path.dirname(this.config.path), { recursive: true });
    }

    const run = promisify(this.db.run.bind(this.db));

    await run('PRAGMA journal_mode=WAL;');
    await run('PRAGMA synchronous=NORMAL;');
    await run(`
      CREATE TABLE IF NOT EXISTS mcp_event_streams (
        stream_id TEXT PRIMARY KEY,
        last_seen INTEGER NOT NULL
      )
    `);
    await run(`
      CREATE TABLE IF NOT EXISTS mcp_events (
        stream_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        payload TEXT,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (stream_id, seq)
      )
    `);
    await run('CREATE INDEX IF NOT EXISTS mcp_events_created_at ON mcp_events(created_at)');
  }

  async storeEvent(streamId: StreamId, message: JSONRPCMessage | null): Promise<EventId> {
    await this.ready;
    const now = Math.floor(Date.now() / 1000);
    const payload = message ? JSON.stringify(message) : null;

    return new Promise((resolve, reject) => {
      this.db.serialize(() => {
        this.db.run(
          'INSERT INTO mcp_event_streams(stream_id, last_seen) VALUES (?, ?) ON CONFLICT(stream_id) DO UPDATE SET last_seen=excluded.last_seen',
          [streamId, now],
          (err) => { if (err) reject(err); }
        );

        this.db.get(
          'SELECT COALESCE(MAX(seq), 0) + 1 as next_seq FROM mcp_events WHERE stream_id = ?',
          [streamId],
          (err, row: { next_seq: number }) => {
            if (err) {
              reject(err);
              return;
            }
            const seq = row.next_seq;
            const eventId = `${streamId}:${seq}`;

            this.db.run(
              'INSERT INTO mcp_events(stream_id, seq, event_id, payload, created_at) VALUES (?, ?, ?, ?, ?)',
              [streamId, seq, eventId, payload, now],
              (err) => {
                if (err) {
                  reject(err);
                  return;
                }

                // Cleanup in same transaction/serialize block
                this.pruneStreamEvents(streamId, seq);
                this.pruneExpired(now);
                this.pruneStreams();

                resolve(eventId);
              }
            );
          }
        );
      });
    });
  }

  async replayEventsAfter(
    lastEventId: EventId,
    { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> }
  ): Promise<StreamId> {
    await this.ready;
    const parts = lastEventId.split(':');
    if (parts.length < 2) throw new Error('Invalid event ID format');
    const lastSeqStr = parts.pop();
    const streamId = parts.join(':');
    const lastSeq = parseInt(lastSeqStr ?? '0', 10);
    if (isNaN(lastSeq)) throw new Error('Invalid sequence number in event ID');

    const now = Math.floor(Date.now() / 1000);
    await this.pruneExpired(now);

    const rows = await new Promise<Array<{ event_id: string; payload: string | null }>>((resolve, reject) => {
      this.db.all(
        'SELECT event_id, payload FROM mcp_events WHERE stream_id = ? AND seq > ? ORDER BY seq ASC',
        [streamId, lastSeq],
        (err, rows: Array<{ event_id: string; payload: string | null }>) => {
          if (err) reject(err);
          else resolve(rows);
        }
      );
    });

    for (const row of rows) {
      if (!row.payload) continue;
      const message = JSON.parse(row.payload) as JSONRPCMessage;
      await send(row.event_id, message);
    }

    return streamId;
  }

  async close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.db.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  private pruneStreamEvents(streamId: string, newestSeq: number): void {
    const cutoff = newestSeq - this.config.maxEventsPerStream;
    if (cutoff <= 0) return;
    this.db.run('DELETE FROM mcp_events WHERE stream_id = ? AND seq <= ?', [streamId, cutoff]);
  }

  private pruneExpired(now: number): Promise<void> {
    const cutoff = now - this.config.ttlSeconds;
    if (cutoff <= 0) return Promise.resolve();

    return new Promise((resolve, reject) => {
      this.db.run('DELETE FROM mcp_events WHERE created_at < ?', [cutoff], (err) => {
        if (err) return reject(err);
        this.db.run(
          'DELETE FROM mcp_event_streams WHERE stream_id NOT IN (SELECT DISTINCT stream_id FROM mcp_events)',
          (err) => {
            if (err) reject(err);
            else resolve();
          }
        );
      });
    });
  }

  private pruneStreams(): void {
    this.db.get('SELECT COUNT(*) as count FROM mcp_event_streams', (err, row: { count: number }) => {
      if (err || !row) return;
      if (row.count <= this.config.maxStreams) return;

      const overflow = row.count - this.config.maxStreams;
      this.db.all(
        'SELECT stream_id FROM mcp_event_streams ORDER BY last_seen ASC LIMIT ?',
        [overflow],
        (err, rows: Array<{ stream_id: string }>) => {
          if (err || !rows) return;
          const streamIds = rows.map((r) => r.stream_id);
          const placeholders = streamIds.map(() => '?').join(',');
          this.db.run(`DELETE FROM mcp_events WHERE stream_id IN (${placeholders})`, streamIds);
          this.db.run(`DELETE FROM mcp_event_streams WHERE stream_id IN (${placeholders})`, streamIds);
        }
      );
    });
  }
}
