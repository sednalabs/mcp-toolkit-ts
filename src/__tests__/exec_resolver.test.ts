import { describe, expect, it } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { findActualExecutable } from '../internal/exec_resolver.js';

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'mcp-exec-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('findActualExecutable', () => {
  it('passes through explicit paths', () => {
    const result = findActualExecutable(process.execPath, ['--version']);
    expect(result).toEqual({ cmd: process.execPath, args: ['--version'] });
  });

  it('resolves commands on PATH', async () => {
    const priorPath = process.env.PATH;
    try {
      await withTempDir(async (dir) => {
        const baseName = 'mcp-toolkit-test-exec';
        if (process.platform === 'win32') {
          const exePath = path.join(dir, `${baseName}.cmd`);
          await writeFile(exePath, '@echo off\r\n');
          const pathEntries = [dir, priorPath].filter(
            (entry): entry is string => Boolean(entry),
          );
          process.env.PATH = pathEntries.join(path.delimiter);

          const result = findActualExecutable(baseName, ['--flag']);
          const systemRoot = process.env.SYSTEMROOT ?? 'C:\\Windows';
          const expectedCmd = path.join(systemRoot, 'System32', 'cmd.exe');

        expect(path.normalize(result.cmd).toLowerCase()).toBe(
          path.normalize(expectedCmd).toLowerCase(),
        );
        expect(result.args[0]).toBe('/C');
        const exeArg = result.args[1];
        if (!exeArg) {
          throw new Error('Expected cmd.exe to receive the script path.');
        }
        expect(path.normalize(exeArg).toLowerCase()).toBe(
          path.normalize(exePath).toLowerCase(),
        );
          expect(result.args.slice(2)).toEqual(['--flag']);
        } else {
          const exePath = path.join(dir, baseName);
          await writeFile(exePath, '#!/bin/sh\necho ok\n');
          await chmod(exePath, 0o755);
          const pathEntries = [dir, priorPath].filter(
            (entry): entry is string => Boolean(entry),
          );
          process.env.PATH = pathEntries.join(path.delimiter);

          const result = findActualExecutable(baseName, ['--flag']);
          expect(result).toEqual({ cmd: exePath, args: ['--flag'] });
        }
      });
    } finally {
      process.env.PATH = priorPath;
    }
  });
});
