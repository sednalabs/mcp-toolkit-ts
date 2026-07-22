import { describe, expect, it } from 'vitest';
import {
  applyRedactions,
  diffObjects,
  filterDiffEntries,
  formatDiff,
} from '../client/scenarios/compare.js';

describe('script_compare', () => {
  it('filters diffs for ignored paths, including missing fields', () => {
    const expected = { foo: 1 };
    const actual = { foo: 2, extra: 3 };
    const ignorePaths = ['foo', 'extra'];

    const redactedExpected = applyRedactions(expected, ignorePaths);
    const redactedActual = applyRedactions(actual, ignorePaths);
    const diffs = filterDiffEntries(diffObjects(redactedExpected, redactedActual), ignorePaths);

    expect(diffs).toEqual([]);
  });

  it('formats diff output with paths', () => {
    const diffs = diffObjects({ nested: { value: 1 } }, { nested: { value: 2 } });
    const output = formatDiff(diffs);

    expect(output).toEqual('Differences:\n- $.nested.value: expected 1 got 2');
  });
});
