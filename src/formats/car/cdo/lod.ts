import {
  CDO_EXPECTED_VERTICES_OFFSET,
  CDO_LOD_HEADER_BYTES,
  CDO_LOD_SECTION_OFFSET_COUNT,
  CDO_LOD_TABLE_ENTRIES_OFFSET,
  CDO_LOD_TABLE_ENTRY_BYTES,
  CDO_LOD_TABLE_OFFSET,
  CdoError,
  type CdoBoundingBox,
  type CdoLodHeader,
  type CdoLodTable,
  type CdoLodTableEntry,
  type CdoVec4Int16,
} from './types';

function readVec4Int16(view: DataView, offset: number): CdoVec4Int16 {
  return {
    x: view.getInt16(offset, true),
    y: view.getInt16(offset + 2, true),
    z: view.getInt16(offset + 4, true),
    w: view.getInt16(offset + 6, true),
  };
}

/**
 * Reads an 8×`int16` LE bounding box (`low XYZW`, `high XYZW` = 16 bytes) from a `DataView`.
 */
export function readCdoBoundingBox(view: DataView, offset: number): CdoBoundingBox {
  return {
    low: readVec4Int16(view, offset),
    high: readVec4Int16(view, offset + 8),
  };
}

/**
 * Parses the LOD directory starting at `0x868` (`uint32 lodCount` + `lodCount × 8 B` entries).
 */
export function parseCdoLodTable(data: Uint8Array): CdoLodTable {
  if (data.byteLength < CDO_LOD_TABLE_ENTRIES_OFFSET) {
    throw new CdoError(
      CdoError.TruncatedBuffer,
      `LOD table requires at least ${String(CDO_LOD_TABLE_ENTRIES_OFFSET)} bytes, got ${String(data.byteLength)}.`,
    );
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const lodCount = view.getUint32(CDO_LOD_TABLE_OFFSET, true);
  const maxEntriesFitting = Math.floor(
    (data.byteLength - CDO_LOD_TABLE_ENTRIES_OFFSET) / CDO_LOD_TABLE_ENTRY_BYTES,
  );
  if (lodCount > maxEntriesFitting) {
    throw new CdoError(
      CdoError.TruncatedBuffer,
      `LOD table truncated: lodCount=${String(lodCount)} exceeds available ${String(data.byteLength - CDO_LOD_TABLE_ENTRIES_OFFSET)} bytes.`,
    );
  }

  const entries: CdoLodTableEntry[] = [];
  let cursor = CDO_LOD_TABLE_ENTRIES_OFFSET;
  for (let i = 0; i < lodCount; i += 1) {
    entries.push({
      zero: view.getUint16(cursor, true),
      maxDistance: view.getUint16(cursor + 2, true),
      offset: view.getUint32(cursor + 4, true),
    });
    cursor += CDO_LOD_TABLE_ENTRY_BYTES;
  }

  return {
    lodCount,
    entries,
    nextOffset: cursor,
  };
}

/**
 * Parses a single `0x50`-byte LOD header sequentially from `offset` and validates `verticesOffset === 0x50`.
 */
export function parseCdoLodHeader(data: Uint8Array, offset: number): CdoLodHeader {
  if (!Number.isInteger(offset) || offset < 0 || offset + CDO_LOD_HEADER_BYTES > data.byteLength) {
    throw new CdoError(
      CdoError.TruncatedBuffer,
      `LOD header at 0x${Math.max(0, offset).toString(16)} requires ${String(CDO_LOD_HEADER_BYTES)} bytes, buffer length is ${String(data.byteLength)}.`,
    );
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);

  const sectionOffsets: number[] = [];
  for (let i = 0; i < CDO_LOD_SECTION_OFFSET_COUNT; i += 1) {
    sectionOffsets.push(view.getUint32(offset + 0x14 + i * 4, true));
  }

  const verticesOffset = sectionOffsets[0] ?? 0;
  if (verticesOffset !== CDO_EXPECTED_VERTICES_OFFSET) {
    throw new CdoError(
      CdoError.InvalidVerticesOffset,
      `Invalid LOD verticesOffset at 0x${offset.toString(16)}: expected 0x${CDO_EXPECTED_VERTICES_OFFSET.toString(16)}, got 0x${verticesOffset.toString(16)}.`,
    );
  }

  return {
    headerOffset: offset,
    dataOffset: offset + CDO_LOD_HEADER_BYTES,
    vertexCount: view.getUint16(offset + 0x00, true),
    normalCount: view.getUint16(offset + 0x02, true),
    triCount: view.getUint16(offset + 0x04, true),
    quadCount: view.getUint16(offset + 0x06, true),
    unk_0x08: [view.getUint16(offset + 0x08, true), view.getUint16(offset + 0x0a, true)],
    uvTriCount: view.getUint16(offset + 0x0c, true),
    uvQuadCount: view.getUint16(offset + 0x0e, true),
    unk_0x10: view.getUint32(offset + 0x10, true),
    sectionOffsets,
    verticesOffset,
    boundingBox: readCdoBoundingBox(view, offset + 0x3c),
    scale: view.getUint16(offset + 0x4c, true),
    unk_0x4e: view.getUint16(offset + 0x4e, true),
  };
}
