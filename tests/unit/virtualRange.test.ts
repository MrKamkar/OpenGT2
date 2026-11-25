import { describe, expect, it } from 'vitest';
import {
  EMPTY_VIRTUAL_RANGE,
  computeVirtualRange,
  scrollTopToReveal,
} from '../../src/ui/explorer/virtualRange';

describe('virtualRange (M2.8)', () => {
  it('returns EMPTY_VIRTUAL_RANGE when rowCount is 0', () => {
    expect(
      computeVirtualRange({
        scrollTop: 500,
        viewportHeight: 392,
        rowHeight: 28,
        rowCount: 0,
        overscan: 8,
      }),
    ).toEqual(EMPTY_VIRTUAL_RANGE);
  });

  it('computes bounded visible windows for 11,578 rows at top, middle, and bottom', () => {
    const rowCount = 11_578;
    const rowHeight = 28;
    const viewportHeight = 392; // 14 visible rows
    const overscan = 8;

    const top = computeVirtualRange({
      scrollTop: 0,
      viewportHeight,
      rowHeight,
      rowCount,
      overscan,
    });
    expect(top.totalHeight).toBe(rowCount * rowHeight);
    expect(top.start).toBe(0);
    expect(top.end).toBe(14 + overscan);
    expect(top.offsetTop).toBe(0);
    expect(top.end - top.start).toBeLessThanOrEqual(32);

    const middleScroll = 5000 * rowHeight + 10;
    const middle = computeVirtualRange({
      scrollTop: middleScroll,
      viewportHeight,
      rowHeight,
      rowCount,
      overscan,
    });
    expect(middle.start).toBe(5000 - overscan);
    expect(middle.end).toBe(5015 + overscan);
    expect(middle.offsetTop).toBe(middle.start * rowHeight);
    expect(middle.end - middle.start).toBeLessThanOrEqual(32);

    const bottom = computeVirtualRange({
      scrollTop: rowCount * rowHeight + 9999,
      viewportHeight,
      rowHeight,
      rowCount,
      overscan,
    });
    expect(bottom.end).toBe(rowCount);
    expect(bottom.start).toBe(rowCount - 14 - overscan);
    expect(bottom.offsetTop).toBe(bottom.start * rowHeight);
  });

  it('clamps non-finite, negative, and zero viewportHeight inputs safely', () => {
    const range = computeVirtualRange({
      scrollTop: Number.NaN,
      viewportHeight: 0,
      rowHeight: 28,
      rowCount: 100,
      overscan: 4,
    });
    expect(range.start).toBe(0);
    expect(range.end).toBe(5);
    expect(range.offsetTop).toBe(0);

    const negScroll = computeVirtualRange({
      scrollTop: -200,
      viewportHeight: 140,
      rowHeight: 28,
      rowCount: 10,
      overscan: 0,
    });
    expect(negScroll.start).toBe(0);
    expect(negScroll.end).toBe(5);
  });

  it('rejects invalid rowHeight, rowCount, and overscan values with RangeError', () => {
    expect(() =>
      computeVirtualRange({ scrollTop: 0, viewportHeight: 100, rowHeight: 0, rowCount: 10, overscan: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      computeVirtualRange({ scrollTop: 0, viewportHeight: 100, rowHeight: -1, rowCount: 10, overscan: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      computeVirtualRange({ scrollTop: 0, viewportHeight: 100, rowHeight: 28, rowCount: -1, overscan: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      computeVirtualRange({ scrollTop: 0, viewportHeight: 100, rowHeight: 28, rowCount: 10, overscan: -2 }),
    ).toThrow(RangeError);
  });

  it('calculates minimal scrollTopToReveal movement', () => {
    expect(scrollTopToReveal(2, 100, 140, 28)).toBe(56); // above viewport
    expect(scrollTopToReveal(4, 100, 140, 28)).toBe(100); // already visible
    expect(scrollTopToReveal(10, 100, 140, 28)).toBe(308 - 140); // below viewport
  });
});
