import { describe, expect, it } from 'vitest';
import {
  CDO_SHADOW_HEADER_BYTES,
  CdoError,
  parseCdoShadowBlock,
} from '../../src/formats/car/cdo';

function packShadowFace(v0: number, v1: number, v2: number, v3: number, flagsRaw: number): number {
  return (
    ((v0 & 0x3f) |
      ((v1 & 0x3f) << 6) |
      ((v2 & 0x3f) << 12) |
      ((v3 & 0x3f) << 18) |
      ((flagsRaw & 0xff) << 24)) >>>
    0
  );
}

describe('CDO shadow block parser (M6.5)', () => {
  it('parses a standard 24-vertex, 2-triangle, 16-quad shadow block to exact EOF', () => {
    const startOffset = 12;
    const vertexCount = 24;
    const triCount = 2;
    const quadCount = 16;
    const payloadBytes = (vertexCount + triCount + quadCount) * 4;
    const buf = new Uint8Array(startOffset + CDO_SHADOW_HEADER_BYTES + payloadBytes);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    view.setUint16(startOffset + 0x00, vertexCount, true);
    view.setUint16(startOffset + 0x02, triCount, true);
    view.setUint16(startOffset + 0x04, quadCount, true);
    view.setUint16(startOffset + 0x06, 0, true);

    // Non-zero lowY/highY allowed (observed in GT2.VOL)
    view.setInt16(startOffset + 0x08, -1900, true); // lowX
    view.setInt16(startOffset + 0x0a, -406, true); // lowY
    view.setInt16(startOffset + 0x0c, -4200, true); // lowZ
    view.setInt16(startOffset + 0x0e, 0, true); // lowW
    view.setInt16(startOffset + 0x10, 1900, true); // highX
    view.setInt16(startOffset + 0x12, -406, true); // highY
    view.setInt16(startOffset + 0x14, 4200, true); // highZ
    view.setInt16(startOffset + 0x16, 0, true); // highW
    view.setUint16(startOffset + 0x18, 17, true);
    view.setUint16(startOffset + 0x1a, 0x124d, true);

    let cursor = startOffset + CDO_SHADOW_HEADER_BYTES;
    for (let i = 0; i < vertexCount; i += 1) {
      const x = i === 0 ? -1900 : i === 1 ? 1900 : (i - 12) * 100;
      const z = i === 0 ? -4200 : i === 1 ? 4200 : (i - 12) * 200;
      view.setInt16(cursor, x, true);
      view.setInt16(cursor + 2, z, true);
      cursor += 4;
    }

    view.setUint32(cursor, packShadowFace(0, 1, 2, 0, 0x80), true);
    view.setUint32(cursor + 4, packShadowFace(3, 4, 5, 0, 0x80), true);
    cursor += 8;

    for (let i = 0; i < quadCount; i += 1) {
      view.setUint32(
        cursor,
        packShadowFace(i, (i + 1) % 24, (i + 2) % 24, (i + 3) % 24, i % 2 === 0 ? 0x00 : 0x80),
        true,
      );
      cursor += 4;
    }

    const sub = buf.subarray(4);
    const shadow = parseCdoShadowBlock(sub, startOffset - 4);
    expect(shadow.endOffset).toBe(sub.byteLength);
    expect(shadow.header.vertexCount).toBe(24);
    expect(shadow.header.triangleCount).toBe(2);
    expect(shadow.header.quadCount).toBe(16);
    expect(shadow.header.boundingBox.low.y).toBe(-406);
    expect(shadow.header.scale).toBe(17);
    expect(shadow.header.unk_0x1a).toBe(0x124d);
    expect(shadow.rawVerticesXZ[0]).toBe(-1900);
    expect(shadow.rawVerticesXZ[1]).toBe(-4200);
    expect(shadow.triangles[0]).toEqual({ vertices: [0, 1, 2, 0], flagsRaw: 0x80 });
    expect(shadow.quads[0]).toEqual({ vertices: [0, 1, 2, 3], flagsRaw: 0x00 });
    expect(shadow.quads[1]?.flagsRaw).toBe(0x80);
  });

  it('supports 48-vertex shadow blocks using 6-bit indices up to 47', () => {
    const vertexCount = 48;
    const triCount = 4;
    const quadCount = 32;
    const buf = new Uint8Array(CDO_SHADOW_HEADER_BYTES + (vertexCount + triCount + quadCount) * 4);
    const view = new DataView(buf.buffer);

    view.setUint16(0x00, vertexCount, true);
    view.setUint16(0x02, triCount, true);
    view.setUint16(0x04, quadCount, true);

    const triOffset = CDO_SHADOW_HEADER_BYTES + vertexCount * 4;
    view.setUint32(triOffset, packShadowFace(44, 45, 47, 0, 0x80), true);
    const quadOffset = triOffset + triCount * 4;
    view.setUint32(quadOffset, packShadowFace(40, 41, 46, 47, 0x00), true);

    const shadow = parseCdoShadowBlock(buf, 0);
    expect(shadow.endOffset).toBe(buf.byteLength);
    expect(shadow.triangles[0]?.vertices).toEqual([44, 45, 47, 0]);
    expect(shadow.quads[0]?.vertices).toEqual([40, 41, 46, 47]);
  });

  it('throws TruncatedBuffer when shadow header or payload is cut short', () => {
    expect(() => parseCdoShadowBlock(new Uint8Array(CDO_SHADOW_HEADER_BYTES - 1), 0)).toThrowError(
      CdoError,
    );

    const shortPayload = new Uint8Array(CDO_SHADOW_HEADER_BYTES + 10);
    const view = new DataView(shortPayload.buffer);
    view.setUint16(0x00, 24, true);
    view.setUint16(0x02, 2, true);
    view.setUint16(0x04, 16, true);
    try {
      parseCdoShadowBlock(shortPayload, 0);
      expect.fail('Expected TruncatedBuffer');
    } catch (error) {
      expect(error).toBeInstanceOf(CdoError);
      expect((error as CdoError).code).toBe(CdoError.TruncatedBuffer);
    }
  });
});
