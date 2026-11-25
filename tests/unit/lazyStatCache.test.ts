import { describe, expect, it, vi } from 'vitest';
import type { VolEntry } from '../../src/formats/vol';
import { LazyStatCache } from '../../src/ui/explorer/lazyStatCache';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeFileStat(path: string, isGzip: boolean): VolEntry {
  return {
    path,
    kind: 'file',
    address: 0x800,
    size: 128,
    unixTime: 945_000_000,
    isGzip,
  };
}

describe('LazyStatCache (M2.8)', () => {
  it('probes only visible paths, enforces concurrency, and caches gzip/plain states', async () => {
    const pending = new Map<string, ReturnType<typeof deferred<VolEntry | undefined>>>();
    const statCalls: string[] = [];
    const updates: string[] = [];

    const cache = new LazyStatCache({
      maxConcurrent: 2,
      onUpdate: (path) => updates.push(path),
      stat: (path) => {
        statCalls.push(path);
        const d = deferred<VolEntry | undefined>();
        pending.set(path, d);
        return d.promise;
      },
    });

    cache.setVisible(['a.gz', 'b.bin', 'c.gz', 'a.gz']);
    expect(statCalls).toEqual(['a.gz', 'b.bin']);
    expect(cache.inFlightCount).toBe(2);
    expect(cache.queuedCount).toBe(1);
    expect(cache.getGzipState('a.gz')).toBe('pending');
    expect(cache.getGzipState('c.gz')).toBe('unknown');

    pending.get('a.gz')?.resolve(makeFileStat('a.gz', true));
    await Promise.resolve();
    await Promise.resolve();

    expect(cache.getGzipState('a.gz')).toBe('gzip');
    expect(cache.has('a.gz')).toBe(true);
    expect(cache.get('a.gz')?.isGzip).toBe(true);
    // Third path starts once a concurrency slot frees.
    expect(statCalls).toEqual(['a.gz', 'b.bin', 'c.gz']);

    pending.get('b.bin')?.resolve(makeFileStat('b.bin', false));
    pending.get('c.gz')?.resolve(makeFileStat('c.gz', true));
    await Promise.resolve();
    await Promise.resolve();

    expect(cache.getGzipState('b.bin')).toBe('plain');
    expect(cache.getGzipState('c.gz')).toBe('gzip');
    expect(updates).toEqual(['a.gz', 'b.bin', 'c.gz']);

    // Repeating setVisible for already-cached paths triggers zero new stat calls.
    cache.setVisible(['a.gz', 'b.bin', 'c.gz']);
    expect(statCalls).toHaveLength(3);
    expect(cache.getStats()).toEqual({ started: 3, completed: 3, failed: 0, cancelled: 0 });
  });

  it('aborts unpinned in-flight requests when scrolled out of view and ignores late settlements', async () => {
    const signals = new Map<string, AbortSignal>();
    const pending = new Map<string, ReturnType<typeof deferred<VolEntry | undefined>>>();
    const updates: string[] = [];

    const cache = new LazyStatCache({
      maxConcurrent: 2,
      onUpdate: (path) => updates.push(path),
      stat: (path, signal) => {
        signals.set(path, signal);
        const d = deferred<VolEntry | undefined>();
        pending.set(path, d);
        return d.promise;
      },
    });

    cache.setVisible(['row1.bin', 'row2.bin', 'row3.bin']);
    expect(signals.get('row1.bin')?.aborted).toBe(false);

    // Scroll away to completely different rows.
    cache.setVisible(['row10.bin']);
    expect(signals.get('row1.bin')?.aborted).toBe(true);
    expect(signals.get('row2.bin')?.aborted).toBe(true);
    expect(cache.getStats().cancelled).toBe(2);

    // Late resolution of an aborted probe must NOT populate cache or emit updates.
    pending.get('row1.bin')?.resolve(makeFileStat('row1.bin', true));
    await Promise.resolve();
    expect(cache.has('row1.bin')).toBe(false);
    expect(cache.getGzipState('row1.bin')).toBe('unknown');
    expect(updates).toEqual([]);

    pending.get('row10.bin')?.resolve(makeFileStat('row10.bin', false));
    await Promise.resolve();
    expect(cache.getGzipState('row10.bin')).toBe('plain');
  });

  it('pins ensure() across visibility changes, handles errors, and cleans up on dispose()', async () => {
    const signals = new Map<string, AbortSignal>();
    const pending = new Map<string, ReturnType<typeof deferred<VolEntry | undefined>>>();
    let failOnce = true;

    const cache = new LazyStatCache({
      maxConcurrent: 1,
      stat: (path, signal) => {
        signals.set(path, signal);
        if (path === 'flaky.bin' && failOnce) {
          failOnce = false;
          return Promise.reject(new Error('I/O glitch'));
        }
        const d = deferred<VolEntry | undefined>();
        pending.set(path, d);
        return d.promise;
      },
    });

    // Visibility-driven failure marks state 'error' without throwing unhandled rejection.
    cache.setVisible(['flaky.bin']);
    await Promise.resolve();
    await Promise.resolve();
    expect(cache.getGzipState('flaky.bin')).toBe('error');
    expect(cache.getStats().failed).toBe(1);

    // ensure() retries a previously failed path and resolves once completed.
    const retryPromise = cache.ensure('flaky.bin');
    cache.setVisible([]); // Must NOT cancel pinned ensure().
    expect(signals.get('flaky.bin')?.aborted).toBe(false);
    pending.get('flaky.bin')?.resolve(makeFileStat('flaky.bin', true));
    await expect(retryPromise).resolves.toMatchObject({ path: 'flaky.bin', isGzip: true });

    // ensure() also pins an already in-flight visibility request.
    cache.setVisible(['selected.bin']);
    const pinnedPromise = cache.ensure('selected.bin');
    cache.setVisible(['other.bin']);
    expect(signals.get('selected.bin')?.aborted).toBe(false);
    pending.get('selected.bin')?.resolve(makeFileStat('selected.bin', false));
    await expect(pinnedPromise).resolves.toMatchObject({ path: 'selected.bin', isGzip: false });

    // dispose() aborts remaining in-flight probes and rejects subsequent ensure().
    const onAbort = vi.fn();
    signals.get('other.bin')?.addEventListener('abort', onAbort);
    cache.dispose();
    expect(onAbort).toHaveBeenCalledTimes(1);
    await expect(cache.ensure('after-dispose.bin')).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('rejects invalid maxConcurrent', () => {
    expect(() => new LazyStatCache({ stat: async () => undefined, maxConcurrent: 0 })).toThrow(RangeError);
  });
});
