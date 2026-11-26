import { describe, expect, it } from 'vitest';
import {
  CAR_GEARBOX_SIZE,
  CAR_GEARBOX_UNK_0X0A_LENGTH,
  GTMODE_DATA_TABLE_SPECS,
  GtdbError,
  type GtdbTableSlice,
  decodeCarGearbox,
  decodeCarGearboxTable,
} from '../../src/formats/gtdb';

function expectGtdbErrorCode(fn: () => unknown, expectedCode: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(GtdbError);
  expect((caught as GtdbError).code).toBe(expectedCode);
}

interface CarGearboxSeed {
  readonly carId: number;
  readonly price: number;
  readonly type: number;
  readonly unk_0x09: number;
  readonly unk_0x0a: Uint8Array;
  readonly finalGear: number;
  readonly unk_0x1c: number;
  readonly unk_0x20: number;
}

function writeCarGearbox(view: DataView, offset: number, seed: CarGearboxSeed): void {
  view.setUint32(offset + 0x00, seed.carId, true);
  view.setInt32(offset + 0x04, seed.price, true);
  view.setUint8(offset + 0x08, seed.type);
  view.setUint8(offset + 0x09, seed.unk_0x09);
  for (let i = 0; i < CAR_GEARBOX_UNK_0X0A_LENGTH; i += 1) {
    view.setUint8(offset + 0x0a + i, seed.unk_0x0a[i] ?? 0);
  }
  view.setUint16(offset + 0x1a, seed.finalGear, true);
  view.setInt32(offset + 0x1c, seed.unk_0x1c, true);
  view.setInt32(offset + 0x20, seed.unk_0x20, true);
}

function makeSlice(overrides: Partial<GtdbTableSlice> = {}): GtdbTableSlice {
  return {
    index: 17,
    name: 'CarGearbox',
    offset: 0,
    size: CAR_GEARBOX_SIZE,
    elementSize: CAR_GEARBOX_SIZE,
    count: 1,
    evidence: 'E3',
    ...overrides,
  };
}

describe('CarGearbox decoder (M5.3)', () => {
  it('matches the GTMODE_DATA_TABLE_SPECS elementSize (0x24 / 36 B)', () => {
    const spec = GTMODE_DATA_TABLE_SPECS.find((s) => s.name === 'CarGearbox');
    expect(spec?.elementSize).toBe(CAR_GEARBOX_SIZE);
    expect(CAR_GEARBOX_SIZE).toBe(0x24);
    expect(CAR_GEARBOX_UNK_0X0A_LENGTH).toBe(16);
  });

  it('decodes all fields, signed vs unsigned types, and copies unk_0x0a using view.byteOffset', () => {
    const backing = new Uint8Array(128);
    backing.fill(0xcc);

    const unkBytes = Uint8Array.from({ length: 16 }, (_, idx) => 0xa0 + idx);
    const expected: CarGearboxSeed = {
      carId: 0x80001234,
      price: -2500,
      type: 3,
      unk_0x09: 0x42,
      unk_0x0a: unkBytes,
      finalGear: 4111,
      unk_0x1c: -123456,
      unk_0x20: 0x7fffffff,
    };

    const viewByteOffset = 20;
    const recordOffset = 12;
    const view = new DataView(backing.buffer, viewByteOffset, 64);
    writeCarGearbox(view, recordOffset, expected);

    const decoded = decodeCarGearbox(view, recordOffset);
    expect(decoded.carId).toBe(expected.carId);
    expect(decoded.price).toBe(-2500);
    expect(decoded.type).toBe(3);
    expect(decoded.unk_0x09).toBe(0x42);
    expect(Array.from(decoded.unk_0x0a)).toEqual(Array.from(unkBytes));
    expect(decoded.finalGear).toBe(4111);
    expect(decoded.unk_0x1c).toBe(-123456);
    expect(decoded.unk_0x20).toBe(0x7fffffff);

    // Mutating the backing buffer must not affect the copied unk_0x0a array.
    backing.fill(0x00);
    expect(Array.from(decoded.unk_0x0a)).toEqual(Array.from(unkBytes));
  });

  it('handles zero and extreme signed/unsigned boundary values', () => {
    const buf = new Uint8Array(CAR_GEARBOX_SIZE * 2);
    buf.fill(0xff, CAR_GEARBOX_SIZE);
    const view = new DataView(buf.buffer);

    const zeros = decodeCarGearbox(view, 0);
    expect(zeros.carId).toBe(0);
    expect(zeros.price).toBe(0);
    expect(zeros.finalGear).toBe(0);
    expect(Array.from(zeros.unk_0x0a)).toEqual(new Array(16).fill(0));

    const allOnes = decodeCarGearbox(view, CAR_GEARBOX_SIZE);
    expect(allOnes.carId).toBe(0xffffffff);
    expect(allOnes.price).toBe(-1);
    expect(allOnes.type).toBe(0xff);
    expect(allOnes.finalGear).toBe(0xffff);
    expect(allOnes.unk_0x1c).toBe(-1);
    expect(allOnes.unk_0x20).toBe(-1);
    expect(Array.from(allOnes.unk_0x0a)).toEqual(new Array(16).fill(0xff));
  });

  it('decodes full tables and empty tables via GtdbTableSlice', () => {
    const outer = new Uint8Array(128);
    const sub = outer.subarray(16);
    const sliceOffset = 12;

    const first: CarGearboxSeed = {
      carId: 0x01020304,
      price: 0,
      type: 0,
      unk_0x09: 0,
      unk_0x0a: Uint8Array.from({ length: 16 }, (_, idx) => idx),
      finalGear: 3500,
      unk_0x1c: 100,
      unk_0x20: 200,
    };
    const second: CarGearboxSeed = {
      carId: 0x01020304,
      price: 10500,
      type: 3,
      unk_0x09: 1,
      unk_0x0a: Uint8Array.from({ length: 16 }, (_, idx) => 0x80 + idx),
      finalGear: 4500,
      unk_0x1c: -10,
      unk_0x20: 300,
    };

    const view = new DataView(sub.buffer, sub.byteOffset + sliceOffset, CAR_GEARBOX_SIZE * 2);
    writeCarGearbox(view, 0, first);
    writeCarGearbox(view, CAR_GEARBOX_SIZE, second);

    const rows = decodeCarGearboxTable(
      sub,
      makeSlice({ offset: sliceOffset, size: CAR_GEARBOX_SIZE * 2, count: 2 }),
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual(first);
    expect(rows[1]).toEqual(second);

    expect(decodeCarGearboxTable(sub, makeSlice({ offset: 0, size: 0, count: 0 }))).toEqual([]);
  });

  it('throws GtdbError on truncated buffer, invalid offset, wrong elementSize, and misaligned size', () => {
    const shortView = new DataView(new Uint8Array(CAR_GEARBOX_SIZE - 1).buffer);
    expectGtdbErrorCode(() => decodeCarGearbox(shortView, 0), GtdbError.TruncatedBuffer);

    const exactView = new DataView(new Uint8Array(CAR_GEARBOX_SIZE).buffer);
    expectGtdbErrorCode(() => decodeCarGearbox(exactView, -1), GtdbError.OutOfBounds);
    expectGtdbErrorCode(() => decodeCarGearbox(exactView, 2), GtdbError.TruncatedBuffer);

    const bytes = new Uint8Array(CAR_GEARBOX_SIZE * 2);
    expectGtdbErrorCode(
      () => decodeCarGearboxTable(bytes, makeSlice({ elementSize: 0x10 })),
      GtdbError.InvalidLayout,
    );
    expectGtdbErrorCode(
      () => decodeCarGearboxTable(bytes, makeSlice({ size: CAR_GEARBOX_SIZE + 3, count: null })),
      GtdbError.MisalignedTableSize,
    );
    expectGtdbErrorCode(
      () => decodeCarGearboxTable(bytes, makeSlice({ offset: CAR_GEARBOX_SIZE + 8 })),
      GtdbError.TruncatedBuffer,
    );
  });
});
