import { describe, expect, it } from 'vitest';
import {
  CdoError,
  computeCdoLodVertexScale,
  parseCdoNormals,
  parseCdoVertices,
  signExtend10Bit,
  unpackCdoNormal,
} from '../../src/formats/car/cdo';

function packNormal(x: number, y: number, z: number, low2Bits = 0): number {
  return (
    ((low2Bits & 0x3) |
      ((x & 0x3ff) << 2) |
      ((y & 0x3ff) << 12) |
      ((z & 0x3ff) << 22)) >>>
    0
  );
}

describe('CDO vertex and packed normal decoders (M6.3)', () => {
  it('sign-extends 10-bit boundary values (-512, -1, 0, +511)', () => {
    expect(signExtend10Bit(0x200)).toBe(-512);
    expect(signExtend10Bit(0x3ff)).toBe(-1);
    expect(signExtend10Bit(0x000)).toBe(0);
    expect(signExtend10Bit(0x1ff)).toBe(511);
  });

  it('unpacks 10-bit signed boundary values (-512, -1, 0, +511) independently on X, Y, and Z axes', () => {
    const cases = [-512, -1, 0, 511] as const;

    for (const val of cases) {
      const onlyX = unpackCdoNormal(packNormal(val, 0, 0));
      expect(onlyX.x).toBeCloseTo(val / 500, 6);
      expect(onlyX.y).toBe(0);
      expect(onlyX.z).toBe(0);
      expect(onlyX.rawLow2Bits).toBe(0);

      const onlyY = unpackCdoNormal(packNormal(0, val, 0));
      expect(onlyY.x).toBe(0);
      expect(onlyY.y).toBeCloseTo(val / 500, 6);
      expect(onlyY.z).toBe(0);
      expect(onlyY.rawLow2Bits).toBe(0);

      const onlyZ = unpackCdoNormal(packNormal(0, 0, val));
      expect(onlyZ.x).toBe(0);
      expect(onlyZ.y).toBe(0);
      expect(onlyZ.z).toBeCloseTo(val / 500, 6);
      expect(onlyZ.rawLow2Bits).toBe(0);
    }

    // Combined mixed signs with non-zero low2Bits
    const mixed = unpackCdoNormal(packNormal(-512, 511, -1, 0x03));
    expect(mixed.x).toBeCloseTo(-512 / 500, 6);
    expect(mixed.y).toBeCloseTo(511 / 500, 6);
    expect(mixed.z).toBeCloseTo(-1 / 500, 6);
    expect(mixed.rawLow2Bits).toBe(0x03);
  });

  it('unpacks unit normals across cardinal and diagonal directions', () => {
    const posX = unpackCdoNormal(packNormal(500, 0, 0));
    expect(posX).toEqual({ x: 1, y: 0, z: 0, rawLow2Bits: 0 });

    const negY = unpackCdoNormal(packNormal(0, -500, 0));
    expect(negY).toEqual({ x: 0, y: -1, z: 0, rawLow2Bits: 0 });

    const diag = unpackCdoNormal(packNormal(289, -289, 289));
    expect(Math.hypot(diag.x, diag.y, diag.z)).toBeCloseTo(1, 2);
  });

  it('parses int16 vertices preserving rawInt16 precision and meter conversion', () => {
    const offset = 12;
    const buf = new Uint8Array(offset + 3 * 8 + 4);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    const coords = [
      [-4096, 2048, -8192, 0],
      [32767, -32768, 0, 123],
      [0, 0, 4096, -1],
    ] as const;

    for (let i = 0; i < coords.length; i += 1) {
      const c = coords[i]!;
      const p = offset + i * 8;
      view.setInt16(p, c[0], true);
      view.setInt16(p + 2, c[1], true);
      view.setInt16(p + 4, c[2], true);
      view.setInt16(p + 6, c[3], true);
    }

    const sub = buf.subarray(4);
    const verts = parseCdoVertices(sub, offset - 4, 3);
    expect(verts.count).toBe(3);
    expect(verts.nextOffset).toBe(offset - 4 + 24);
    expect(Array.from(verts.rawInt16)).toEqual([
      -4096, 2048, -8192, 0, 32767, -32768, 0, 123, 0, 0, 4096, -1,
    ]);
    expect(verts.positionsMeters[0]).toBeCloseTo(-1, 6);
    expect(verts.positionsMeters[1]).toBeCloseTo(0.5, 6);
    expect(verts.positionsMeters[2]).toBeCloseTo(-2, 6);
    expect(verts.positionsMeters[8]).toBeCloseTo(1, 6);

    const empty = parseCdoVertices(sub, offset - 4, 0);
    expect(empty.count).toBe(0);
    expect(empty.rawInt16.length).toBe(0);
    expect(empty.positionsMeters.length).toBe(0);
    expect(empty.nextOffset).toBe(offset - 4);

    // Per-LOD scale = 17 applies 2^(17-16) = 2x multiplier to positionsMeters while preserving rawInt16
    expect(computeCdoLodVertexScale(16)).toBe(1);
    expect(computeCdoLodVertexScale(17)).toBe(2);
    const scaled17 = parseCdoVertices(sub, offset - 4, 3, 17);
    expect(Array.from(scaled17.rawInt16)).toEqual(Array.from(verts.rawInt16));
    expect(scaled17.positionsMeters[0]).toBeCloseTo(-2, 6);
    expect(scaled17.positionsMeters[1]).toBeCloseTo(1, 6);
    expect(scaled17.positionsMeters[2]).toBeCloseTo(-4, 6);
    expect(scaled17.positionsMeters[8]).toBeCloseTo(2, 6);
  });

  it('parses normal arrays, tracks low2Bits diagnostics, and throws TruncatedBuffer on short input', () => {
    const buf = new Uint8Array(8);
    const view = new DataView(buf.buffer);
    view.setUint32(0, packNormal(0, 500, 0, 0), true);
    view.setUint32(4, packNormal(0, 0, -500, 2), true);

    const normals = parseCdoNormals(buf, 0, 2);
    expect(normals.count).toBe(2);
    expect(normals.nextOffset).toBe(8);
    expect(normals.nonZeroLow2BitsCount).toBe(1);
    expect(Array.from(normals.vectors)).toEqual([0, 1, 0, 0, 0, -1]);

    expect(() => parseCdoVertices(new Uint8Array(7), 0, 1)).toThrowError(CdoError);
    expect(() => parseCdoNormals(new Uint8Array(3), 0, 1)).toThrowError(CdoError);
  });
});
