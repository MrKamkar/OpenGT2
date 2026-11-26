/**
 * Reimplemented from `adeyblue/GTVolTools` (`GTMP/GMImage.cs`, `GTMP/GTMPImage.cs`, https://github.com/adeyblue/GTVolTools)
 * Copyright (c) 2019 adeyblue — MIT License.
 */

import type { ByteSource } from '../../io';
import { type GunzipOptions, gunzip } from '../gzip';
import { parseGm } from './gmImage';
import { parseGtmp } from './gtmp';
import {
  type GmImage,
  GtImgError,
  type GtmpImage,
  type IdxEntry,
  type IdxOffsetMode,
  type IdxTable,
} from './types';

function decodeRawOffset(raw: number, mode: IdxOffsetMode): { offset: number; tail: number } {
  if (mode === 'aligned-2048') {
    return { offset: raw >>> 0, tail: 0 };
  }
  return {
    offset: (raw & ~3) >>> 0,
    tail: raw & 3,
  };
}

/**
 * Parses a GT2 menu `.idx` offset table (`uint32 count` + `uint32[count + 1]` LE offsets).
 *
 * - `'aligned-2048'`: raw offsets point directly to 2048-byte-aligned `GTMP` blocks.
 * - `'mangled-4'`: low 2 bits encode trailing zero-padding bytes (`tail = raw & 3`), with
 *   4-byte-aligned start `(raw & ~3) >>> 0` and compressed size `nextOffset - offset - tail`.
 *
 * @evidence E3
 */
export function parseIdxTable(bytes: Uint8Array, mode: IdxOffsetMode): IdxTable {
  if (bytes.byteLength < 8) {
    throw new GtImgError(
      GtImgError.TruncatedBuffer,
      `IDX buffer too short for header and sentinel: ${String(bytes.byteLength)} bytes`,
    );
  }

  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = dv.getUint32(0, true);
  const requiredBytes = 4 + (count + 1) * 4;
  if (requiredBytes > bytes.byteLength) {
    throw new GtImgError(
      GtImgError.TruncatedBuffer,
      `IDX buffer truncated: need ${String(requiredBytes)} bytes for ${String(count)} entries, got ${String(bytes.byteLength)}`,
    );
  }

  const entries: IdxEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    const rawStart = dv.getUint32((i + 1) * 4, true);
    const rawEnd = dv.getUint32((i + 2) * 4, true);
    const start = decodeRawOffset(rawStart, mode);
    const end = decodeRawOffset(rawEnd, mode);
    const size = end.offset - start.offset - start.tail;

    if (end.offset < start.offset || size < 0) {
      throw new GtImgError(
        GtImgError.InvalidIndex,
        `Invalid IDX entry ${String(i)}: offset=${String(start.offset)}, tail=${String(start.tail)}, nextOffset=${String(end.offset)}`,
      );
    }

    entries.push({
      index: i,
      offset: start.offset,
      tail: start.tail,
      size,
    });
  }

  const rawLast = dv.getUint32((count + 1) * 4, true);
  const totalDataSize = decodeRawOffset(rawLast, mode).offset;

  return {
    mode,
    count,
    totalDataSize,
    entries,
  };
}

async function readIndexedEntrySlice(
  datSource: ByteSource,
  index: IdxTable,
  entryIndex: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(entryIndex) || entryIndex < 0 || entryIndex >= index.count) {
    throw new RangeError(
      `IDX entryIndex ${String(entryIndex)} out of bounds [0, ${String(index.count)})`,
    );
  }

  const entry = index.entries[entryIndex];
  if (entry === undefined) {
    throw new RangeError(`Missing IDX entry ${String(entryIndex)}`);
  }

  const end = entry.offset + entry.size;
  if (end > datSource.size) {
    throw new GtImgError(
      GtImgError.TruncatedBuffer,
      `IDX entry ${String(entryIndex)} range [${String(entry.offset)}, ${String(end)}) exceeds source size ${String(datSource.size)}`,
    );
  }

  return datSource.read(entry.offset, end);
}

/**
 * Streams and parses a single `GTMP` block from a `ByteSource` using an `aligned-2048` `.idx` table.
 *
 * @evidence E3
 */
export async function readGtmpContainerEntry(
  datSource: ByteSource,
  index: IdxTable,
  entryIndex: number,
): Promise<GtmpImage> {
  const bytes = await readIndexedEntrySlice(datSource, index, entryIndex);
  return parseGtmp(bytes);
}

/**
 * Streams, decompresses (`gunzip`), and parses a single `GM\x03\x00` image from a `.dat` container
 * using a `mangled-4` `.idx` table. 100% browser-compatible via `ByteSource` and `src/formats/gzip`.
 *
 * @evidence E3
 */
export async function readGmContainerEntry(
  datSource: ByteSource,
  index: IdxTable,
  entryIndex: number,
  gunzipOptions: GunzipOptions = {},
): Promise<GmImage> {
  const compressed = await readIndexedEntrySlice(datSource, index, entryIndex);
  const decompressed = await gunzip(compressed, gunzipOptions);
  return parseGm(decompressed);
}
