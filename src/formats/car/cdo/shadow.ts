import { readCdoBoundingBox } from './lod';
import {
  CDO_SHADOW_FACE_BYTES,
  CDO_SHADOW_HEADER_BYTES,
  CDO_SHADOW_VERTEX_BYTES,
  CdoError,
  type CdoShadowBlock,
  type CdoShadowFace,
  type CdoShadowHeader,
} from './types';

function readShadowFace(view: DataView, offset: number): CdoShadowFace {
  const word = view.getUint32(offset, true);
  const v0 = word & 0x3f;
  const v1 = (word >>> 6) & 0x3f;
  const v2 = (word >>> 12) & 0x3f;
  const v3 = (word >>> 18) & 0x3f;
  const flagsRaw = (word >>> 24) & 0xff;
  return {
    vertices: [v0, v1, v2, v3],
    flagsRaw,
  };
}

/**
 * Parses the 28-byte shadow block header starting at `offset` (immediately after the final LOD).
 */
export function parseCdoShadowHeader(data: Uint8Array, offset: number): CdoShadowHeader {
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    offset + CDO_SHADOW_HEADER_BYTES > data.byteLength
  ) {
    throw new CdoError(
      CdoError.TruncatedBuffer,
      `Shadow header at 0x${Math.max(0, offset).toString(16)} requires ${String(CDO_SHADOW_HEADER_BYTES)} bytes, buffer length is ${String(data.byteLength)}.`,
    );
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    headerOffset: offset,
    dataOffset: offset + CDO_SHADOW_HEADER_BYTES,
    vertexCount: view.getUint16(offset + 0x00, true),
    triangleCount: view.getUint16(offset + 0x02, true),
    quadCount: view.getUint16(offset + 0x04, true),
    unk_0x06: view.getUint16(offset + 0x06, true),
    boundingBox: readCdoBoundingBox(view, offset + 0x08),
    scale: view.getUint16(offset + 0x18, true),
    unk_0x1a: view.getUint16(offset + 0x1a, true),
  };
}

/**
 * Parses the complete shadow block (`28 B` header + `4 B` XZ vertices + `4 B` bit-packed triangles and quads).
 */
export function parseCdoShadowBlock(data: Uint8Array, offset: number): CdoShadowBlock {
  const header = parseCdoShadowHeader(data, offset);

  const verticesBytes = header.vertexCount * CDO_SHADOW_VERTEX_BYTES;
  const trisBytes = header.triangleCount * CDO_SHADOW_FACE_BYTES;
  const quadsBytes = header.quadCount * CDO_SHADOW_FACE_BYTES;
  const payloadBytes = verticesBytes + trisBytes + quadsBytes;
  const endOffset = header.dataOffset + payloadBytes;

  if (endOffset > data.byteLength) {
    throw new CdoError(
      CdoError.TruncatedBuffer,
      `Shadow payload at 0x${header.dataOffset.toString(16)} (${String(payloadBytes)} B) exceeds buffer length ${String(data.byteLength)}.`,
    );
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const rawVerticesXZ = new Int16Array(header.vertexCount * 2);

  let cursor = header.dataOffset;
  for (let i = 0; i < header.vertexCount; i += 1) {
    rawVerticesXZ[i * 2] = view.getInt16(cursor, true);
    rawVerticesXZ[i * 2 + 1] = view.getInt16(cursor + 2, true);
    cursor += CDO_SHADOW_VERTEX_BYTES;
  }

  const triangles: CdoShadowFace[] = [];
  for (let i = 0; i < header.triangleCount; i += 1) {
    triangles.push(readShadowFace(view, cursor));
    cursor += CDO_SHADOW_FACE_BYTES;
  }

  const quads: CdoShadowFace[] = [];
  for (let i = 0; i < header.quadCount; i += 1) {
    quads.push(readShadowFace(view, cursor));
    cursor += CDO_SHADOW_FACE_BYTES;
  }

  return {
    header,
    rawVerticesXZ,
    triangles,
    quads,
    endOffset: cursor,
  };
}
