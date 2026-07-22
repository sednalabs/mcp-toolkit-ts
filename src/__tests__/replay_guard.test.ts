import { describe, expect, it } from 'vitest';
import { ReplayGuard } from '../server/auth/replay_guard.js';

describe('ReplayGuard', () => {
  it('marks repeated token ids as replay within ttl', () => {
    let now = 1_000;
    const guard = new ReplayGuard({
      ttlSeconds: 10,
      maxEntries: 100,
      now: () => now,
    });

    expect(guard.seen('jti-1')).toBe(false);
    expect(guard.seen('jti-1')).toBe(true);

    now += 11_000;
    expect(guard.seen('jti-1')).toBe(false);
  });

  it('evicts oldest entries when capacity is reached', () => {
    let now = 0;
    const guard = new ReplayGuard({
      ttlSeconds: 1_000,
      maxEntries: 100,
      now: () => now,
    });

    for (let i = 0; i < 100; i += 1) {
      now += 1;
      expect(guard.seen(`jti-${i}`)).toBe(false);
    }

    now += 1;
    expect(guard.seen('jti-new')).toBe(false);

    now += 1;
    expect(guard.seen('jti-0')).toBe(false);
  });
});
