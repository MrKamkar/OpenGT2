/**
 * Pure fixed-row-height list virtualization math (M2.8).
 * Only rows in `[start, end)` are rendered; everything else is represented by a spacer height.
 */

export interface VirtualRangeInput {
  readonly scrollTop: number;
  readonly viewportHeight: number;
  readonly rowHeight: number;
  readonly rowCount: number;
  readonly overscan: number;
}

export interface VirtualRange {
  /** First rendered row index (inclusive). */
  readonly start: number;
  /** Last rendered row index (exclusive). */
  readonly end: number;
  /** Pixel offset of row `start` from the top of the scroll content. */
  readonly offsetTop: number;
  /** Total pixel height of all rows. */
  readonly totalHeight: number;
}

export const EMPTY_VIRTUAL_RANGE: VirtualRange = Object.freeze({
  start: 0,
  end: 0,
  offsetTop: 0,
  totalHeight: 0,
});

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer, got ${String(value)}`);
  }
}

export function computeVirtualRange(input: VirtualRangeInput): VirtualRange {
  const { rowHeight, rowCount, overscan } = input;
  if (!Number.isFinite(rowHeight) || rowHeight <= 0) {
    throw new RangeError(`rowHeight must be a positive finite number, got ${String(rowHeight)}`);
  }
  assertNonNegativeInteger('rowCount', rowCount);
  assertNonNegativeInteger('overscan', overscan);

  if (rowCount === 0) {
    return EMPTY_VIRTUAL_RANGE;
  }

  const totalHeight = rowCount * rowHeight;
  const viewportHeight =
    Number.isFinite(input.viewportHeight) && input.viewportHeight > 0 ? input.viewportHeight : 0;
  const maxScrollTop = Math.max(0, totalHeight - viewportHeight);
  const rawScrollTop = Number.isFinite(input.scrollTop) ? input.scrollTop : 0;
  const scrollTop = Math.min(Math.max(0, rawScrollTop), maxScrollTop);

  const firstVisible = Math.min(rowCount - 1, Math.floor(scrollTop / rowHeight));
  const lastVisibleExclusive = Math.min(
    rowCount,
    Math.max(firstVisible + 1, Math.ceil((scrollTop + viewportHeight) / rowHeight)),
  );

  const start = Math.max(0, firstVisible - overscan);
  const end = Math.min(rowCount, lastVisibleExclusive + overscan);

  return {
    start,
    end,
    offsetTop: start * rowHeight,
    totalHeight,
  };
}

/** Scroll position that brings `index` into view (minimal movement), or the current one if already visible. */
export function scrollTopToReveal(
  index: number,
  currentScrollTop: number,
  viewportHeight: number,
  rowHeight: number,
): number {
  const rowTop = index * rowHeight;
  const rowBottom = rowTop + rowHeight;
  if (rowTop < currentScrollTop) {
    return rowTop;
  }
  if (rowBottom > currentScrollTop + viewportHeight) {
    return Math.max(0, rowBottom - viewportHeight);
  }
  return currentScrollTop;
}
