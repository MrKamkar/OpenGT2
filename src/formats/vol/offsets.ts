/**
 * Reimplemented from the GT2.VOL specification documented in:
 * adeyblue/GTVolTools (`GT2VolFile.cs`), https://github.com/adeyblue/GTVolTools (MIT License).
 */

import { type ByteSource } from '../../io';
import {
  VOL_OFFSET_ADDRESS_MASK,
  VOL_OFFSET_TABLE_START,
  VOL_OFFSET_TAIL_MASK,
  VolError,
} from './types';

/**
 * Decoded sector-aligned address and final-sector padding tail from a mangled offset word.
 */
export interface SplitOffset {
  /** @evidence E2 — Sector-aligned byte offset (`raw & 0xFFFFF800`, unsigned). */
  readonly address: number;
  /** @evidence E2 — Unused trailing bytes in the final 0x800 sector (`raw & 0x7FF`). */
  readonly tail: number;
}

/**
 * Splits a raw 32-bit GT2.VOL mangled offset word into sector-aligned `address` and `tail`.
 */
export function splitOffset(raw: number): SplitOffset {
  // @evidence E2 — Unsigned right shift avoids JS signed 32-bit negative numbers when bit 31 is set.
  const address = (raw & VOL_OFFSET_ADDRESS_MASK) >>> 0;
  const tail = (raw & VOL_OFFSET_TAIL_MASK) >>> 0;
  return { address, tail };
}

/**
 * Reads `uint32[files]` starting at `0x10` via `ByteSource` and appends the virtual final offset
 * equal to `source.size` (`offsets[files] = source.size`).
 */
export async function parseVolOffsets(
  source: ByteSource,
  files: number,
): Promise<readonly number[]> {
  if (!Number.isInteger(files) || files < 2) {
    throw new VolError(
      VolError.InvalidOffsetCount,
      `GT2.VOL offset table requires integer files >= 2, got ${String(files)}`,
    );
  }

  const tableByteLength = files * 4;
  const tableEnd = VOL_OFFSET_TABLE_START + tableByteLength;
  if (tableEnd > source.size) {
    throw new VolError(
      VolError.TruncatedOffsetTable,
      `Offset table [${String(VOL_OFFSET_TABLE_START)}, ${String(tableEnd)}) exceeds archive size ${String(source.size)}`,
    );
  }

  const bytes = await source.read(VOL_OFFSET_TABLE_START, tableEnd);
  if (bytes.byteLength < tableByteLength) {
    throw new VolError(
      VolError.TruncatedOffsetTable,
      `Expected ${String(tableByteLength)} offset table bytes, read ${String(bytes.byteLength)}`,
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offsets = new Array<number>(files + 1);
  // @evidence E2 — Offset table entries are little-endian uint32.
  for (let i = 0; i < files; i += 1) {
    offsets[i] = view.getUint32(i * 4, true);
  }
  // @evidence E2 — Append virtual EOF offset for last-file size calculation (Appendix A.2 / A.6).
  offsets[files] = source.size;

  return offsets;
}
