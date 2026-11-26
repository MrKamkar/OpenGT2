import { GtdbError, type GtdbTableSlice } from './types';

/**
 * Validates that a single fixed-size record at `byteOffset` fits within `view`.
 */
export function assertRecordBounds(
  view: DataView,
  byteOffset: number,
  recordSize: number,
  structName: string,
): void {
  if (!Number.isInteger(byteOffset) || byteOffset < 0) {
    throw new GtdbError(
      GtdbError.OutOfBounds,
      `${structName} byteOffset (${String(byteOffset)}) must be a non-negative integer.`,
    );
  }
  if (byteOffset + recordSize > view.byteLength) {
    throw new GtdbError(
      GtdbError.TruncatedBuffer,
      `${structName} record at offset ${String(byteOffset)} requires ${String(recordSize)} bytes, but DataView has ${String(view.byteLength)} bytes.`,
    );
  }
}

/**
 * Copies a contiguous slice of raw bytes out of a `DataView`, accounting for `view.byteOffset`.
 */
export function copyDataViewBytes(
  view: DataView,
  byteOffset: number,
  fieldOffset: number,
  length: number,
): Uint8Array {
  return new Uint8Array(view.buffer, view.byteOffset + byteOffset + fieldOffset, length).slice();
}

/**
 * Validates a `GtdbTableSlice` against `expectedElementSize` and `bytes.byteLength`,
 * then decodes all records sequentially using little-endian `DataView`.
 */
export function decodeFixedTable<T>(
  bytes: Uint8Array,
  slice: GtdbTableSlice,
  expectedElementSize: number,
  structName: string,
  decodeRecord: (view: DataView, byteOffset: number) => T,
): T[] {
  if (slice.elementSize !== expectedElementSize) {
    throw new GtdbError(
      GtdbError.InvalidLayout,
      `${structName} table "${slice.name}" elementSize (${String(slice.elementSize)}) does not match expected ${String(expectedElementSize)} bytes.`,
    );
  }
  if (
    !Number.isInteger(slice.offset) ||
    slice.offset < 0 ||
    !Number.isInteger(slice.size) ||
    slice.size < 0
  ) {
    throw new GtdbError(
      GtdbError.OutOfBounds,
      `${structName} table "${slice.name}" has invalid range [${String(slice.offset)}, size=${String(slice.size)}).`,
    );
  }
  if (slice.size % expectedElementSize !== 0) {
    throw new GtdbError(
      GtdbError.MisalignedTableSize,
      `${structName} table "${slice.name}" size (${String(slice.size)} B) is not divisible by ${String(expectedElementSize)} B.`,
    );
  }
  if (slice.offset + slice.size > bytes.byteLength) {
    throw new GtdbError(
      GtdbError.TruncatedBuffer,
      `${structName} table "${slice.name}" range [${String(slice.offset)}, ${String(slice.offset + slice.size)}) exceeds buffer length (${String(bytes.byteLength)} B).`,
    );
  }

  const recordCount = slice.size / expectedElementSize;
  if (slice.count !== null && slice.count !== recordCount) {
    throw new GtdbError(
      GtdbError.InvalidLayout,
      `${structName} table "${slice.name}" count (${String(slice.count)}) does not match size / elementSize (${String(recordCount)}).`,
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset + slice.offset, slice.size);
  const records: T[] = [];
  for (let i = 0; i < recordCount; i += 1) {
    records.push(decodeRecord(view, i * expectedElementSize));
  }
  return records;
}
