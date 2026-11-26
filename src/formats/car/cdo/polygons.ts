import {
  CDO_POLYGON_UNTEX_BYTES,
  CDO_POLYGON_UV_BYTES,
  CdoError,
  type CdoPolygon,
  type CdoPolygonCounts,
  type CdoPolygonLists,
  type CdoTexturedPolygon,
} from './types';

function readBasePolygon(view: DataView, offset: number): CdoPolygon {
  const v0 = view.getUint8(offset);
  const v1 = view.getUint8(offset + 1);
  const v2 = view.getUint8(offset + 2);
  const v3 = view.getUint8(offset + 3);

  const w04 = view.getUint16(offset + 0x04, true);
  const w06 = view.getUint16(offset + 0x06, true);
  const d08 = view.getUint32(offset + 0x08, true);
  const d0c = view.getUint32(offset + 0x0c, true);

  const renderOrder = w04 & 0x1f;
  const n0 = (w04 >>> 5) & 0x1ff;
  const unk_w04_bits14_15 = (w04 >>> 14) & 0x03;

  const unk_w06_bits0_11 = w06 & 0x0fff;
  const renderFlags = (w06 >>> 12) & 0x0f;

  const unk_d08_bit0 = d08 & 0x01;
  const n1 = (d08 >>> 1) & 0x1ff;
  const n2 = (d08 >>> 10) & 0x1ff;
  const n3 = (d08 >>> 19) & 0x1ff;
  const unk_d08_bits28_31 = (d08 >>> 28) & 0x0f;

  const faceType = (d0c >>> 24) & 0xff;
  const raw24 = d0c & 0x00ffffff;
  const r = raw24 & 0xff;
  const g = (raw24 >>> 8) & 0xff;
  const b = (raw24 >>> 16) & 0xff;

  return {
    vertices: [v0, v1, v2, v3],
    renderOrder,
    renderFlags,
    normals: [n0, n1, n2, n3],
    faceType,
    color: { r, g, b, raw24 },
    unk_w04_bits14_15,
    unk_w06_bits0_11,
    unk_d08_bit0,
    unk_d08_bits28_31,
  };
}

function readTexturedPolygon(view: DataView, offset: number): CdoTexturedPolygon {
  const base = readBasePolygon(view, offset);
  const uv0 = { u: view.getUint8(offset + 0x10), v: view.getUint8(offset + 0x11) };
  const paletteRaw = view.getUint16(offset + 0x12, true);
  const uv1 = { u: view.getUint8(offset + 0x14), v: view.getUint8(offset + 0x15) };
  const pad0x16 = view.getUint16(offset + 0x16, true);
  const uv2 = { u: view.getUint8(offset + 0x18), v: view.getUint8(offset + 0x19) };
  const uv3 = { u: view.getUint8(offset + 0x1a), v: view.getUint8(offset + 0x1b) };

  return {
    ...base,
    uvs: [uv0, uv1, uv2, uv3],
    paletteRaw,
    pad0x16,
  };
}

/**
 * Parses all 4 polygon lists of a LOD in exact file order:
 * untextured triangles (`16 B`), untextured quads (`16 B`), UV triangles (`28 B`), UV quads (`28 B`).
 */
export function parseCdoPolygonLists(
  data: Uint8Array,
  offset: number,
  counts: CdoPolygonCounts,
): CdoPolygonLists {
  const { triCount, quadCount, uvTriCount, uvQuadCount } = counts;
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(triCount) ||
    !Number.isInteger(quadCount) ||
    !Number.isInteger(uvTriCount) ||
    !Number.isInteger(uvQuadCount) ||
    triCount < 0 ||
    quadCount < 0 ||
    uvTriCount < 0 ||
    uvQuadCount < 0
  ) {
    throw new CdoError(
      CdoError.TruncatedBuffer,
      `Invalid polygon list parameters at offset 0x${Math.max(0, offset).toString(16)}.`,
    );
  }

  const totalBytes =
    (triCount + quadCount) * CDO_POLYGON_UNTEX_BYTES +
    (uvTriCount + uvQuadCount) * CDO_POLYGON_UV_BYTES;
  if (offset + totalBytes > data.byteLength) {
    throw new CdoError(
      CdoError.TruncatedBuffer,
      `Polygon lists at 0x${offset.toString(16)} (${String(totalBytes)} B) exceed buffer length ${String(data.byteLength)}.`,
    );
  }

  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let cursor = offset;

  const triangles: CdoPolygon[] = [];
  for (let i = 0; i < triCount; i += 1) {
    triangles.push(readBasePolygon(view, cursor));
    cursor += CDO_POLYGON_UNTEX_BYTES;
  }

  const quads: CdoPolygon[] = [];
  for (let i = 0; i < quadCount; i += 1) {
    quads.push(readBasePolygon(view, cursor));
    cursor += CDO_POLYGON_UNTEX_BYTES;
  }

  const uvTriangles: CdoTexturedPolygon[] = [];
  for (let i = 0; i < uvTriCount; i += 1) {
    uvTriangles.push(readTexturedPolygon(view, cursor));
    cursor += CDO_POLYGON_UV_BYTES;
  }

  const uvQuads: CdoTexturedPolygon[] = [];
  for (let i = 0; i < uvQuadCount; i += 1) {
    uvQuads.push(readTexturedPolygon(view, cursor));
    cursor += CDO_POLYGON_UV_BYTES;
  }

  return {
    triangles,
    quads,
    uvTriangles,
    uvQuads,
    nextOffset: cursor,
  };
}
