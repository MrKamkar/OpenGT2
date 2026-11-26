import { describe, expect, it } from 'vitest';
import {
  CDO_FACE_TYPE_QUAD,
  CDO_FACE_TYPE_TRI,
  CDO_FACE_TYPE_UV_QUAD,
  CDO_FACE_TYPE_UV_QUAD_MODULATED,
  CDO_FACE_TYPE_UV_TRI,
  CdoError,
  parseCdoPolygonLists,
} from '../../src/formats/car/cdo';

interface PolySpec {
  readonly v: readonly [number, number, number, number];
  readonly renderOrder: number;
  readonly renderFlags: number;
  readonly n: readonly [number, number, number, number];
  readonly faceType: number;
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly uv?: readonly [
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
  ];
  readonly paletteRaw?: number;
  readonly pad0x16?: number;
}

function writePoly(view: DataView, offset: number, spec: PolySpec): number {
  view.setUint8(offset, spec.v[0]);
  view.setUint8(offset + 1, spec.v[1]);
  view.setUint8(offset + 2, spec.v[2]);
  view.setUint8(offset + 3, spec.v[3]);

  const w04 = (spec.renderOrder & 0x1f) | ((spec.n[0] & 0x1ff) << 5);
  const w06 = (spec.renderFlags & 0x0f) << 12;
  const d08 =
    (((spec.n[1] & 0x1ff) << 1) |
      ((spec.n[2] & 0x1ff) << 10) |
      ((spec.n[3] & 0x1ff) << 19)) >>>
    0;
  const d0c =
    (((spec.faceType & 0xff) << 24) |
      ((spec.b & 0xff) << 16) |
      ((spec.g & 0xff) << 8) |
      (spec.r & 0xff)) >>>
    0;

  view.setUint16(offset + 0x04, w04, true);
  view.setUint16(offset + 0x06, w06, true);
  view.setUint32(offset + 0x08, d08, true);
  view.setUint32(offset + 0x0c, d0c, true);

  if (spec.uv === undefined) {
    return offset + 16;
  }

  view.setUint8(offset + 0x10, spec.uv[0][0]);
  view.setUint8(offset + 0x11, spec.uv[0][1]);
  view.setUint16(offset + 0x12, spec.paletteRaw ?? 0, true);
  view.setUint8(offset + 0x14, spec.uv[1][0]);
  view.setUint8(offset + 0x15, spec.uv[1][1]);
  view.setUint16(offset + 0x16, spec.pad0x16 ?? 0, true);
  view.setUint8(offset + 0x18, spec.uv[2][0]);
  view.setUint8(offset + 0x19, spec.uv[2][1]);
  view.setUint8(offset + 0x1a, spec.uv[3][0]);
  view.setUint8(offset + 0x1b, spec.uv[3][1]);
  return offset + 28;
}

describe('CDO polygon lists parser (M6.4)', () => {
  it('parses all 4 polygon lists in exact file order with 9-bit normals, bitfields, BGR888, and UV', () => {
    const startOffset = 8;
    const totalBytes = 16 + 16 + 28 + 28 * 2;
    const buf = new Uint8Array(startOffset + totalBytes);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    let cursor = startOffset;
    cursor = writePoly(view, cursor, {
      v: [1, 2, 3, 0],
      renderOrder: 31,
      renderFlags: 0b1100,
      n: [511, 10, 20, 0],
      faceType: CDO_FACE_TYPE_TRI,
      r: 0x12,
      g: 0x34,
      b: 0x56,
    });
    cursor = writePoly(view, cursor, {
      v: [10, 20, 30, 40],
      renderOrder: 7,
      renderFlags: 0b0100,
      n: [100, 200, 300, 511],
      faceType: CDO_FACE_TYPE_QUAD,
      r: 0xaa,
      g: 0xbb,
      b: 0xcc,
    });
    cursor = writePoly(view, cursor, {
      v: [4, 5, 6, 0],
      renderOrder: 0,
      renderFlags: 0b1000,
      n: [1, 2, 3, 0],
      faceType: CDO_FACE_TYPE_UV_TRI,
      r: 0,
      g: 0,
      b: 0,
      uv: [
        [10, 20],
        [255, 223],
        [128, 64],
        [0, 0],
      ],
      paletteRaw: 0xc2,
      pad0x16: 0,
    });
    cursor = writePoly(view, cursor, {
      v: [7, 8, 9, 10],
      renderOrder: 15,
      renderFlags: 0b1111,
      n: [11, 22, 33, 44],
      faceType: CDO_FACE_TYPE_UV_QUAD,
      r: 0xfe,
      g: 0xdc,
      b: 0xba,
      uv: [
        [0, 0],
        [64, 0],
        [64, 128],
        [0, 128],
      ],
      paletteRaw: 0x45,
      pad0x16: 0,
    });
    cursor = writePoly(view, cursor, {
      v: [0, 2, 3, 1],
      renderOrder: 17,
      renderFlags: 0b0100,
      n: [0, 0, 0, 0],
      faceType: CDO_FACE_TYPE_UV_QUAD_MODULATED,
      r: 0x45,
      g: 0x50,
      b: 0x5f,
      uv: [
        [159, 191],
        [159, 160],
        [128, 160],
        [128, 191],
      ],
      paletteRaw: 0x00c2,
      pad0x16: 0,
    });
    expect(cursor).toBe(buf.byteLength);

    const parsed = parseCdoPolygonLists(buf, startOffset, {
      triCount: 1,
      quadCount: 1,
      uvTriCount: 1,
      uvQuadCount: 2,
    });

    expect(parsed.nextOffset).toBe(buf.byteLength);
    expect(parsed.triangles[0]).toMatchObject({
      vertices: [1, 2, 3, 0],
      renderOrder: 31,
      renderFlags: 0b1100,
      normals: [511, 10, 20, 0],
      faceType: 32,
      color: { r: 0x12, g: 0x34, b: 0x56, raw24: 0x563412 },
    });
    expect(parsed.quads[0]).toMatchObject({
      vertices: [10, 20, 30, 40],
      renderOrder: 7,
      renderFlags: 0b0100,
      normals: [100, 200, 300, 511],
      faceType: 40,
      color: { r: 0xaa, g: 0xbb, b: 0xcc, raw24: 0xccbbaa },
    });
    expect(parsed.uvTriangles[0]).toMatchObject({
      vertices: [4, 5, 6, 0],
      faceType: 37,
      paletteRaw: 0xc2,
      pad0x16: 0,
      uvs: [
        { u: 10, v: 20 },
        { u: 255, v: 223 },
        { u: 128, v: 64 },
        { u: 0, v: 0 },
      ],
    });
    expect(parsed.uvQuads[0]?.faceType).toBe(45);
    expect(parsed.uvQuads[0]?.renderFlags).toBe(0b1111);
    expect(parsed.uvQuads[1]?.faceType).toBe(44);
    expect(parsed.uvQuads[1]?.color).toEqual({ r: 0x45, g: 0x50, b: 0x5f, raw24: 0x5f5045 });
  });

  it('handles zero polygon counts and subarray byteOffset cleanly', () => {
    const outer = new Uint8Array(40);
    const sub = outer.subarray(12);
    const view = new DataView(sub.buffer, sub.byteOffset, sub.byteLength);
    writePoly(view, 0, {
      v: [0, 1, 2, 0],
      renderOrder: 3,
      renderFlags: 8,
      n: [0, 1, 2, 0],
      faceType: CDO_FACE_TYPE_TRI,
      r: 1,
      g: 2,
      b: 3,
    });

    const parsed = parseCdoPolygonLists(sub, 0, {
      triCount: 1,
      quadCount: 0,
      uvTriCount: 0,
      uvQuadCount: 0,
    });
    expect(parsed.triangles.length).toBe(1);
    expect(parsed.quads.length).toBe(0);
    expect(parsed.uvTriangles.length).toBe(0);
    expect(parsed.uvQuads.length).toBe(0);
    expect(parsed.nextOffset).toBe(16);

    const empty = parseCdoPolygonLists(sub, 16, {
      triCount: 0,
      quadCount: 0,
      uvTriCount: 0,
      uvQuadCount: 0,
    });
    expect(empty.nextOffset).toBe(16);
  });

  it('throws CdoError.TruncatedBuffer when polygon payload exceeds buffer length', () => {
    try {
      parseCdoPolygonLists(new Uint8Array(27), 0, {
        triCount: 0,
        quadCount: 0,
        uvTriCount: 1,
        uvQuadCount: 0,
      });
      expect.fail('Expected TruncatedBuffer');
    } catch (error) {
      expect(error).toBeInstanceOf(CdoError);
      expect((error as CdoError).code).toBe(CdoError.TruncatedBuffer);
    }
  });
});
