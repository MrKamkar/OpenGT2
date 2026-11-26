import { describe, expect, it } from 'vitest';
import {
  type ThumbnailCacheValue,
  ThumbnailLruCache,
  computeVirtualGridRange,
} from '../../src/ui/imageViewer';

function makeThumb(sizeBytes: number, width = 8): ThumbnailCacheValue {
  return {
    supported: true,
    width,
    height: Math.max(1, Math.floor(sizeBytes / (width * 4))),
    nativeWidth: width,
    nativeHeight: Math.max(1, Math.floor(sizeBytes / (width * 4))),
    bpp: 4,
    formatLabel: 'PS1 TIM',
    entryCount: 1,
    rgba: new Uint8ClampedArray(sizeBytes),
  };
}

describe('ThumbnailLruCache (M4.7)', () => {
  it('evicts least-recently-used entries when maxEntries is exceeded and refreshes recency on get()', () => {
    const cache = new ThumbnailLruCache({ maxEntries: 3, maxBytes: 1024 });
    cache.set('a', makeThumb(64));
    cache.set('b', makeThumb(64));
    cache.set('c', makeThumb(64));

    // Refresh 'a' so 'b' becomes LRU
    expect(cache.get('a')?.supported).toBe(true);
    expect(cache.get('missing')).toBeUndefined();

    cache.set('d', makeThumb(64));

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('c')).toBeDefined();
    expect(cache.get('d')).toBeDefined();
    expect(cache.getStats().evictions).toBe(1);
    expect(cache.getStats().hits).toBe(4);
    expect(cache.getStats().misses).toBe(2);
  });

  it('evicts entries to stay within maxBytes budget and rejects oversized items', () => {
    const cache = new ThumbnailLruCache({ maxEntries: 10, maxBytes: 256 });
    expect(cache.set('1', makeThumb(100))).toBe(true);
    expect(cache.set('2', makeThumb(100))).toBe(true);
    expect(cache.getStats().bytes).toBe(200);

    // Adding 120 bytes requires evicting '1'
    expect(cache.set('3', makeThumb(120))).toBe(true);
    expect(cache.get('1')).toBeUndefined();
    expect(cache.getStats().bytes).toBe(220);

    // Item larger than maxBytes is rejected without wiping existing cache
    expect(cache.set('huge', makeThumb(512))).toBe(false);
    expect(cache.get('2')).toBeDefined();
    expect(cache.get('3')).toBeDefined();

    cache.clear();
    expect(cache.getStats().entries).toBe(0);
    expect(cache.getStats().bytes).toBe(0);
  });
});

describe('computeVirtualGridRange (M4.7)', () => {
  it('computes bounded visible index window for directories with > 3,000 items', () => {
    const rangeTop = computeVirtualGridRange({
      scrollTop: 0,
      viewportHeight: 400,
      viewportWidth: 640,
      itemCount: 3600,
      cardWidth: 152,
      rowHeight: 176,
      gap: 10,
      overscanRows: 1,
    });

    expect(rangeTop.columns).toBe(4);
    expect(rangeTop.totalRows).toBe(900);
    expect(rangeTop.startIndex).toBe(0);
    expect(rangeTop.endIndex).toBeLessThanOrEqual(20);

    const rangeMid = computeVirtualGridRange({
      scrollTop: 186 * 500,
      viewportHeight: 400,
      viewportWidth: 640,
      itemCount: 3600,
      cardWidth: 152,
      rowHeight: 176,
      gap: 10,
      overscanRows: 1,
    });

    expect(rangeMid.startIndex).toBe(499 * 4);
    expect(rangeMid.endIndex - rangeMid.startIndex).toBeLessThanOrEqual(24);
    expect(rangeMid.offsetTop).toBe(499 * 186);
  });

  it('handles empty directories cleanly', () => {
    const empty = computeVirtualGridRange({
      scrollTop: 0,
      viewportHeight: 400,
      viewportWidth: 640,
      itemCount: 0,
      cardWidth: 152,
      rowHeight: 176,
      gap: 10,
      overscanRows: 1,
    });
    expect(empty.startIndex).toBe(0);
    expect(empty.endIndex).toBe(0);
    expect(empty.totalHeight).toBe(0);
  });
});
