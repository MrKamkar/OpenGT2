import { describe, expect, it } from 'vitest';
import {
  STRUCT_MAX_HEX_FIELD_BYTES,
  type StructSchema,
  computeStructPageRange,
  decodeStructSlice,
  getFieldByteSize,
  parseStructSchemaJson,
  serializeStructSchemaJson,
  validateStructSchema,
} from '../../src/tools/structview';

function buildTwoRecordSample(): Uint8Array {
  // Base offset 0x04, 2 records of stride 0x20 (32 B) = 68 bytes total.
  const buf = new Uint8Array(0x04 + 0x40);
  const view = new DataView(buf.buffer);

  // Record 0 at 0x04
  const r0 = 0x04;
  view.setUint8(r0 + 0, 0xfe);
  view.setInt8(r0 + 1, -2);
  view.setUint16(r0 + 2, 0x1234, true);
  view.setInt16(r0 + 4, -4096, true); // fixed4_12 = -1.0
  view.setUint32(r0 + 8, 0x80000001, true);
  view.setInt32(r0 + 12, -123456, true);
  view.setFloat32(r0 + 16, 3.5, true);
  view.setInt16(r0 + 20, 0x4000, true); // fixed1_15 = 0.5
  buf.set([0xaa, 0xbb, 0xcc], r0 + 22);

  // Record 1 at 0x24
  const r1 = 0x24;
  view.setUint8(r1 + 0, 0x05);
  view.setInt8(r1 + 1, 12);
  view.setUint16(r1 + 2, 0xabcd, true);
  view.setInt16(r1 + 4, 4096, true); // fixed4_12 = +1.0
  view.setUint32(r1 + 8, 42, true);
  view.setInt32(r1 + 12, 777, true);
  view.setFloat32(r1 + 16, -2.25, true);
  view.setInt16(r1 + 20, -32768, true); // fixed1_15 = -1.0
  buf.set([0x10, 0x20, 0x30], r1 + 22);

  return buf;
}

describe('structview decoder (M3.5)', () => {
  const schema: StructSchema = {
    name: 'sample_record',
    baseOffset: 0x04,
    stride: 0x20,
    count: 2,
    fields: [
      { name: 'u8_val', offset: 0, type: 'u8' },
      { name: 's8_val', offset: 1, type: 's8' },
      { name: 'u16_val', offset: 2, type: 'u16' },
      { name: 's16_val', offset: 4, type: 's16' },
      { name: 'u32_val', offset: 8, type: 'u32' },
      { name: 's32_val', offset: 12, type: 's32' },
      { name: 'f32_val', offset: 16, type: 'float32' },
      { name: 'q412_val', offset: 4, type: 'fixed4_12' },
      { name: 'q115_val', offset: 20, type: 'fixed1_15' },
      { name: 'raw_hex', offset: 22, type: 'hex', length: 3 },
    ],
  };

  it('decodes all LE numeric, PS1 fixed-point, and short hex fields across rows', () => {
    const full = buildTwoRecordSample();
    // Slice starting exactly at baseOffset (0x04) to verify sliceStartOffset mapping
    const slice = full.subarray(0x04);
    const rows = decodeStructSlice(slice, 0x04, schema, 0, 2);

    expect(rows).toHaveLength(2);
    expect(rows[0]?.index).toBe(0);
    expect(rows[0]?.offset).toBe(0x04);
    expect(rows[0]?.values.map((v) => v.rawNumber)).toEqual([
      0xfe,
      -2,
      0x1234,
      -4096,
      0x80000001,
      -123456,
      3.5,
      -1,
      0.5,
      null,
    ]);
    expect(rows[0]?.values[9]?.formatted).toBe('AA BB CC');
    expect(rows[0]?.values[9]?.truncated).toBe(false);

    expect(rows[1]?.index).toBe(1);
    expect(rows[1]?.offset).toBe(0x24);
    expect(rows[1]?.values[0]?.rawNumber).toBe(5);
    expect(rows[1]?.values[6]?.rawNumber).toBeCloseTo(-2.25, 5);
    expect(rows[1]?.values[7]?.rawNumber).toBeCloseTo(1.0, 6);
    expect(rows[1]?.values[8]?.rawNumber).toBeCloseTo(-1.0, 6);
    expect(rows[1]?.values[9]?.formatted).toBe('10 20 30');
  });

  it('marks fields extending past end of buffer as truncated without throwing', () => {
    const full = buildTwoRecordSample();
    // Cut off partway into record 1 (at 0x24 + 6 = 0x2A -> slice length 0x26)
    const partial = full.subarray(0x04, 0x2a);
    const rows = decodeStructSlice(partial, 0x04, schema, 0, 2);

    expect(rows).toHaveLength(2);
    // Record 1: first 4 fields (up to offset 4 + 2 = 6) fit, u32 at offset 8 is truncated
    expect(rows[1]?.values[0]?.truncated).toBe(false);
    expect(rows[1]?.values[3]?.truncated).toBe(false);
    expect(rows[1]?.values[4]?.truncated).toBe(true);
    expect(rows[1]?.values[4]?.rawNumber).toBeNull();
    expect(rows[1]?.values[4]?.formatted).toBe('—');
    expect(rows[1]?.values[9]?.truncated).toBe(true);
  });

  it('computes clamped pagination ranges for large counts', () => {
    const p0 = computeStructPageRange(0x100, 32, 125, 0, 50);
    expect(p0).toEqual({
      pageIndex: 0,
      totalPages: 3,
      startIndex: 0,
      endIndex: 50,
      byteStart: 0x100,
      byteEnd: 0x100 + 50 * 32,
    });

    const pLast = computeStructPageRange(0x100, 32, 125, 99, 50);
    expect(pLast).toEqual({
      pageIndex: 2,
      totalPages: 3,
      startIndex: 100,
      endIndex: 125,
      byteStart: 0x100 + 100 * 32,
      byteEnd: 0x100 + 125 * 32,
    });
  });

  it('validates schema boundaries and field sizes strictly', () => {
    expect(getFieldByteSize({ name: 'h', offset: 0, type: 'hex' })).toBe(4);
    expect(() =>
      getFieldByteSize({
        name: 'too_big_hex',
        offset: 0,
        type: 'hex',
        length: STRUCT_MAX_HEX_FIELD_BYTES + 1,
      }),
    ).toThrow(/hex/i);

    expect(() =>
      validateStructSchema({
        name: 'bad_stride',
        baseOffset: 0,
        stride: 0,
        count: 1,
        fields: [{ name: 'a', offset: 0, type: 'u8' }],
      }),
    ).toThrow(/stride/i);

    expect(() =>
      validateStructSchema({
        name: 'overflow_field',
        baseOffset: 0,
        stride: 4,
        count: 1,
        fields: [{ name: 'a', offset: 2, type: 'u32' }],
      }),
    ).toThrow(/wykracza/i);

    expect(() =>
      validateStructSchema({
        name: 'empty_fields',
        baseOffset: 0,
        stride: 4,
        count: 1,
        fields: [],
      }),
    ).toThrow(/co najmniej jedno pole/i);
  });
});

describe('structview JSON schema serialization & parsing (M3.5)', () => {
  it('round-trips a schema via JSON including hex metadata and optional hex length', () => {
    const schema: StructSchema = {
      name: 'car_entry',
      baseOffset: 0x40,
      stride: 0x20,
      count: 32,
      fields: [
        { name: 'id', offset: 0, type: 'u16' },
        { name: 'scale', offset: 4, type: 'fixed4_12' },
        { name: 'tag', offset: 8, type: 'hex', length: 6 },
      ],
    };

    const json = serializeStructSchemaJson(schema);
    const parsedObj = JSON.parse(json) as Record<string, unknown>;
    expect(parsedObj['schemaVersion']).toBe(1);
    expect(parsedObj['endianness']).toBe('little');
    expect(parsedObj['baseOffsetHex']).toBe('0x40');
    expect(parsedObj['strideHex']).toBe('0x20');

    const roundTripped = parseStructSchemaJson(json);
    expect(roundTripped).toEqual(schema);
  });

  it('accepts hex string offsets on import and rejects malformed JSON or invalid schemas', () => {
    const imported = parseStructSchemaJson(
      JSON.stringify({
        name: 'manual_struct',
        baseOffset: '0x100',
        stride: '0x10',
        count: 4,
        fields: [
          { name: 'flags', offset: '0x0', type: 'u16' },
          { name: 'val', offset: '0x4', type: 'float32' },
        ],
      }),
    );
    expect(imported.baseOffset).toBe(0x100);
    expect(imported.stride).toBe(0x10);
    expect(imported.fields[1]?.offset).toBe(4);

    expect(() => parseStructSchemaJson('{not json')).toThrow(/JSON/i);
    expect(() =>
      parseStructSchemaJson(JSON.stringify({ endianness: 'big', baseOffset: 0, stride: 4, count: 1, fields: [] })),
    ).toThrow(/endianness|kolejność/i);
    expect(() =>
      parseStructSchemaJson(
        JSON.stringify({
          name: 'bad',
          baseOffset: 0,
          stride: 4,
          count: 1,
          fields: [{ name: 'x', offset: 0, type: 'bogus_type' }],
        }),
      ),
    ).toThrow(/typ/i);
  });
});
