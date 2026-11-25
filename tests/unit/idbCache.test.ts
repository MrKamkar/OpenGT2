import { describe, expect, it } from 'vitest';
import {
  IdbCache,
  buildCacheKey,
  createIndexedDbCacheBackend,
  createMemoryIdbCacheBackend,
} from '../../src/io';

function makeBuffer(byteLength: number, fillByte: number): ArrayBuffer {
  const bytes = new Uint8Array(byteLength);
  bytes.fill(fillByte & 0xff);
  return bytes.buffer;
}

function toArray(buffer: ArrayBuffer | null): number[] | null {
  if (buffer === null) {
    return null;
  }
  return Array.from(new Uint8Array(buffer));
}

describe('IdbCache (M1.7)', () => {
  it('stores and retrieves isolated ArrayBuffer copies and supports delete/clear', async () => {
    const backend = createMemoryIdbCacheBackend();
    const cache = new IdbCache({ backend, version: 'v1', maxBytes: 1024 });

    const original = makeBuffer(4, 0x2a);
    expect(await cache.set('entry-a', original)).toBe(true);

    // Mutating the caller buffer after set must not corrupt cached bytes.
    new Uint8Array(original)[0] = 0xff;

    const loaded = await cache.get('entry-a');
    expect(toArray(loaded)).toEqual([0x2a, 0x2a, 0x2a, 0x2a]);

    // Mutating the returned buffer must not corrupt subsequent reads.
    if (loaded !== null) {
      new Uint8Array(loaded)[1] = 0x99;
    }
    expect(toArray(await cache.get('entry-a'))).toEqual([0x2a, 0x2a, 0x2a, 0x2a]);

    expect(await cache.getStats()).toEqual({
      entryCount: 1,
      totalBytes: 4,
      maxBytes: 1024,
      version: 'v1',
    });

    await cache.delete('entry-a');
    expect(await cache.get('entry-a')).toBeNull();

    await cache.set('entry-b', makeBuffer(8, 0x11));
    await cache.set('entry-c', makeBuffer(8, 0x22));
    await cache.clear();

    expect(await cache.get('entry-b')).toBeNull();
    expect(await cache.get('entry-c')).toBeNull();
    expect(await cache.getStats()).toEqual({
      entryCount: 0,
      totalBytes: 0,
      maxBytes: 1024,
      version: 'v1',
    });
  });

  it('enforces maxBytes by evicting oldest entries deterministically (LRU)', async () => {
    let clock = 1000;
    const backend = createMemoryIdbCacheBackend();
    const cache = new IdbCache({
      backend,
      version: 'v1',
      maxBytes: 100,
      now: () => clock,
    });

    // Write 3 entries totaling 90 bytes under the same timestamp (verifies seq tie-breaker too).
    expect(await cache.set('a', makeBuffer(30, 1))).toBe(true);
    expect(await cache.set('b', makeBuffer(30, 2))).toBe(true);
    expect(await cache.set('c', makeBuffer(30, 3))).toBe(true);

    // Touch 'a' so 'b' becomes the oldest entry.
    clock = 2000;
    expect(toArray(await cache.get('a'))?.[0]).toBe(1);

    // Adding 40 bytes (total would be 130 > 100) must evict 'b' first (90 - 30 + 40 = 100).
    clock = 3000;
    expect(await cache.set('d', makeBuffer(40, 4))).toBe(true);

    expect(await cache.get('b')).toBeNull();
    expect(toArray(await cache.get('a'))?.[0]).toBe(1);
    expect(toArray(await cache.get('c'))?.[0]).toBe(3);
    expect(toArray(await cache.get('d'))?.[0]).toBe(4);

    // Adding 80 bytes requires evicting multiple oldest entries until <= 100 bytes.
    clock = 4000;
    expect(await cache.set('e', makeBuffer(80, 5))).toBe(true);
    const stats = await cache.getStats();
    expect(stats.totalBytes).toBeLessThanOrEqual(100);
    expect(toArray(await cache.get('e'))?.[0]).toBe(5);
  });

  it('rejects single items larger than maxBytes without corrupting existing cache state', async () => {
    const backend = createMemoryIdbCacheBackend();
    const cache = new IdbCache({ backend, version: 'v1', maxBytes: 32 });

    expect(await cache.set('small', makeBuffer(16, 7))).toBe(true);
    expect(await cache.set('oversized', makeBuffer(64, 9))).toBe(false);

    expect(await cache.get('oversized')).toBeNull();
    expect(toArray(await cache.get('small'))?.[0]).toBe(7);

    // Overwriting an existing key with an oversized payload removes the outdated value.
    expect(await cache.set('small', makeBuffer(64, 8))).toBe(false);
    expect(await cache.get('small')).toBeNull();
  });

  it('invalidates stale entries when decoder/schema version changes', async () => {
    const sharedBackend = createMemoryIdbCacheBackend();
    const cacheV1 = new IdbCache({ backend: sharedBackend, version: 'decoder-1', maxBytes: 100 });

    await cacheV1.set('k1', makeBuffer(40, 0xaa));
    await cacheV1.set('k2', makeBuffer(40, 0xbb));

    // Upgrade decoder version against the same persistent backend.
    const cacheV2 = new IdbCache({ backend: sharedBackend, version: 'decoder-2', maxBytes: 100 });

    // Reading a v1 entry returns null and removes it.
    expect(await cacheV2.get('k1')).toBeNull();

    // Stats only reflect current-version entries.
    expect(await cacheV2.getStats()).toEqual({
      entryCount: 0,
      totalBytes: 0,
      maxBytes: 100,
      version: 'decoder-2',
    });

    // purgeStale removes remaining v1 entries explicitly.
    expect(await cacheV2.purgeStale()).toBe(1);

    // Writing a new entry under v2 also purges any stale entries from prior versions.
    await cacheV1.set('legacy', makeBuffer(80, 0xcc));
    expect(await cacheV2.set('fresh', makeBuffer(90, 0xdd))).toBe(true);
    expect(await cacheV1.get('legacy')).toBeNull();
    expect(toArray(await cacheV2.get('fresh'))?.[0]).toBe(0xdd);
  });

  it('validates constructor options, builds canonical keys, and degrades cleanly without indexedDB', async () => {
    expect(() => new IdbCache({ version: '   ' })).toThrow(RangeError);
    expect(() => new IdbCache({ maxBytes: -1 })).toThrow(RangeError);
    expect(() => new IdbCache({ maxBytes: 1.5 })).toThrow(RangeError);

    expect(buildCacheKey('abc123', 'car/model.cdo', 'v2')).toBe('v2:abc123:car/model.cdo');

    const noIdbBackend = createIndexedDbCacheBackend({ indexedDB: undefined });
    const fallbackCache = new IdbCache({ backend: noIdbBackend, version: 'v1', maxBytes: 1024 });
    expect(await fallbackCache.set('x', makeBuffer(8, 1))).toBe(true);
    expect(await fallbackCache.get('x')).toBeNull();
    await expect(fallbackCache.clear()).resolves.toBeUndefined();
    expect(await fallbackCache.getStats()).toEqual({
      entryCount: 0,
      totalBytes: 0,
      maxBytes: 1024,
      version: 'v1',
    });
  });
});
