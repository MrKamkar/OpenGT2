/**
 * Random-access binary data source contract (§4.2).
 * All offsets are JS safe integers (`number`, exact up to 2^53 - 1).
 */
export interface ByteSource {
  readonly size: number;
  /** Reads [start, end) without copying the entire source. Throws RangeError out of bounds. */
  read(start: number, end: number): Promise<Uint8Array>;
  /** Sub-view [start, end) as a new ByteSource (zero copy). */
  slice(start: number, end: number): ByteSource;
}

/**
 * Validates that a ByteSource size is a non-negative safe integer.
 */
export function validateByteSize(size: number, label = 'size'): void {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer, got ${String(size)}`);
  }
}

/**
 * Validates a half-open byte range [start, end) against [0, size].
 * Empty ranges (start === end) are valid when 0 <= start <= size.
 */
export function validateByteRange(start: number, end: number, size: number): void {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    throw new RangeError(
      `Byte range [${String(start)}, ${String(end)}) must use safe integer offsets`,
    );
  }
  if (start < 0 || end < 0) {
    throw new RangeError(
      `Byte range [${String(start)}, ${String(end)}) cannot contain negative offsets`,
    );
  }
  if (start > end) {
    throw new RangeError(
      `Byte range start (${String(start)}) cannot exceed end (${String(end)})`,
    );
  }
  if (end > size) {
    throw new RangeError(
      `Byte range [${String(start)}, ${String(end)}) exceeds source size (${String(size)})`,
    );
  }
}

/**
 * Zero-copy sub-view over any ByteSource implementation.
 */
export class SlicedByteSource implements ByteSource {
  readonly size: number;
  private readonly parent: ByteSource;
  private readonly baseOffset: number;

  constructor(parent: ByteSource, start: number, end: number) {
    validateByteRange(start, end, parent.size);
    this.parent = parent;
    this.baseOffset = start;
    this.size = end - start;
  }

  async read(start: number, end: number): Promise<Uint8Array> {
    validateByteRange(start, end, this.size);
    if (start === end) {
      return new Uint8Array(0);
    }
    return this.parent.read(this.baseOffset + start, this.baseOffset + end);
  }

  slice(start: number, end: number): ByteSource {
    validateByteRange(start, end, this.size);
    return new SlicedByteSource(this.parent, this.baseOffset + start, this.baseOffset + end);
  }
}
