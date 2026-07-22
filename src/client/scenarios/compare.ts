const REDACTED_VALUE = '[ignored]';

type PathToken =
  | { type: 'key'; value: string }
  | { type: 'index'; value: number };

type PatternToken =
  | { type: 'key'; value: string }
  | { type: 'index'; value: number }
  | { type: 'wildcard' };

export type DiffEntry = {
  path: string;
  expected: unknown;
  actual: unknown;
  kind?: 'missing-expected' | 'missing-actual';
};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pathToString(tokens: PathToken[]): string {
  if (tokens.length === 0) return '$';
  let result = '$';
  for (const token of tokens) {
    if (token.type === 'key') {
      result += `.${token.value}`;
    } else {
      result += `[${token.value}]`;
    }
  }
  return result;
}

function parsePattern(pattern: string): PatternToken[] {
  const tokens: PatternToken[] = [];
  let buffer = '';
  let i = 0;
  const flushBuffer = () => {
    if (!buffer) return;
    if (buffer === '*') {
      tokens.push({ type: 'wildcard' });
    } else {
      tokens.push({ type: 'key', value: buffer });
    }
    buffer = '';
  };

  while (i < pattern.length) {
    const char = pattern[i];
    if (char === '.') {
      flushBuffer();
      i += 1;
      continue;
    }
    if (char === '[') {
      flushBuffer();
      const closing = pattern.indexOf(']', i + 1);
      if (closing === -1) {
        buffer += pattern.slice(i);
        break;
      }
      const inside = pattern.slice(i + 1, closing);
      if (inside === '*' || inside === '') {
        tokens.push({ type: 'wildcard' });
      } else {
        const parsed = Number(inside);
        if (Number.isFinite(parsed)) {
          tokens.push({ type: 'index', value: parsed });
        } else {
          tokens.push({ type: 'key', value: inside });
        }
      }
      i = closing + 1;
      continue;
    }
    buffer += char;
    i += 1;
  }

  flushBuffer();
  return tokens;
}

function matchesPattern(path: PathToken[], pattern: PatternToken[]): boolean {
  if (pattern.length > path.length) {
    return false;
  }
  for (let i = 0; i < pattern.length; i += 1) {
    const patternToken = pattern[i];
    const pathToken = path[i];
    if (!patternToken || !pathToken) {
      return false;
    }
    if (patternToken.type === 'wildcard') {
      continue;
    }
    if (patternToken.type !== pathToken.type) {
      return false;
    }
    if (patternToken.value !== pathToken.value) {
      return false;
    }
  }
  return true;
}

function compilePatterns(patterns: string[]): PatternToken[][] {
  return patterns
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern.length > 0)
    .map((pattern) => parsePattern(pattern));
}

function shouldRedact(path: PathToken[], compiled: PatternToken[][]): boolean {
  return compiled.some((pattern) => matchesPattern(path, pattern));
}

function parsePath(path: string): PathToken[] {
  const tokens: PathToken[] = [];
  let i = path.startsWith('$') ? 1 : 0;
  while (i < path.length) {
    const char = path[i];
    if (char === '.') {
      i += 1;
      let buffer = '';
      while (i < path.length && path[i] !== '.' && path[i] !== '[') {
        buffer += path[i];
        i += 1;
      }
      if (buffer) {
        tokens.push({ type: 'key', value: buffer });
      }
      continue;
    }
    if (char === '[') {
      const closing = path.indexOf(']', i + 1);
      if (closing === -1) {
        break;
      }
      const inside = path.slice(i + 1, closing);
      const parsed = Number(inside);
      if (Number.isFinite(parsed)) {
        tokens.push({ type: 'index', value: parsed });
      } else if (inside) {
        tokens.push({ type: 'key', value: inside });
      }
      i = closing + 1;
      continue;
    }
    i += 1;
  }
  return tokens;
}

export function applyRedactions(value: unknown, ignorePatterns: string[]): unknown {
  if (!ignorePatterns.length) {
    return value;
  }
  const compiled = compilePatterns(ignorePatterns);

  const walk = (current: unknown, path: PathToken[]): unknown => {
    if (shouldRedact(path, compiled)) {
      return REDACTED_VALUE;
    }

    if (Array.isArray(current)) {
      return current.map((entry, index) =>
        walk(entry, [...path, { type: 'index', value: index }]),
      );
    }

    if (isObject(current)) {
      const result: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(current)) {
        result[key] = walk(entry, [...path, { type: 'key', value: key }]);
      }
      return result;
    }

    return current;
  };

  return walk(value, []);
}

export function diffObjects(expected: unknown, actual: unknown): DiffEntry[] {
  const diffs: DiffEntry[] = [];

  const walk = (exp: unknown, act: unknown, path: PathToken[]) => {
    if (Object.is(exp, act)) {
      return;
    }

    if (Array.isArray(exp) || Array.isArray(act)) {
      if (!Array.isArray(exp) || !Array.isArray(act)) {
        diffs.push({
          path: pathToString(path),
          expected: exp,
          actual: act,
        });
        return;
      }
      const max = Math.max(exp.length, act.length);
      for (let index = 0; index < max; index += 1) {
        const nextPath: PathToken[] = [...path, { type: 'index', value: index }];
        if (index >= exp.length) {
          diffs.push({
            path: pathToString(nextPath),
            expected: undefined,
            actual: act[index],
            kind: 'missing-expected',
          });
          continue;
        }
        if (index >= act.length) {
          diffs.push({
            path: pathToString(nextPath),
            expected: exp[index],
            actual: undefined,
            kind: 'missing-actual',
          });
          continue;
        }
        walk(exp[index], act[index], nextPath);
      }
      return;
    }

    if (isObject(exp) && isObject(act)) {
      const keys = new Set([...Object.keys(exp), ...Object.keys(act)]);
      for (const key of keys) {
        const hasExpected = Object.prototype.hasOwnProperty.call(exp, key);
        const hasActual = Object.prototype.hasOwnProperty.call(act, key);
        const nextPath: PathToken[] = [...path, { type: 'key', value: key }];
        if (!hasExpected) {
          diffs.push({
            path: pathToString(nextPath),
            expected: undefined,
            actual: act[key],
            kind: 'missing-expected',
          });
          continue;
        }
        if (!hasActual) {
          diffs.push({
            path: pathToString(nextPath),
            expected: exp[key],
            actual: undefined,
            kind: 'missing-actual',
          });
          continue;
        }
        walk(exp[key], act[key], nextPath);
      }
      return;
    }

    diffs.push({
      path: pathToString(path),
      expected: exp,
      actual: act,
    });
  };

  walk(expected, actual, []);
  return diffs;
}

export function filterDiffEntries(entries: DiffEntry[], ignorePatterns: string[]): DiffEntry[] {
  if (!ignorePatterns.length) {
    return entries;
  }
  const compiled = compilePatterns(ignorePatterns);
  return entries.filter((entry) => {
    const pathTokens = parsePath(entry.path);
    return !shouldRedact(pathTokens, compiled);
  });
}

function formatValue(value: unknown, kind?: 'missing-expected' | 'missing-actual'): string {
  if (kind === 'missing-expected' || kind === 'missing-actual') {
    return '[missing]';
  }
  if (typeof value === 'string') {
    return `"${value}"`;
  }
  if (value === undefined) {
    return 'undefined';
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function formatDiff(entries: DiffEntry[]): string | undefined {
  if (entries.length === 0) {
    return undefined;
  }
  const lines = entries.map((entry) => {
    const expected = formatValue(
      entry.expected,
      entry.kind === 'missing-expected' ? entry.kind : undefined,
    );
    const actual = formatValue(
      entry.actual,
      entry.kind === 'missing-actual' ? entry.kind : undefined,
    );
    return `- ${entry.path}: expected ${expected} got ${actual}`;
  });
  return `Differences:\n${lines.join('\n')}`;
}

export function resolveIgnorePatterns(base?: string[], extra?: string[]): string[] {
  const merged = [...(base ?? []), ...(extra ?? [])].map((value) => value.trim());
  return merged.filter((value) => value.length > 0);
}
