import { createHash } from 'node:crypto';
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export type SourceFingerprint = {
  algorithm: string;
  digest: string;
  fileCount: number;
  totalBytes: number;
  value: string;
};

const ALGORITHM = 'sha256';
const FINGERPRINTED_SUFFIXES = ['.ts', '.js', '.sql', '.json'];
const EXCLUDED_DIR_NAMES = new Set(['node_modules', '__pycache__', 'tests', 'dist', '.git']);

let startupSourceRootPath: string | null = null;
let startupSourceFingerprintValue: SourceFingerprint | null = null;

export function getStartupSourceRoot(): string | null {
  return startupSourceRootPath;
}

export function getStartupSourceFingerprint(): SourceFingerprint | null {
  return startupSourceFingerprintValue;
}

export function initStartupSourceFingerprint(root: string): SourceFingerprint | null {
  if (startupSourceFingerprintValue !== null) {
    return startupSourceFingerprintValue;
  }

  try {
    const fingerprint = computeSourceFingerprint(root);
    startupSourceRootPath = root;
    startupSourceFingerprintValue = fingerprint;
    return fingerprint;
  } catch {
    startupSourceRootPath = root;
    startupSourceFingerprintValue = null;
    return null;
  }
}

export function computeSourceFingerprint(root: string): SourceFingerprint {
  const files = iterSourceFiles(root);
  const hasher = createHash(ALGORITHM);
  let totalBytes = 0;

  for (const filePath of files) {
    const rel = relative(root, filePath).split(sep).join('/');
    hasher.update(rel, 'utf8');
    hasher.update('\0', 'utf8');

    const content = readFileSync(filePath);
    totalBytes += content.length;
    hasher.update(content);
    hasher.update('\0', 'utf8');
  }

  const digest = hasher.digest('hex');
  return {
    algorithm: ALGORITHM,
    digest,
    fileCount: files.length,
    totalBytes,
    value: `${ALGORITHM}:${digest}`,
  };
}

function iterSourceFiles(root: string): string[] {
  const candidates: string[] = [];

  function walk(dir: string) {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);

      if (stat.isDirectory()) {
        if (EXCLUDED_DIR_NAMES.has(entry)) continue;
        walk(fullPath);
      } else if (stat.isFile()) {
        if (FINGERPRINTED_SUFFIXES.some((suffix) => entry.endsWith(suffix))) {
          candidates.push(fullPath);
        }
      }
    }
  }

  walk(root);
  return candidates.sort((a, b) => {
    const relA = relative(root, a).split(sep).join('/');
    const relB = relative(root, b).split(sep).join('/');
    return relA.localeCompare(relB);
  });
}
