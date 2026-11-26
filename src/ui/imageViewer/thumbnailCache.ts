export const DEFAULT_THUMBNAIL_MAX_ENTRIES = 96;
export const DEFAULT_THUMBNAIL_MAX_BYTES = 6 * 1024 * 1024;

export type ThumbnailCacheValue =
  | {
      readonly supported: true;
      readonly width: number;
      readonly height: number;
      readonly nativeWidth: number;
      readonly nativeHeight: number;
      readonly bpp: 4 | 8 | 16 | 24;
      readonly formatLabel: string;
      readonly entryCount: number;
      readonly rgba: Uint8ClampedArray;
    }
  | {
      readonly supported: false;
      readonly reason: string;
    };

export interface ThumbnailLruCacheOptions {
  readonly maxEntries?: number;
  readonly maxBytes?: number;
}

export interface ThumbnailLruStats {
  readonly entries: number;
  readonly bytes: number;
  readonly maxEntries: number;
  readonly maxBytes: number;
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
}

function byteSizeOf(value: ThumbnailCacheValue): number {
  return value.supported ? value.rgba.byteLength : 0;
}

/**
 * Bounded LRU cache for decoded thumbnail RGBA buffers (M4.7).
 * Enforces both `maxEntries` and `maxBytes` caps so fast scrolling through thousands of
 * files keeps browser memory flat.
 */
export class ThumbnailLruCache {
  readonly maxEntries: number;
  readonly maxBytes: number;

  private readonly map = new Map<string, ThumbnailCacheValue>();
  private totalBytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(options: ThumbnailLruCacheOptions = {}) {
    const maxEntries = options.maxEntries ?? DEFAULT_THUMBNAIL_MAX_ENTRIES;
    const maxBytes = options.maxBytes ?? DEFAULT_THUMBNAIL_MAX_BYTES;
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError(`maxEntries must be a positive safe integer, got ${String(maxEntries)}`);
    }
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
      throw new RangeError(`maxBytes must be a positive safe integer, got ${String(maxBytes)}`);
    }
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
  }

  get(key: string): ThumbnailCacheValue | undefined {
    const existing = this.map.get(key);
    if (existing === undefined) {
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    // Refresh recency
    this.map.delete(key);
    this.map.set(key, existing);
    return existing;
  }

  set(key: string, value: ThumbnailCacheValue): boolean {
    const size = byteSizeOf(value);
    if (size > this.maxBytes) {
      return false;
    }

    const previous = this.map.get(key);
    if (previous !== undefined) {
      this.totalBytes -= byteSizeOf(previous);
      this.map.delete(key);
    }

    while (
      this.map.size > 0 &&
      (this.map.size >= this.maxEntries || this.totalBytes + size > this.maxBytes)
    ) {
      const oldestKey = this.map.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      const oldestVal = this.map.get(oldestKey);
      this.map.delete(oldestKey);
      if (oldestVal !== undefined) {
        this.totalBytes -= byteSizeOf(oldestVal);
      }
      this.evictions += 1;
    }

    this.map.set(key, value);
    this.totalBytes += size;
    return true;
  }

  clear(): void {
    this.map.clear();
    this.totalBytes = 0;
  }

  getStats(): ThumbnailLruStats {
    return {
      entries: this.map.size,
      bytes: this.totalBytes,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }
}

export interface VirtualGridParams {
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly viewportWidth: number;
  readonly itemCount: number;
  readonly cardWidth: number;
  readonly rowHeight: number;
  readonly gap: number;
  readonly overscanRows: number;
}

export interface VirtualGridRange {
  readonly columns: number;
  readonly totalRows: number;
  readonly totalHeight: number;
  readonly offsetTop: number;
  readonly startIndex: number;
  readonly endIndex: number;
}

/**
 * Pure virtualized grid window calculation for large image directories (M4.7).
 */
export function computeVirtualGridRange(params: VirtualGridParams): VirtualGridRange {
  const safeCount = Math.max(0, Math.trunc(params.itemCount));
  const safeWidth = Math.max(params.cardWidth, Math.trunc(params.viewportWidth));
  const columns = Math.max(
    1,
    Math.floor((safeWidth + params.gap) / (params.cardWidth + params.gap)),
  );
  const totalRows = Math.ceil(safeCount / columns);
  const strideY = params.rowHeight + params.gap;
  const totalHeight = totalRows > 0 ? totalRows * strideY - params.gap : 0;

  if (safeCount === 0) {
    return {
      columns,
      totalRows: 0,
      totalHeight: 0,
      offsetTop: 0,
      startIndex: 0,
      endIndex: 0,
    };
  }

  const safeScrollTop = Math.max(0, params.scrollTop);
  const safeViewportH = Math.max(1, params.viewportHeight);
  const overscan = Math.max(0, Math.trunc(params.overscanRows));

  const visibleFirstRow = Math.floor(safeScrollTop / strideY);
  const visibleLastRow = Math.ceil((safeScrollTop + safeViewportH) / strideY);

  const firstRow = Math.max(0, visibleFirstRow - overscan);
  const lastRowExclusive = Math.min(totalRows, visibleLastRow + overscan);

  const startIndex = Math.min(safeCount, firstRow * columns);
  const endIndex = Math.min(safeCount, lastRowExclusive * columns);

  return {
    columns,
    totalRows,
    totalHeight,
    offsetTop: firstRow * strideY,
    startIndex,
    endIndex,
  };
}
