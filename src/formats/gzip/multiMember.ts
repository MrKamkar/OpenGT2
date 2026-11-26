import { Inflate } from 'fflate';
import {
  GZIP_DEFLATE_METHOD,
  GZIP_MAGIC_BYTES,
  GZIP_MIN_BYTE_LENGTH,
  GzipError,
  computeCrc32,
  isGzipMagic,
} from './gunzip';

/** @evidence E3 — Alignment boundaries observed in GT2.VOL multi-member gzip containers. */
export const DEFAULT_MULTI_GZIP_ALIGNMENT = 2048;
export const DEFAULT_MULTI_GZIP_MAX_MEMBERS = 128;

const GZIP_FLG_FHCRC = 0x02;
const GZIP_FLG_FEXTRA = 0x04;
const GZIP_FLG_FNAME = 0x08;
const GZIP_FLG_FCOMMENT = 0x10;
const GZIP_FLG_RESERVED_MASK = 0xe0;

export interface GzipMember {
  readonly index: number;
  readonly offset: number;
  readonly compressedEnd: number;
  readonly nextOffset: number;
  readonly data: Uint8Array;
}

export interface MultiMemberGzipOptions {
  /** Byte alignment of zero-padding between members (default `2048` for PS1 CD sectors). */
  readonly alignment?: number;
  /** Safety cap on number of extracted members (default `128`). */
  readonly maxMembers?: number;
}

function parseRfc1952HeaderEnd(bytes: Uint8Array, offset: number): number {
  if (offset + GZIP_MIN_BYTE_LENGTH > bytes.byteLength) {
    throw new GzipError(
      GzipError.TruncatedStream,
      `Truncated gzip member header at offset ${String(offset)}`,
    );
  }
  if (bytes[offset] !== GZIP_MAGIC_BYTES[0] || bytes[offset + 1] !== GZIP_MAGIC_BYTES[1]) {
    throw new GzipError(
      GzipError.InvalidMagic,
      `Missing gzip magic at member offset ${String(offset)}`,
    );
  }
  if (bytes[offset + 2] !== GZIP_DEFLATE_METHOD) {
    throw new GzipError(
      GzipError.UnsupportedMethod,
      `Unsupported gzip method at offset ${String(offset)}`,
    );
  }

  const flg = bytes[offset + 3] ?? 0;
  if ((flg & GZIP_FLG_RESERVED_MASK) !== 0) {
    throw new GzipError(
      GzipError.CorruptStream,
      `Invalid reserved gzip flags 0x${flg.toString(16)} at offset ${String(offset)}`,
    );
  }

  let cursor = offset + 10;

  if ((flg & GZIP_FLG_FEXTRA) !== 0) {
    if (cursor + 2 > bytes.byteLength) {
      throw new GzipError(GzipError.TruncatedStream, 'Truncated gzip FEXTRA length');
    }
    const xlen = (bytes[cursor] ?? 0) | ((bytes[cursor + 1] ?? 0) << 8);
    cursor += 2 + xlen;
  }

  if ((flg & GZIP_FLG_FNAME) !== 0) {
    while (cursor < bytes.byteLength && bytes[cursor] !== 0) {
      cursor += 1;
    }
    if (cursor >= bytes.byteLength) {
      throw new GzipError(GzipError.TruncatedStream, 'Unterminated gzip FNAME');
    }
    cursor += 1;
  }

  if ((flg & GZIP_FLG_FCOMMENT) !== 0) {
    while (cursor < bytes.byteLength && bytes[cursor] !== 0) {
      cursor += 1;
    }
    if (cursor >= bytes.byteLength) {
      throw new GzipError(GzipError.TruncatedStream, 'Unterminated gzip FCOMMENT');
    }
    cursor += 1;
  }

  if ((flg & GZIP_FLG_FHCRC) !== 0) {
    cursor += 2;
  }

  if (cursor + 8 > bytes.byteLength) {
    throw new GzipError(
      GzipError.TruncatedStream,
      `Truncated gzip member body/trailer at offset ${String(offset)}`,
    );
  }

  return cursor;
}

function inflateMemberBody(slice: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  let finished = false;

  const inflator = new Inflate((chunk, final) => {
    if (chunk.byteLength > 0) {
      chunks.push(chunk);
      totalLength += chunk.byteLength;
    }
    if (final) {
      finished = true;
    }
  });

  try {
    inflator.push(slice, true);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new GzipError(GzipError.CorruptStream, `Multi-member gzip inflate failed: ${detail}`);
  }

  if (!finished) {
    throw new GzipError(GzipError.TruncatedStream, 'Multi-member gzip DEFLATE stream did not terminate');
  }

  const out = new Uint8Array(totalLength);
  let writeOff = 0;
  for (const chunk of chunks) {
    out.set(chunk, writeOff);
    writeOff += chunk.byteLength;
  }
  return out;
}

function isAllZero(bytes: Uint8Array, start: number, end: number): boolean {
  for (let i = start; i < end; i += 1) {
    if (bytes[i] !== 0) {
      return false;
    }
  }
  return true;
}

function locateMemberEnd(
  bytes: Uint8Array,
  deflateStart: number,
  expectedCrc32: number,
  expectedIsize: number,
  alignment: number,
): { readonly compressedEnd: number; readonly nextOffset: number } | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const scanLimit = bytes.byteLength - 8;

  for (let pos = deflateStart; pos <= scanLimit; pos += 1) {
    const crc = dv.getUint32(pos, true);
    if (crc !== expectedCrc32) {
      continue;
    }
    const isize = dv.getUint32(pos + 4, true);
    if (isize !== expectedIsize) {
      continue;
    }

    const compressedEnd = pos + 8;
    const remainder = compressedEnd % alignment;
    const rawAligned = remainder === 0 ? compressedEnd : compressedEnd + (alignment - remainder);
    const nextOffset = Math.min(bytes.byteLength, rawAligned);

    if (!isAllZero(bytes, compressedEnd, nextOffset)) {
      continue;
    }

    if (nextOffset === bytes.byteLength) {
      return { compressedEnd, nextOffset };
    }

    if (
      nextOffset + GZIP_MIN_BYTE_LENGTH <= bytes.byteLength &&
      bytes[nextOffset] === GZIP_MAGIC_BYTES[0] &&
      bytes[nextOffset + 1] === GZIP_MAGIC_BYTES[1] &&
      bytes[nextOffset + 2] === GZIP_DEFLATE_METHOD
    ) {
      return { compressedEnd, nextOffset };
    }

    if (isAllZero(bytes, nextOffset, bytes.byteLength)) {
      return { compressedEnd, nextOffset: bytes.byteLength };
    }
  }

  return null;
}

/**
 * Browser-compatible extractor for padded multi-member gzip containers (e.g. 2048 B CD-sector
 * aligned TIM packs in `GT2.VOL`, verified in M4.1/M4.3). Does not rely on `node:zlib`.
 *
 * @evidence E3
 */
export function extractMultiMemberGzip(
  bytes: Uint8Array,
  options: MultiMemberGzipOptions = {},
): GzipMember[] {
  const alignment = options.alignment ?? DEFAULT_MULTI_GZIP_ALIGNMENT;
  const maxMembers = options.maxMembers ?? DEFAULT_MULTI_GZIP_MAX_MEMBERS;

  if (!Number.isSafeInteger(alignment) || alignment < 1) {
    throw new RangeError(`alignment must be a positive safe integer, got ${String(alignment)}`);
  }
  if (!Number.isSafeInteger(maxMembers) || maxMembers < 1) {
    throw new RangeError(`maxMembers must be a positive safe integer, got ${String(maxMembers)}`);
  }

  if (bytes.byteLength === 0 || !isGzipMagic(bytes)) {
    throw new GzipError(GzipError.InvalidMagic, 'Multi-member container does not start with 1F 8B');
  }

  const members: GzipMember[] = [];
  let offset = 0;

  while (offset < bytes.byteLength && members.length < maxMembers) {
    if (isAllZero(bytes, offset, bytes.byteLength)) {
      break;
    }

    const deflateStart = parseRfc1952HeaderEnd(bytes, offset);
    const decompressed = inflateMemberBody(bytes.subarray(deflateStart));
    const expectedCrc32 = computeCrc32(decompressed);
    const expectedIsize = decompressed.byteLength >>> 0;

    const bounds = locateMemberEnd(bytes, deflateStart, expectedCrc32, expectedIsize, alignment);
    if (bounds === null) {
      throw new GzipError(
        GzipError.CrcMismatch,
        `Could not locate verified gzip trailer for member ${String(members.length)} at offset ${String(offset)}`,
      );
    }

    members.push({
      index: members.length,
      offset,
      compressedEnd: bounds.compressedEnd,
      nextOffset: bounds.nextOffset,
      data: decompressed,
    });

    offset = bounds.nextOffset;
  }

  return members;
}
