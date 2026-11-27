import { decodeClut, decodeTpage } from './trp';
import {
  TRO_CENTERLINE_SHIFT,
  TRO_CENTERLINE_UNIT_RATIO,
  TRO_CELL_SIZE,
  TRO_GPU_TAGS,
  TRO_HEADER_BYTES,
  TRO_LIST_COUNT,
  TRO_LIST_STRIDES,
  TRO_MAGIC,
  TRO_SUBMESH_HEADER_BYTES,
  TRO_UV_ENTRY_BYTES,
  TrackError,
  type TroFile,
  type TroHeader,
  type TroPolygon,
  type TroPolygonListIndex,
  type TroRgbColor,
  type TroSegment,
  type TroSubMesh,
  type TroUvEntry,
  type TroUvHalf,
  type TroWallBarrier2D,
} from './types';

function readAscii(bytes: Uint8Array, start: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += String.fromCharCode(bytes[start + i] ?? 0);
  }
  return out;
}

function parseHeader(bytes: Uint8Array, dv: DataView): TroHeader {
  if (bytes.byteLength < TRO_HEADER_BYTES) {
    throw new TrackError(
      TrackError.TruncatedHeader,
      `TRO buffer too short for 72-byte header: ${String(bytes.byteLength)} byte(s).`,
    );
  }

  const magic = readAscii(bytes, 0, TRO_MAGIC.length);
  if (magic !== TRO_MAGIC) {
    throw new TrackError(
      TrackError.InvalidMagic,
      `Invalid TRO magic "${magic}" (expected "@(#)GT-PS\\0\\0\\0").`,
    );
  }

  const versionFlag0x0C = dv.getUint32(0x0c, true);
  const off0 = dv.getUint32(0x10, true);
  const off1 = dv.getUint32(0x14, true);
  const off2 = dv.getUint32(0x18, true);
  const off3 = dv.getUint32(0x1c, true);
  const off4 = dv.getUint32(0x20, true);
  const checkpointCount0x24 = dv.getUint32(0x24, true);

  const headerWords0x28: number[] = [];
  for (let off = 0x28; off < TRO_HEADER_BYTES; off += 4) {
    headerWords0x28.push(dv.getUint32(off, true));
  }

  if (
    off0 < TRO_HEADER_BYTES ||
    off0 >= off1 ||
    off1 > off2 ||
    off2 > off3 ||
    off3 > off4 ||
    off4 + 4 > bytes.byteLength
  ) {
    throw new TrackError(
      TrackError.InvalidSectionBounds,
      `Invalid TRO section offsets [${String(off0)}, ${String(off1)}, ${String(off2)}, ${String(off3)}, ${String(off4)}] for byteLength=${String(bytes.byteLength)}.`,
    );
  }

  return {
    magic,
    versionFlag0x0C,
    off0,
    off1,
    off2,
    off3,
    off4,
    checkpointCount0x24,
    headerWords0x28,
    prefixByteLength: off0 - TRO_HEADER_BYTES,
  };
}

function parseUvHalf(bytes: Uint8Array, dv: DataView, offset: number, uvIndex: number, halfLabel: string): TroUvHalf {
  const u0 = bytes[offset] ?? 0;
  const v0 = bytes[offset + 1] ?? 0;
  const clutRaw = dv.getUint16(offset + 2, true);
  const u1 = bytes[offset + 4] ?? 0;
  const v1 = bytes[offset + 5] ?? 0;
  const tpageRaw = dv.getUint16(offset + 6, true);
  const u2 = bytes[offset + 8] ?? 0;
  const v2 = bytes[offset + 9] ?? 0;
  const u3 = bytes[offset + 10] ?? 0;
  const v3 = bytes[offset + 11] ?? 0;
  const unk0x0C = dv.getUint32(offset + 12, true);

  const decodedClut = decodeClut(clutRaw);
  const decodedTpage = decodeTpage(tpageRaw);
  if (decodedTpage.colorDepth !== 0) {
    throw new TrackError(
      TrackError.UnsupportedTpageDepth,
      `UV[${String(uvIndex)}].${halfLabel} uses unsupported tpage colorDepth=${String(decodedTpage.colorDepth)} (expected 0 = 4 bpp).`,
    );
  }

  return {
    u: [u0, u1, u2, u3],
    v: [v0, v1, v2, v3],
    clutRaw: decodedClut.clutRaw,
    clutX: decodedClut.clutX,
    clutY: decodedClut.clutY,
    tpageRaw: decodedTpage.tpageRaw,
    pageX: decodedTpage.pageX,
    pageY: decodedTpage.pageY,
    vramX: decodedTpage.vramX,
    vramY: decodedTpage.vramY,
    abr: decodedTpage.abr,
    colorDepth: decodedTpage.colorDepth,
    unk0x0C,
  };
}

function parseSubMesh(
  bytes: Uint8Array,
  dv: DataView,
  mhOff: number,
  segLimit: number,
  uvCount: number,
  cellX: number,
  cellY: number,
  cellZ: number,
  segmentIndex: number,
  label: string,
): TroSubMesh {
  if (mhOff < 0 || mhOff + TRO_SUBMESH_HEADER_BYTES > segLimit) {
    throw new TrackError(
      TrackError.InvalidSubMeshHeader,
      `Segment ${String(segmentIndex)} ${label} header at ${String(mhOff)} exceeds limit ${String(segLimit)}.`,
    );
  }

  const ptrs: number[] = [];
  for (let i = 0; i < TRO_LIST_COUNT; i += 1) {
    ptrs.push(dv.getUint32(mhOff + i * 4, true));
  }
  if (ptrs[0] !== mhOff + TRO_SUBMESH_HEADER_BYTES) {
    throw new TrackError(
      TrackError.InvalidSubMeshHeader,
      `Segment ${String(segmentIndex)} ${label} ptr[0]=${String(ptrs[0])} does not match mhOff+0x44=${String(mhOff + TRO_SUBMESH_HEADER_BYTES)}.`,
    );
  }

  const vertexCount = dv.getUint16(mhOff + 0x2c, true);
  const pad0x2e = dv.getUint16(mhOff + 0x2e, true);
  if (pad0x2e !== 0) {
    throw new TrackError(
      TrackError.InvalidSubMeshHeader,
      `Segment ${String(segmentIndex)} ${label} non-zero pad0x2e=${String(pad0x2e)}.`,
    );
  }

  const counts: number[] = [vertexCount];
  for (let i = 0; i < 10; i += 1) {
    counts.push(dv.getUint16(mhOff + 0x30 + i * 2, true));
  }

  let cursor = mhOff + TRO_SUBMESH_HEADER_BYTES;
  for (let listIdx = 0; listIdx < TRO_LIST_COUNT; listIdx += 1) {
    const ptr = ptrs[listIdx]!;
    const count = counts[listIdx]!;
    const stride = TRO_LIST_STRIDES[listIdx]!;
    if (ptr !== cursor) {
      throw new TrackError(
        TrackError.InvalidSubMeshHeader,
        `Segment ${String(segmentIndex)} ${label} list ${String(listIdx)} pointer mismatch: expected ${String(cursor)}, got ${String(ptr)}.`,
      );
    }
    cursor += count * stride;
    if (cursor > segLimit) {
      throw new TrackError(
        TrackError.InvalidSubMeshHeader,
        `Segment ${String(segmentIndex)} ${label} list ${String(listIdx)} end ${String(cursor)} exceeds segment limit ${String(segLimit)}.`,
      );
    }
  }

  // List 0: SVECTOR int16[x, y, z, pad] relative to segment cellOriginRaw.
  const worldVerticesRaw = new Int32Array(vertexCount * 3);
  const vertBase = ptrs[0]!;
  for (let vi = 0; vi < vertexCount; vi += 1) {
    const vOff = vertBase + vi * 8;
    const dst = vi * 3;
    worldVerticesRaw[dst] = cellX + dv.getInt16(vOff, true);
    worldVerticesRaw[dst + 1] = cellY + dv.getInt16(vOff + 2, true);
    worldVerticesRaw[dst + 2] = cellZ + dv.getInt16(vOff + 4, true);
  }

  const polygons: TroPolygon[] = [];
  for (let li = 1; li <= 8; li += 1) {
    const listIndex = li as TroPolygonListIndex;
    const base = ptrs[li]!;
    const count = counts[li]!;
    const stride = TRO_LIST_STRIDES[li]!;
    const isQuad = li % 2 === 0;
    const isGouraud = li === 3 || li === 4 || li === 7 || li === 8;
    const isTextured = li >= 5;
    const expectedTag = TRO_GPU_TAGS[listIndex];

    for (let pi = 0; pi < count; pi += 1) {
      const off = base + pi * stride;
      const w0 = dv.getUint32(off, true);
      const w1 = dv.getUint32(off + 4, true);

      const v0 = w0 & 0x1ff;
      const v1 = (w0 >>> 9) & 0x1ff;
      const v2 = (w0 >>> 18) & 0x1ff;
      const unk5 = (w0 >>> 27) & 0x1f;
      const v3 = w1 & 0x1ff;
      const uvIndex = (w1 >>> 9) & 0x3fff;
      const unkFlags = (w1 >>> 23) & 0x1ff;
      const surfaceCode = (w1 >>> 28) & 0x07;

      if (v0 >= vertexCount || v1 >= vertexCount || v2 >= vertexCount || (isQuad && v3 >= vertexCount)) {
        throw new TrackError(
          TrackError.VertexIndexOutOfBounds,
          `Segment ${String(segmentIndex)} ${label} list ${String(li)} poly ${String(pi)} has vertex index >= ${String(vertexCount)}.`,
        );
      }
      if (!isQuad && v3 !== 0) {
        throw new TrackError(
          TrackError.InvalidTriangleVertex3,
          `Segment ${String(segmentIndex)} ${label} list ${String(li)} triangle ${String(pi)} has non-zero v3=${String(v3)}.`,
        );
      }
      if (isTextured && uvIndex >= uvCount) {
        throw new TrackError(
          TrackError.UvIndexOutOfBounds,
          `Segment ${String(segmentIndex)} ${label} list ${String(li)} poly ${String(pi)} uvIndex=${String(uvIndex)} >= ${String(uvCount)}.`,
        );
      }

      const gpuTag = bytes[off + 11] ?? 0;
      if (gpuTag !== expectedTag) {
        throw new TrackError(
          TrackError.InvalidGpuTag,
          `Segment ${String(segmentIndex)} ${label} list ${String(li)} poly ${String(pi)} has GPU tag 0x${gpuTag.toString(16)} (expected 0x${expectedTag.toString(16)}).`,
        );
      }

      const colors: TroRgbColor[] = [
        {
          r: bytes[off + 8] ?? 0,
          g: bytes[off + 9] ?? 0,
          b: bytes[off + 10] ?? 0,
        },
      ];
      if (isGouraud) {
        colors.push(
          {
            r: bytes[off + 12] ?? 0,
            g: bytes[off + 13] ?? 0,
            b: bytes[off + 14] ?? 0,
          },
          {
            r: bytes[off + 16] ?? 0,
            g: bytes[off + 17] ?? 0,
            b: bytes[off + 18] ?? 0,
          },
        );
        if (isQuad) {
          colors.push({
            r: bytes[off + 20] ?? 0,
            g: bytes[off + 21] ?? 0,
            b: bytes[off + 22] ?? 0,
          });
        }
      }

      polygons.push({
        listIndex,
        isQuad,
        isGouraud,
        isTextured,
        vertices: [v0, v1, v2, v3],
        uvIndex: isTextured ? uvIndex : 0,
        gpuTag,
        colors,
        unk5,
        surfaceCode,
        unkFlags,
      });
    }
  }

  return {
    vertexCount,
    worldVerticesRaw,
    polygons,
    list9Count: counts[9] ?? 0,
    list10Count: counts[10] ?? 0,
  };
}

function parseWallBlock98(
  dv: DataView,
  b98Off: number,
  b9cOff: number,
  segOff: number,
  segLimit: number,
  subMesh0VertexCount: number,
  segmentIndex: number,
): TroWallBarrier2D[] {
  if (b98Off < segOff + TRO_SUBMESH_HEADER_BYTES || b98Off + 4 > b9cOff || b9cOff > segLimit) {
    throw new TrackError(
      TrackError.InvalidWallBlock,
      `Segment ${String(segmentIndex)} subBlock98 range [${String(b98Off)}, ${String(b9cOff)}) is invalid for segLimit=${String(segLimit)}.`,
    );
  }

  const wallCount = dv.getUint32(b98Off, true);
  const expectedSize = 4 + wallCount * 8;
  const actualSize = b9cOff - b98Off;
  if (actualSize !== expectedSize) {
    throw new TrackError(
      TrackError.InvalidWallBlock,
      `Segment ${String(segmentIndex)} subBlock98 size mismatch: expected ${String(expectedSize)}, got ${String(actualSize)}.`,
    );
  }

  const walls: TroWallBarrier2D[] = [];
  for (let wi = 0; wi < wallCount; wi += 1) {
    const off = b98Off + 4 + wi * 8;
    const v0 = dv.getUint16(off, true);
    const v1 = dv.getUint16(off + 2, true);
    if (v0 >= subMesh0VertexCount || v1 >= subMesh0VertexCount) {
      throw new TrackError(
        TrackError.WallVertexIndexOutOfBounds,
        `Segment ${String(segmentIndex)} wall[${String(wi)}] vertex (${String(v0)}, ${String(v1)}) >= subMesh0.vertexCount (${String(subMesh0VertexCount)}).`,
      );
    }
    walls.push({
      v0,
      v1,
      nxFixed12: dv.getInt16(off + 4, true),
      nyFixed12: dv.getInt16(off + 6, true),
    });
  }

  return walls;
}

/**
 * Parses a decompressed GT2 `.tro` track geometry buffer (`"@(#)GT-PS\\0\\0\\0"`),
 * validating header/section bounds, Section 0 segment/UV tables, `subMesh0` + `subMesh1`,
 * `F3..GT4` polygon records, and `subBlock98` 2D barrier walls.
 *
 * @evidence E3
 */
export function parseTro(bytes: Uint8Array): TroFile {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = parseHeader(bytes, dv);
  const warnings: string[] = [];

  const section4RecordedSize = dv.getUint32(header.off4, true);
  const expectedSection4Size = bytes.byteLength - header.off4;
  if (section4RecordedSize !== expectedSection4Size) {
    warnings.push(
      `TRO Section 4 recorded size (${String(section4RecordedSize)}) differs from remaining bytes (${String(expectedSection4Size)}).`,
    );
  }

  const { off0, off1 } = header;
  if (off0 + 12 > off1) {
    throw new TrackError(
      TrackError.InvalidSectionBounds,
      `TRO Section 0 [${String(off0)}, ${String(off1)}) is too small for Section 0 header.`,
    );
  }

  const trackLengthRaw = dv.getUint32(off0, true);
  const segmentCount = dv.getUint16(off0 + 4, true);
  const uvCount = dv.getUint16(off0 + 6, true);
  const uvTableOff = dv.getUint32(off0 + 8, true);

  const segOffsetTableStart = off0 + 12;
  const segOffsetTableEnd = segOffsetTableStart + segmentCount * 4;
  if (segOffsetTableEnd > uvTableOff || uvTableOff > off1) {
    throw new TrackError(
      TrackError.InvalidSegmentTable,
      `Invalid Section 0 table boundaries (segOffsetTableEnd=${String(segOffsetTableEnd)}, uvTableOff=${String(uvTableOff)}, off1=${String(off1)}).`,
    );
  }

  if (off1 - uvTableOff !== uvCount * TRO_UV_ENTRY_BYTES) {
    throw new TrackError(
      TrackError.InvalidUvTable,
      `UV table size mismatch: off1 - uvTableOff = ${String(off1 - uvTableOff)}, expected uvCount (${String(uvCount)}) * 32 = ${String(uvCount * TRO_UV_ENTRY_BYTES)}.`,
    );
  }

  const segOffsets: number[] = [];
  for (let si = 0; si < segmentCount; si += 1) {
    const segOff = dv.getUint32(segOffsetTableStart + si * 4, true);
    if (segOff < segOffsetTableEnd || segOff >= uvTableOff) {
      throw new TrackError(
        TrackError.InvalidSegmentTable,
        `Segment ${String(si)} offset ${String(segOff)} is outside [${String(segOffsetTableEnd)}, ${String(uvTableOff)}).`,
      );
    }
    if (si > 0 && segOff <= segOffsets[si - 1]!) {
      throw new TrackError(
        TrackError.InvalidSegmentTable,
        `Segment ${String(si)} offset ${String(segOff)} is not strictly greater than previous ${String(segOffsets[si - 1]!)}.`,
      );
    }
    segOffsets.push(segOff);
  }

  const uvTable: TroUvEntry[] = [];
  for (let ui = 0; ui < uvCount; ui += 1) {
    const entryOff = uvTableOff + ui * TRO_UV_ENTRY_BYTES;
    uvTable.push({
      index: ui,
      hiRes: parseUvHalf(bytes, dv, entryOff, ui, 'hiRes'),
      mipmap: parseUvHalf(bytes, dv, entryOff + 16, ui, 'mipmap'),
    });
  }

  const segments: TroSegment[] = [];
  for (let si = 0; si < segmentCount; si += 1) {
    const segOff = segOffsets[si]!;
    const segLimit = si + 1 < segmentCount ? segOffsets[si + 1]! : uvTableOff;
    if (segOff + 0xa4 + TRO_SUBMESH_HEADER_BYTES > segLimit) {
      throw new TrackError(
        TrackError.InvalidSegmentTable,
        `Segment ${String(si)} header [${String(segOff)}, ${String(segOff + 0xa4 + TRO_SUBMESH_HEADER_BYTES)}) exceeds segment limit ${String(segLimit)}.`,
      );
    }

    const prevSegment = dv.getUint16(segOff, true);
    const nextSegment = dv.getUint16(segOff + 2, true);

    const startX = dv.getInt32(segOff + 0x18, true) / TRO_CENTERLINE_UNIT_RATIO;
    const startZ = dv.getInt32(segOff + 0x1c, true) / TRO_CENTERLINE_UNIT_RATIO;
    const startY = dv.getInt32(segOff + 0x20, true) / TRO_CENTERLINE_UNIT_RATIO;

    const rawCenterX = dv.getInt32(segOff + 0x30, true);
    const rawCenterZ = dv.getInt32(segOff + 0x34, true);
    const rawCenterY = dv.getInt32(segOff + 0x38, true);

    const cellX = (rawCenterX >> TRO_CENTERLINE_SHIFT) * TRO_CELL_SIZE;
    const cellZ = (rawCenterZ >> TRO_CENTERLINE_SHIFT) * TRO_CELL_SIZE;
    const cellY = (rawCenterY >> TRO_CENTERLINE_SHIFT) * TRO_CELL_SIZE;

    const subMesh1Off = dv.getUint32(segOff + 0x94, true);
    const b98Off = dv.getUint32(segOff + 0x98, true);
    const b9cOff = dv.getUint32(segOff + 0x9c, true);

    const subMesh0 = parseSubMesh(
      bytes,
      dv,
      segOff + 0xa4,
      segLimit,
      uvCount,
      cellX,
      cellY,
      cellZ,
      si,
      'subMesh0',
    );
    const subMesh1 = parseSubMesh(
      bytes,
      dv,
      subMesh1Off,
      segLimit,
      uvCount,
      cellX,
      cellY,
      cellZ,
      si,
      'subMesh1',
    );
    const walls2D = parseWallBlock98(
      dv,
      b98Off,
      b9cOff,
      segOff,
      segLimit,
      subMesh0.vertexCount,
      si,
    );

    segments.push({
      segmentIndex: si,
      prevSegment,
      nextSegment,
      centerlineStartRaw: { x: startX, y: startY, z: startZ },
      centerlineCenterRaw: {
        x: rawCenterX / TRO_CENTERLINE_UNIT_RATIO,
        y: rawCenterY / TRO_CENTERLINE_UNIT_RATIO,
        z: rawCenterZ / TRO_CENTERLINE_UNIT_RATIO,
      },
      cellOriginRaw: { x: cellX, y: cellY, z: cellZ },
      subMesh0,
      subMesh1,
      walls2D,
    });
  }

  return {
    byteLength: bytes.byteLength,
    header,
    trackLengthRaw,
    segmentCount,
    uvCount,
    uvTable,
    segments,
    warnings,
  };
}
