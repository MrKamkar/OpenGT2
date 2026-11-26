import { describe, expect, it } from 'vitest';
import {
  CDO_LOD0_DEFAULT_OFFSET,
  CDO_LOD_HEADER_BYTES,
  CDO_LOD_TABLE_ENTRIES_OFFSET,
  CDO_LOD_TABLE_OFFSET,
  CdoError,
  parseCdoLodHeader,
  parseCdoLodTable,
} from '../../src/formats/car/cdo';

function buildLodTableBuffer(entries: readonly { zero: number; maxDistance: number; offset: number }[]): Uint8Array {
  const len = CDO_LOD_TABLE_ENTRIES_OFFSET + entries.length * 8;
  const buf = new Uint8Array(len);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  view.setUint32(CDO_LOD_TABLE_OFFSET, entries.length, true);
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    const off = CDO_LOD_TABLE_ENTRIES_OFFSET + i * 8;
    view.setUint16(off, entry.zero, true);
    view.setUint16(off + 2, entry.maxDistance, true);
    view.setUint32(off + 4, entry.offset, true);
  }
  return buf;
}

describe('CDO LOD table and header parser (M6.2)', () => {
  it('parses standard 3-entry LOD table reaching exact offset 0x884', () => {
    const buf = buildLodTableBuffer([
      { zero: 0, maxDistance: 5, offset: 0 },
      { zero: 0, maxDistance: 15, offset: 0x80123456 },
      { zero: 0, maxDistance: 300, offset: 0x80234567 },
    ]);

    const table = parseCdoLodTable(buf);
    expect(table.lodCount).toBe(3);
    expect(table.nextOffset).toBe(CDO_LOD0_DEFAULT_OFFSET);
    expect(table.entries).toEqual([
      { zero: 0, maxDistance: 5, offset: 0 },
      { zero: 0, maxDistance: 15, offset: 0x80123456 },
      { zero: 0, maxDistance: 300, offset: 0x80234567 },
    ]);
  });

  it('supports variable lodCount and respects non-zero Uint8Array byteOffset', () => {
    const raw = buildLodTableBuffer([
      { zero: 0, maxDistance: 10, offset: 0 },
      { zero: 0, maxDistance: 200, offset: 0 },
    ]);
    const outer = new Uint8Array(raw.byteLength + 16);
    outer.set(raw, 8);
    const sub = outer.subarray(8, 8 + raw.byteLength);

    const table = parseCdoLodTable(sub);
    expect(table.lodCount).toBe(2);
    expect(table.nextOffset).toBe(CDO_LOD_TABLE_ENTRIES_OFFSET + 16);
  });

  it('throws TruncatedBuffer when LOD table header or entries are truncated', () => {
    expect(() => parseCdoLodTable(new Uint8Array(CDO_LOD_TABLE_ENTRIES_OFFSET - 1))).toThrowError(
      CdoError,
    );

    const bad = new Uint8Array(CDO_LOD_TABLE_ENTRIES_OFFSET + 8);
    new DataView(bad.buffer).setUint32(CDO_LOD_TABLE_OFFSET, 3, true);
    try {
      parseCdoLodTable(bad);
      expect.fail('Expected TruncatedBuffer');
    } catch (error) {
      expect(error).toBeInstanceOf(CdoError);
      expect((error as CdoError).code).toBe(CdoError.TruncatedBuffer);
    }
  });

  it('parses a 0x50-byte LOD header sequentially with signed bounding box and scale fields', () => {
    const offset = 32;
    const buf = new Uint8Array(offset + CDO_LOD_HEADER_BYTES + 16);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

    view.setUint16(offset + 0x00, 120, true);
    view.setUint16(offset + 0x02, 85, true);
    view.setUint16(offset + 0x04, 12, true);
    view.setUint16(offset + 0x06, 34, true);
    view.setUint16(offset + 0x08, 0, true);
    view.setUint16(offset + 0x0a, 0, true);
    view.setUint16(offset + 0x0c, 56, true);
    view.setUint16(offset + 0x0e, 78, true);
    view.setUint32(offset + 0x10, 0, true);

    view.setUint32(offset + 0x14, 0x50, true);
    for (let i = 1; i < 10; i += 1) {
      view.setUint32(offset + 0x14 + i * 4, 0x80000000 + i * 0x100, true);
    }

    // Bounding box low / high XYZW
    view.setInt16(offset + 0x3c, -3500, true);
    view.setInt16(offset + 0x3e, -120, true);
    view.setInt16(offset + 0x40, -8900, true);
    view.setInt16(offset + 0x42, 0, true);
    view.setInt16(offset + 0x44, 3500, true);
    view.setInt16(offset + 0x46, 5400, true);
    view.setInt16(offset + 0x48, 8900, true);
    view.setInt16(offset + 0x4a, 0, true);

    view.setUint16(offset + 0x4c, 17, true);
    view.setUint16(offset + 0x4e, 0x13e8, true);

    const lodHeader = parseCdoLodHeader(buf, offset);
    expect(lodHeader.headerOffset).toBe(offset);
    expect(lodHeader.dataOffset).toBe(offset + CDO_LOD_HEADER_BYTES);
    expect(lodHeader.vertexCount).toBe(120);
    expect(lodHeader.normalCount).toBe(85);
    expect(lodHeader.triCount).toBe(12);
    expect(lodHeader.quadCount).toBe(34);
    expect(lodHeader.uvTriCount).toBe(56);
    expect(lodHeader.uvQuadCount).toBe(78);
    expect(lodHeader.verticesOffset).toBe(0x50);
    expect(lodHeader.sectionOffsets.length).toBe(10);
    expect(lodHeader.boundingBox).toEqual({
      low: { x: -3500, y: -120, z: -8900, w: 0 },
      high: { x: 3500, y: 5400, z: 8900, w: 0 },
    });
    expect(lodHeader.scale).toBe(17);
    expect(lodHeader.unk_0x4e).toBe(0x13e8);
  });

  it('throws InvalidVerticesOffset when verticesOffset is not 0x50 and TruncatedBuffer on short input', () => {
    const buf = new Uint8Array(CDO_LOD_HEADER_BYTES);
    new DataView(buf.buffer).setUint32(0x14, 0x54, true);

    try {
      parseCdoLodHeader(buf, 0);
      expect.fail('Expected InvalidVerticesOffset');
    } catch (error) {
      expect(error).toBeInstanceOf(CdoError);
      expect((error as CdoError).code).toBe(CdoError.InvalidVerticesOffset);
    }

    try {
      parseCdoLodHeader(buf, 4);
      expect.fail('Expected TruncatedBuffer');
    } catch (error) {
      expect(error).toBeInstanceOf(CdoError);
      expect((error as CdoError).code).toBe(CdoError.TruncatedBuffer);
    }
  });
});
