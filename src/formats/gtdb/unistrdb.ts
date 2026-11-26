/**
 * GT2 wide-string database (`WSDB` / `unistrdb`) decoder reimplemented from:
 * adeyblue/GTVolTools (`GT2DataExploder/main.cpp:ExtractUniStrDb`),
 * https://github.com/adeyblue/GTVolTools (MIT License).
 */

import { GtdbError } from './types';

/** @evidence E3 — 4-byte ASCII magic `"WSDB"` (`57 53 44 42`) at offset `0x04` across 7/7 `unistrdb` files in `GT2.VOL`. */
export const WSDB_MAGIC_BYTES = [0x57, 0x53, 0x44, 0x42] as const;

/** @evidence E3 — Little-endian 32-bit representation of `"WSDB"`. */
export const WSDB_MAGIC_LE = 0x42445357;

/** @evidence E3 — Byte offset of `"WSDB"` magic inside an unpacked `unistrdb` buffer. */
export const WSDB_MAGIC_OFFSET = 4;

/** @evidence E3 — Fixed header size (`uint32 fileSize` + `char[4] "WSDB"` + `uint16 numStrings`). */
export const WSDB_HEADER_SIZE = 10;

/**
 * Decoded `WSDB` (`unistrdb`) string table indexed by integer string ID.
 */
export interface UnistrdbTable {
  /** @evidence E3 — `0x00` `uint32` LE: declared unpacked file byte length. */
  readonly fileSize: number;
  /** @evidence E3 — `0x08` `uint16` LE: number of string records (`strings.length`). */
  readonly count: number;
  /** @evidence E3 — Sequential UTF-16LE strings decoded from `0x0A..EOF`. */
  readonly strings: readonly string[];
}

/**
 * Checks whether a buffer carries the `"WSDB"` signature at offset `0x04`.
 */
export function isWsdbMagic(bytes: Uint8Array): boolean {
  if (bytes.byteLength < WSDB_MAGIC_OFFSET + WSDB_MAGIC_BYTES.length) {
    return false;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(WSDB_MAGIC_OFFSET, true) === WSDB_MAGIC_LE;
}

/**
 * Parses a decompressed `(<region>_)unistrdb.dat` (`WSDB`) buffer into an indexed string table.
 * Enforces `fileSize`, `"WSDB"` magic, per-record bounds, `0x0000` UTF-16 terminators, and exact EOF.
 */
export function parseUnistrdb(bytes: Uint8Array): UnistrdbTable {
  if (bytes.byteLength < WSDB_HEADER_SIZE) {
    throw new GtdbError(
      GtdbError.TruncatedBuffer,
      `WSDB buffer truncated: expected at least ${String(WSDB_HEADER_SIZE)} bytes, got ${String(bytes.byteLength)}.`,
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.getUint32(WSDB_MAGIC_OFFSET, true);
  if (magic !== WSDB_MAGIC_LE) {
    throw new GtdbError(
      GtdbError.InvalidHeader,
      `Invalid WSDB magic at 0x04: expected "WSDB" (0x${WSDB_MAGIC_LE.toString(16)}), got 0x${magic.toString(16)}.`,
    );
  }

  const fileSize = view.getUint32(0, true);
  if (fileSize > bytes.byteLength) {
    throw new GtdbError(
      GtdbError.TruncatedBuffer,
      `WSDB header declares ${String(fileSize)} bytes, but buffer has ${String(bytes.byteLength)} bytes.`,
    );
  }
  if (fileSize < bytes.byteLength) {
    throw new GtdbError(
      GtdbError.InvalidLayout,
      `WSDB header fileSize (${String(fileSize)}) does not match buffer length (${String(bytes.byteLength)}).`,
    );
  }

  const count = view.getUint16(8, true);
  const strings: string[] = [];
  let cursor = WSDB_HEADER_SIZE;

  for (let i = 0; i < count; i += 1) {
    if (cursor + 2 > bytes.byteLength) {
      throw new GtdbError(
        GtdbError.TruncatedBuffer,
        `WSDB record [${String(i)}] truncated before character count at offset ${String(cursor)}.`,
      );
    }

    const charCount = view.getUint16(cursor, true);
    cursor += 2;

    const payloadBytes = charCount * 2;
    if (cursor + payloadBytes + 2 > bytes.byteLength) {
      throw new GtdbError(
        GtdbError.TruncatedBuffer,
        `WSDB record [${String(i)}] (${String(charCount)} UTF-16 code units) exceeds buffer length (${String(bytes.byteLength)}).`,
      );
    }

    let value = '';
    for (let c = 0; c < charCount; c += 1) {
      value += String.fromCharCode(view.getUint16(cursor + c * 2, true));
    }
    cursor += payloadBytes;

    const terminator = view.getUint16(cursor, true);
    cursor += 2;
    if (terminator !== 0) {
      throw new GtdbError(
        GtdbError.InvalidLayout,
        `WSDB record [${String(i)}] missing 0x0000 UTF-16 terminator (got 0x${terminator.toString(16).padStart(4, '0')}).`,
      );
    }

    strings.push(value);
  }

  if (cursor !== bytes.byteLength) {
    throw new GtdbError(
      GtdbError.InvalidLayout,
      `WSDB contains ${String(bytes.byteLength - cursor)} unexpected trailing bytes after ${String(count)} records.`,
    );
  }

  return {
    fileSize,
    count,
    strings,
  };
}

/**
 * Looks up a string by numeric index from a decoded `UnistrdbTable`, returning `undefined` if out of range.
 */
export function getUnistrdbString(table: UnistrdbTable, index: number): string | undefined {
  if (!Number.isInteger(index) || index < 0 || index >= table.strings.length) {
    return undefined;
  }
  return table.strings[index];
}
