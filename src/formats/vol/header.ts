/**
 * Reimplemented from the GT2.VOL specification documented in:
 * adeyblue/GTVolTools (`GT2VolFile.cs`), https://github.com/adeyblue/GTVolTools (MIT License).
 */

import { type ByteSource } from '../../io';
import { VOL_HEADER_SIZE, VOL_MAGIC_BYTES, VolError } from './types';

/**
 * Parsed 16-byte GT2.VOL header (`0x00..0x0F`).
 */
export interface VolHeader {
  /** @evidence E2 — Offset `0x08` (`int16` LE): number of entries in the offset table. */
  readonly files: number;
  /** @evidence E2 — Offset `0x0A` (`int16` LE): total number of 32-byte TOC entries. */
  readonly totalEntries: number;
  /**
   * @evidence E0 — Offset `0x0C` (4 bytes): unused in reference parser; preserved for inspection only
   * and never affects parser behavior.
   */
  readonly unk_0x0C: number;
}

/**
 * Reads and validates only the 16-byte GT2.VOL header via `ByteSource`.
 * Throws `VolError` (`TruncatedHeader`, `BadMagic`, or `InvalidHeaderCounts`) on invalid input.
 */
export async function parseVolHeader(source: ByteSource): Promise<VolHeader> {
  if (source.size < VOL_HEADER_SIZE) {
    throw new VolError(
      VolError.TruncatedHeader,
      `GT2.VOL header requires at least ${String(VOL_HEADER_SIZE)} bytes, got ${String(source.size)}`,
    );
  }

  const bytes = await source.read(0, VOL_HEADER_SIZE);
  if (bytes.byteLength < VOL_HEADER_SIZE) {
    throw new VolError(
      VolError.TruncatedHeader,
      `Expected ${String(VOL_HEADER_SIZE)} header bytes, read ${String(bytes.byteLength)}`,
    );
  }

  for (let i = 0; i < VOL_MAGIC_BYTES.length; i += 1) {
    if (bytes[i] !== VOL_MAGIC_BYTES[i]) {
      throw new VolError(VolError.BadMagic, 'Invalid GT2.VOL magic header (expected "GTFS\\0\\0\\0\\0")');
    }
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // @evidence E2 — Header counts at 0x08 and 0x0A are little-endian int16.
  const files = view.getInt16(0x08, true);
  const totalEntries = view.getInt16(0x0a, true);
  // @evidence E0 — 4 bytes at 0x0C are unread by GTVolTools; decoded for diagnostics only.
  const unk_0x0C = view.getUint32(0x0c, true);

  if (files <= 0 || totalEntries <= 0 || totalEntries <= files) {
    throw new VolError(
      VolError.InvalidHeaderCounts,
      `Invalid GT2.VOL header counts: files=${String(files)}, totalEntries=${String(totalEntries)}`,
    );
  }

  return {
    files,
    totalEntries,
    unk_0x0C,
  };
}
