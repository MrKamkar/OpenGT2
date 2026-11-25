/**
 * Reimplemented from the GT2.VOL specification documented in:
 * adeyblue/GTVolTools (`GT2VolFile.cs`), https://github.com/adeyblue/GTVolTools (MIT License).
 */

import { type ByteSource } from '../../io';
import { splitOffset } from './offsets';
import {
  VOL_FLAG_DIRECTORY,
  VOL_FLAG_LAST_ENTRY,
  VOL_TOC_ENTRY_SIZE,
  VOL_TOC_NAME_LENGTH,
  VolError,
} from './types';

/**
 * Computed byte boundaries of the GT2.VOL Table of Contents (Appendix A.4).
 */
export interface VolTocBounds {
  /** @evidence E2 — Sector-aligned start offset of the TOC (`splitOffset(offsets[1]).address`). */
  readonly tocAddress: number;
  /** @evidence E2 — Trailing padding bytes in the last TOC sector (`splitOffset(offsets[1]).tail`). */
  readonly tocTail: number;
  /** @evidence E2 — Start offset of the first file (or archive end if `files === 2`). */
  readonly firstFileAddress: number;
  /** @evidence E2 — Exact byte length of the TOC (`firstFileAddress - tocAddress - tocTail`). */
  readonly tocLength: number;
}

/**
 * Raw decoded 32-byte TOC record before directory path reconstruction (Appendix A.3).
 */
export interface RawTocEntry {
  /** @evidence E2 — `int32` LE Unix timestamp in UTC seconds (offset `0x00`). */
  readonly unixTime: number;
  /** @evidence E2 — `int16` LE index into the offset table (`0` for `..` entries, offset `0x04`). */
  readonly offsetIndex: number;
  /**
   * @evidence E2 — Raw `uint8` flags byte (offset `0x06`).
   * Bits `0x01` (directory) and `0x80` (last entry in directory) are E2; bits `0x02..0x7E` are E0.
   */
  readonly flags: number;
  /** @evidence E2 — `(flags & 0x01) !== 0`. */
  readonly isDirectory: boolean;
  /** @evidence E2 — `(flags & 0x80) !== 0`. */
  readonly isLastInDirectory: boolean;
  /** @evidence E2 — Zero-padded 25-byte ASCII name (`0x07..0x1F`). */
  readonly name: string;
}

function decodeAsciiZeroPadded(bytes: Uint8Array, offset: number, maxLength: number): string {
  let length = 0;
  while (length < maxLength) {
    const code = bytes[offset + length];
    if (code === undefined || code === 0) {
      break;
    }
    length += 1;
  }

  let result = '';
  for (let i = 0; i < length; i += 1) {
    const code = bytes[offset + i];
    if (code !== undefined) {
      result += String.fromCharCode(code);
    }
  }
  return result;
}

/**
 * Computes and validates TOC boundaries according to Appendix A.4.
 * Enforces `tocLength >= totalEntries * 32` and archive size bounds.
 */
export function computeTocBounds(
  offsets: readonly number[],
  totalEntries: number,
  volSize: number,
): VolTocBounds {
  const tocRaw = offsets[1];
  const nextRaw = offsets[2];
  if (
    offsets.length < 3 ||
    tocRaw === undefined ||
    nextRaw === undefined ||
    !Number.isInteger(totalEntries) ||
    totalEntries <= 0
  ) {
    throw new VolError(
      VolError.InvalidTocBounds,
      `Cannot compute TOC bounds with offsets.length=${String(offsets.length)} and totalEntries=${String(totalEntries)}`,
    );
  }

  const { address: tocAddress, tail: tocTail } = splitOffset(tocRaw);
  // If files === 2, offsets[2] is the appended virtual EOF size rather than a mangled offset word.
  const firstFileAddress = offsets.length === 3 ? nextRaw : splitOffset(nextRaw).address;
  // @evidence E2 — Appendix A.4: tocLength = firstFile - tocAddress - tocTail.
  const tocLength = firstFileAddress - tocAddress - tocTail;
  const requiredLength = totalEntries * VOL_TOC_ENTRY_SIZE;

  if (tocAddress < 0 || tocLength < 0 || tocLength < requiredLength) {
    throw new VolError(
      VolError.InvalidTocBounds,
      `Invalid TOC bounds: tocAddress=${String(tocAddress)}, tocLength=${String(tocLength)}, required=${String(requiredLength)}`,
    );
  }

  if (tocAddress + tocLength > volSize) {
    throw new VolError(
      VolError.TruncatedToc,
      `TOC range [${String(tocAddress)}, ${String(tocAddress + tocLength)}) exceeds archive size ${String(volSize)}`,
    );
  }

  return {
    tocAddress,
    tocTail,
    firstFileAddress,
    tocLength,
  };
}

/**
 * Reads only the TOC byte range via `ByteSource` and parses `totalEntries` 32-byte records.
 */
export async function parseVolToc(
  source: ByteSource,
  offsets: readonly number[],
  totalEntries: number,
): Promise<readonly RawTocEntry[]> {
  const bounds = computeTocBounds(offsets, totalEntries, source.size);
  const bytes = await source.read(bounds.tocAddress, bounds.tocAddress + bounds.tocLength);
  if (bytes.byteLength < bounds.tocLength) {
    throw new VolError(
      VolError.TruncatedToc,
      `Expected ${String(bounds.tocLength)} TOC bytes, read ${String(bytes.byteLength)}`,
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = new Array<RawTocEntry>(totalEntries);

  for (let i = 0; i < totalEntries; i += 1) {
    const base = i * VOL_TOC_ENTRY_SIZE;
    // @evidence E2 — All multi-byte TOC fields are little-endian.
    const unixTime = view.getInt32(base + 0x00, true);
    const offsetIndex = view.getInt16(base + 0x04, true);
    // @evidence E0 — Bits 0x02..0x7E are unverified and ignored when interpreting entry kind/end.
    const flags = view.getUint8(base + 0x06);
    const isDirectory = (flags & VOL_FLAG_DIRECTORY) !== 0;
    const isLastInDirectory = (flags & VOL_FLAG_LAST_ENTRY) !== 0;
    const name = decodeAsciiZeroPadded(bytes, base + 0x07, VOL_TOC_NAME_LENGTH);

    entries[i] = {
      unixTime,
      offsetIndex,
      flags,
      isDirectory,
      isLastInDirectory,
      name,
    };
  }

  return entries;
}
