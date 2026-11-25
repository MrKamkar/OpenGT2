import { describe, expect, it } from 'vitest';
import {
  BufferByteSource,
  type ByteSource,
  CD_SECTOR_SIZE,
  CachedByteSource,
  DEFAULT_CACHE_MAX_WINDOWS,
  DEFAULT_CACHE_WINDOW_SIZE,
  SlicedByteSource,
  validateByteRange,
} from '../../src/io';

class RecordingByteSource implements ByteSource {
  readonly size: number;
  readonly reads: Array<{ start: number; end: number }> = [];
  private readonly inner: ByteSource;
  private readonly delayMs: number;

  constructor(inner: ByteSource, delayMs = 0) {
    this.inner = inner;
    this.size = inner.size;
    this.delayMs = delayMs;
  }

  async read(start: number, end: number): Promise<Uint8Array> {
    validateByteRange(start, end, this.size);
    this.reads.push({ start, end });
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    return this.inner.read(start, end);
  }

  slice(start: number, end: number): ByteSource {
    return new SlicedByteSource(this, start, end);
  }
}

function createPatternBuffer(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) {
    bytes[i] = (i * 13 + 5) & 0xff;
  }
  return bytes;
}

describe('CachedByteSource', () => {
  it('uses CD sector alignment defaults (64 x 256 KiB aligned to 2048 B)', () => {
    const source = new BufferByteSource(new Uint8Array(1024));
    const cached = new CachedByteSource(source);

    expect(cached.alignment).toBe(CD_SECTOR_SIZE);
    expect(cached.windowSize).toBe(DEFAULT_CACHE_WINDOW_SIZE);
    expect(cached.maxWindows).toBe(DEFAULT_CACHE_MAX_WINDOWS);
    expect(cached.windowSize % CD_SECTOR_SIZE).toBe(0);
  });

  it('rejects invalid windowSize, alignment, or maxWindows options', () => {
    const source = new BufferByteSource(new Uint8Array(4096));

    expect(() => new CachedByteSource(source, { windowSize: 1000 })).toThrow(RangeError);
    expect(() => new CachedByteSource(source, { windowSize: 0 })).toThrow(RangeError);
    expect(() => new CachedByteSource(source, { maxWindows: 0 })).toThrow(RangeError);
    expect(() => new CachedByteSource(source, { alignment: 0 })).toThrow(RangeError);
    expect(() => new CachedByteSource(source, { windowSize: 2048.5 })).toThrow(RangeError);
  });

  it('aligns underlying source reads to 2048 B sector boundaries and clamps the tail window', async () => {
    // 2.5 sectors = 5120 bytes (not a multiple of 2048 B)
    const raw = createPatternBuffer(5120);
    const recording = new RecordingByteSource(new BufferByteSource(raw));
    const cached = new CachedByteSource(recording, {
      windowSize: CD_SECTOR_SIZE,
      maxWindows: 4,
    });

    // Unaligned read inside sector 0 -> fetches [0, 2048)
    const first = await cached.read(13, 29);
    expect(first).toEqual(raw.slice(13, 29));
    expect(recording.reads).toEqual([{ start: 0, end: 2048 }]);

    // Second read in sector 0 -> cache hit, no new source read
    const second = await cached.read(1000, 1024);
    expect(second).toEqual(raw.slice(1000, 1024));
    expect(recording.reads).toHaveLength(1);

    // Read spanning sector 1 and partial tail sector 2 -> fetches [2048, 4096) and [4096, 5120)
    const spanning = await cached.read(4000, 5100);
    expect(spanning).toEqual(raw.slice(4000, 5100));
    expect(recording.reads).toEqual([
      { start: 0, end: 2048 },
      { start: 2048, end: 4096 },
      { start: 4096, end: 5120 },
    ]);

    for (const req of recording.reads) {
      expect(req.start % CD_SECTOR_SIZE).toBe(0);
      expect(req.end % CD_SECTOR_SIZE === 0 || req.end === raw.byteLength).toBe(true);
    }

    expect(cached.getStats()).toEqual({
      hits: 1,
      misses: 3,
      evictions: 0,
      sourceReads: 3,
      bytesReadFromSource: 5120,
      cachedWindows: 3,
    });
  });

  it('evicts the least recently used window and refreshes recency on hits', async () => {
    const raw = createPatternBuffer(CD_SECTOR_SIZE * 4);
    const recording = new RecordingByteSource(new BufferByteSource(raw));
    const cached = new CachedByteSource(recording, {
      windowSize: CD_SECTOR_SIZE,
      maxWindows: 2,
    });

    // Load window 0, then window 1 (cache order: [0, 1])
    await cached.read(0, 16);
    await cached.read(CD_SECTOR_SIZE, CD_SECTOR_SIZE + 16);
    expect(cached.getStats().sourceReads).toBe(2);

    // Touch window 0 -> hit; recency order becomes [1, 0]
    await cached.read(16, 32);
    expect(cached.getStats().hits).toBe(1);
    expect(cached.getStats().sourceReads).toBe(2);

    // Load window 2 -> evicts window 1 (LRU), keeping [0, 2]
    await cached.read(CD_SECTOR_SIZE * 2, CD_SECTOR_SIZE * 2 + 16);
    expect(cached.getStats().evictions).toBe(1);
    expect(cached.getStats().cachedWindows).toBe(2);
    expect(cached.getStats().sourceReads).toBe(3);

    // Window 0 must still be cached (hit)
    await cached.read(64, 80);
    expect(cached.getStats().hits).toBe(2);
    expect(cached.getStats().sourceReads).toBe(3);

    // Window 1 was evicted -> miss, reloads from source and evicts window 2
    const reloaded = await cached.read(CD_SECTOR_SIZE + 10, CD_SECTOR_SIZE + 26);
    expect(reloaded).toEqual(raw.slice(CD_SECTOR_SIZE + 10, CD_SECTOR_SIZE + 26));
    expect(cached.getStats()).toMatchObject({
      hits: 2,
      misses: 4,
      evictions: 2,
      sourceReads: 4,
      cachedWindows: 2,
    });
  });

  it('coalesces concurrent reads targeting the same uncached window into one source read', async () => {
    const raw = createPatternBuffer(CD_SECTOR_SIZE * 2);
    const recording = new RecordingByteSource(new BufferByteSource(raw), 5);
    const cached = new CachedByteSource(recording, {
      windowSize: CD_SECTOR_SIZE,
      maxWindows: 2,
    });

    const [a, b] = await Promise.all([cached.read(0, 32), cached.read(100, 132)]);
    expect(a).toEqual(raw.slice(0, 32));
    expect(b).toEqual(raw.slice(100, 132));
    expect(recording.reads).toEqual([{ start: 0, end: CD_SECTOR_SIZE }]);
    expect(cached.getStats().sourceReads).toBe(1);
  });

  it('supports empty ranges, zero-copy slice() through cache, clear(), and buffer isolation', async () => {
    const raw = createPatternBuffer(CD_SECTOR_SIZE * 2);
    const recording = new RecordingByteSource(new BufferByteSource(raw));
    const cached = new CachedByteSource(recording, {
      windowSize: CD_SECTOR_SIZE,
      maxWindows: 4,
    });

    expect(await cached.read(10, 10)).toEqual(new Uint8Array(0));
    expect(recording.reads).toHaveLength(0);

    const view = cached.slice(512, 3000);
    const chunk = await view.read(0, 32);
    expect(chunk).toEqual(raw.slice(512, 544));

    // Mutating returned chunk must not corrupt cached bytes
    chunk[0] = (chunk[0] ?? 0) ^ 0xff;
    expect(await cached.read(512, 544)).toEqual(raw.slice(512, 544));
    expect(cached.getStats().hits).toBe(1);
    expect(cached.getStats().sourceReads).toBe(1);

    cached.clear();
    expect(cached.getStats().cachedWindows).toBe(0);

    await cached.read(512, 544);
    expect(cached.getStats().sourceReads).toBe(2);

    cached.resetStats();
    expect(cached.getStats()).toEqual({
      hits: 0,
      misses: 0,
      evictions: 0,
      sourceReads: 0,
      bytesReadFromSource: 0,
      cachedWindows: 1,
    });

    await expect(cached.read(-1, 10)).rejects.toThrow(RangeError);
    await expect(cached.read(0, raw.byteLength + 1)).rejects.toThrow(RangeError);
  });
});
