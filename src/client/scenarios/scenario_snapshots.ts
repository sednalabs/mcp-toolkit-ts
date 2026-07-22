import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type SnapshotFile = {
  version: number;
  snapshots: Record<string, unknown>;
};

export async function loadSnapshots(snapshotPath: string): Promise<SnapshotFile> {
  try {
    const raw = await readFile(snapshotPath, 'utf8');
    const parsed = JSON.parse(raw) as SnapshotFile;
    if (!parsed.snapshots || typeof parsed.snapshots !== 'object') {
      return { version: 1, snapshots: {} };
    }
    return {
      version: parsed.version ?? 1,
      snapshots: parsed.snapshots,
    };
  } catch {
    return { version: 1, snapshots: {} };
  }
}

export async function saveSnapshots(snapshotPath: string, snapshots: SnapshotFile): Promise<void> {
  await mkdir(path.dirname(snapshotPath), { recursive: true });
  const ordered: SnapshotFile = {
    version: snapshots.version,
    snapshots: Object.fromEntries(
      Object.entries(snapshots.snapshots).sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
  await writeFile(snapshotPath, `${JSON.stringify(ordered, null, 2)}
`, 'utf8');
}
