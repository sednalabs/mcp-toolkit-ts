/*
Portions of this file are derived from spawn-rx (MIT License).
Copyright (c) 2016 Anais Betts

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
import fs from 'node:fs';
import path from 'node:path';

export type ResolvedExecutable = {
  cmd: string;
  args: string[];
};

const isWindows = process.platform === 'win32';
const maxCacheEntries = 512;
const pathCache = new Map<string, string>();

function rememberPath(key: string, value: string): string {
  if (pathCache.size >= maxCacheEntries) {
    const firstKey = pathCache.keys().next().value as string | undefined;
    if (firstKey) {
      pathCache.delete(firstKey);
    }
  }
  pathCache.set(key, value);
  return value;
}

function statSyncNoException(file: string): fs.Stats | null {
  try {
    return fs.statSync(file);
  } catch {
    return null;
  }
}

function runDownPath(exe: string): string {
  const cached = pathCache.get(exe);
  if (cached !== undefined) {
    pathCache.delete(exe);
    pathCache.set(exe, cached);
    return cached;
  }

  if (exe.match(/[\\/]/)) {
    return rememberPath(exe, exe);
  }

  const target = path.join('.', exe);
  if (statSyncNoException(target)) {
    return rememberPath(exe, target);
  }

  const haystack = process.env.PATH?.split(isWindows ? ';' : ':');
  if (haystack) {
    for (const entry of haystack) {
      if (!entry) {
        continue;
      }
      const needle = path.join(entry, exe);
      if (statSyncNoException(needle)) {
        return rememberPath(exe, needle);
      }
    }
  }

  return rememberPath(exe, exe);
}

export function findActualExecutable(exe: string, args: string[]): ResolvedExecutable {
  if (!isWindows) {
    return { cmd: runDownPath(exe), args };
  }

  if (!fs.existsSync(exe)) {
    const possibleExts = ['.exe', '.bat', '.cmd', '.ps1'];
    for (const ext of possibleExts) {
      const possibleFullPath = runDownPath(`${exe}${ext}`);
      if (fs.existsSync(possibleFullPath)) {
        return findActualExecutable(possibleFullPath, args);
      }
    }
  }

  if (exe.match(/\.ps1$/i)) {
    const systemRoot = process.env.SYSTEMROOT ?? 'C:\\Windows';
    const cmd = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'PowerShell.exe');
    const psArgs = ['-ExecutionPolicy', 'Unrestricted', '-NoLogo', '-NonInteractive', '-File', exe];
    return { cmd, args: psArgs.concat(args) };
  }

  if (exe.match(/\.(bat|cmd)$/i)) {
    const systemRoot = process.env.SYSTEMROOT ?? 'C:\\Windows';
    const cmd = path.join(systemRoot, 'System32', 'cmd.exe');
    return { cmd, args: ['/C', exe, ...args] };
  }

  if (exe.match(/\.(js)$/i)) {
    return { cmd: process.execPath, args: [exe, ...args] };
  }

  return { cmd: exe, args };
}
