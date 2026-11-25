import { type ByteSource, SlicedByteSource, validateByteRange } from './ByteSource';

/** Standard CD-ROM Mode 1/2 user sector size in bytes (PS1 / GT2 archive alignment). */
export const CD_SECTOR_SIZE = 2048;

/** Default cache window size: 256 KiB (128 × 2048 B CD sectors). */
export const DEFAULT_CACHE_WINDOW_SIZE = 256 * 1024;

/** Default maximum number of cached windows: 64 × 256 KiB = 16 MiB cap. */
export const DEFAULT_CACHE_MAX_WINDOWS = 64;

export interface CachedByteSourceOptions {
  /** Size of each aligned cache window in bytes. Must be a positive multiple of `alignment`. */
  readonly windowSize?: number;
  /** Maximum number of windows kept in the LRU cache. Must be >= 1. */
  readonly maxWindows?: number;
  /** Read alignment boundary in bytes. Defaults to CD_SECTOR_SIZE (2048 B). */
  readonly alignment?: number;
}

export interface CacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly sourceReads: number;
  readonly bytesReadFromSource: number;
  readonly cachedWindows: number;
}

function validatePositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive safe integer, got ${String(value)}`);
  }
}

/**
 * Sector-aligned LRU window cache wrapping any ByteSource.
 * Aligns all underlying source reads to `windowSize` (a multiple of 2048 B CD sectors),
 * clamping the final window to `source.size`.
 */
export class CachedByteSource implements ByteSource {
  readonly size: number;
  readonly windowSize: number;
  readonly maxWindows: number;
  readonly alignment: number;

  private readonly source: ByteSource;
  private readonly cache = new Map<number, Uint8Array>();
  private readonly inFlight = new Map<number, Promise<Uint8Array>>();

  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private sourceReads = 0;
  private bytesReadFromSource = 0;

  constructor(source: ByteSource, options: CachedByteSourceOptions = {}) {
    const alignment = options.alignment ?? CD_SECTOR_SIZE;
    const windowSize = options.windowSize ?? DEFAULT_CACHE_WINDOW_SIZE;
    const maxWindows = options.maxWindows ?? DEFAULT_CACHE_MAX_WINDOWS;

    validatePositiveSafeInteger(alignment, 'alignment');
    validatePositiveSafeInteger(windowSize, 'windowSize');
    validatePositiveSafeInteger(maxWindows, 'maxWindows');

    if (windowSize % alignment !== 0) {
      throw new RangeError(
        `windowSize (${String(windowSize)}) must be a multiple of alignment (${String(alignment)})`,
      );
    }

    this.source = source;
    this.size = source.size;
    this.alignment = alignment;
    this.windowSize = windowSize;
    this.maxWindows = maxWindows;
  }

  async read(start: number, end: number): Promise<Uint8Array> {
    validateByteRange(start, end, this.size);
    const totalLength = end - start;
    if (totalLength === 0) {
      return new Uint8Array(0);
    }

    const firstWindow = Math.floor(start / this.windowSize);
    const lastWindow = Math.floor((end - 1) / this.windowSize);

    if (firstWindow === lastWindow) {
      const windowData = await this.getWindow(firstWindow);
      const winStart = firstWindow * this.windowSize;
      // Copy only the requested range so callers cannot mutate cached windows.
      return windowData.slice(start - winStart, end - winStart);
    }

    const result = new Uint8Array(totalLength);
    let writeOffset = 0;

    for (let windowIndex = firstWindow; windowIndex <= lastWindow; windowIndex += 1) {
      const windowData = await this.getWindow(windowIndex);
      const winStart = windowIndex * this.windowSize;
      const segStart = Math.max(start, winStart);
      const segEnd = Math.min(end, winStart + windowData.byteLength);
      const slice = windowData.subarray(segStart - winStart, segEnd - winStart);
      result.set(slice, writeOffset);
      writeOffset += slice.byteLength;
    }

    return result;
  }

  slice(start: number, end: number): ByteSource {
    validateByteRange(start, end, this.size);
    return new SlicedByteSource(this, start, end);
  }

  getStats(): CacheStats {
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      sourceReads: this.sourceReads,
      bytesReadFromSource: this.bytesReadFromSource,
      cachedWindows: this.cache.size,
    };
  }

  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
    this.sourceReads = 0;
    this.bytesReadFromSource = 0;
  }

  clear(): void {
    this.cache.clear();
  }

  private async getWindow(windowIndex: number): Promise<Uint8Array> {
    const cached = this.cache.get(windowIndex);
    if (cached !== undefined) {
      this.hits += 1;
      // Refresh recency: Map preserves insertion order, oldest entry stays first.
      this.cache.delete(windowIndex);
      this.cache.set(windowIndex, cached);
      return cached;
    }

    this.misses += 1;

    const pending = this.inFlight.get(windowIndex);
    if (pending !== undefined) {
      return pending;
    }

    const winStart = windowIndex * this.windowSize;
    const winEnd = Math.min(winStart + this.windowSize, this.size);
    this.sourceReads += 1;

    const loadPromise = this.source
      .read(winStart, winEnd)
      .then((data) => {
        const expectedLength = winEnd - winStart;
        if (data.byteLength !== expectedLength) {
          throw new RangeError(
            `CachedByteSource underlying short read: expected ${String(expectedLength)} bytes, got ${String(data.byteLength)}`,
          );
        }
        this.bytesReadFromSource += data.byteLength;
        this.insertWindow(windowIndex, data);
        return data;
      })
      .finally(() => {
        this.inFlight.delete(windowIndex);
      });

    this.inFlight.set(windowIndex, loadPromise);
    return loadPromise;
  }

  private insertWindow(windowIndex: number, data: Uint8Array): void {
    if (this.cache.has(windowIndex)) {
      this.cache.delete(windowIndex);
      this.cache.set(windowIndex, data);
      return;
    }

    if (this.cache.size >= this.maxWindows) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
        this.evictions += 1;
      }
    }

    this.cache.set(windowIndex, data);
  }
}
