import { describe, expect, it } from 'vitest';
import {
  CAR_SUSPENSION_SIZE,
  CAR_SUSPENSION_UNK_0X0C_LENGTH,
  GTMODE_DATA_TABLE_SPECS,
  GtdbError,
  type GtdbTableSlice,
  decodeCarSuspension,
  decodeCarSuspensionTable,
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

interface CarSuspensionSeed {
  readonly carId: number;
  readonly price: number;
  readonly stage: number;
  readonly unk_0x09: number;
  readonly unk_0x0a: number;
  readonly unk_0x0c: Uint8Array;
}

function writeCarSuspension(view: DataView, offset: number, seed: CarSuspensionSeed): void {
  view.setUint32(offset + 0x00, seed.carId, true);
  view.setInt32(offset + 0x04, seed.price, true);
  view.setUint8(offset + 0x08, seed.stage);
  view.setUint8(offset + 0x09, seed.unk_0x09);
  view.setUint16(offset + 0x0a, seed.unk_0x0a, true);
  for (let i = 0; i < CAR_SUSPENSION_UNK_0X0C_LENGTH; i += 1) {
    view.setUint8(offset + 0x0c + i, seed.unk_0x0c[i] ?? 0);
  }
}

function makeSlice(overrides: Partial<GtdbTableSlice> = {}): GtdbTableSlice {
  return {
    index: 18,
    name: 'CarSuspension',
    offset: 0,
    size: CAR_SUSPENSION_SIZE,
    elementSize: CAR_SUSPENSION_SIZE,
    count: 1,
    evidence: 'E3',
    ...overrides,
  };
}

describe('CarSuspension decoder (M5.3)', () => {
  it('matches the GTMODE_DATA_TABLE_SPECS elementSize (0x4C / 76 B)', () => {
    const spec = GTMODE_DATA_TABLE_SPECS.find((s) => s.name === 'CarSuspension');
    expect(spec?.elementSize).toBe(CAR_SUSPENSION_SIZE);
    expect(CAR_SUSPENSION_SIZE).toBe(0x4c);
    expect(CAR_SUSPENSION_UNK_0X0C_LENGTH).toBe(64);
  });

  it('decodes all fields, signed price vs unsigned carId, and copies unk_0x0c using view.byteOffset', () => {
    const backing = new Uint8Array(160);
    backing.fill(0x77);

    const unkBytes = Uint8Array.from({ length: 64 }, (_, idx) => (0x30 + idx) & 0xff);
    const expected: CarSuspensionSeed = {
      carId: 0x9abcdef0,
      price: -18500,
      stage: 3,
      unk_0x09: 0x17,
      unk_0x0a: 0x89ab,
      unk_0x0c: unkBytes,
    };

    const viewByteOffset = 24;
    const recordOffset = 16;
    const view = new DataView(backing.buffer, viewByteOffset, 100);
    writeCarSuspension(view, recordOffset, expected);

    const decoded = decodeCarSuspension(view, recordOffset);
    expect(decoded.carId).toBe(expected.carId);
    expect(decoded.price).toBe(-18500);
    expect(decoded.stage).toBe(3);
    expect(decoded.unk_0x09).toBe(0x17);
    expect(decoded.unk_0x0a).toBe(0x89ab);
    expect(Array.from(decoded.unk_0x0c)).toEqual(Array.from(unkBytes));

    // Mutating the backing buffer must not affect the copied unk_0x0c array.
    backing.fill(0x00);
    expect(Array.from(decoded.unk_0x0c)).toEqual(Array.from(unkBytes));
  });

  it('handles zero and extreme boundary values', () => {
    const buf = new Uint8Array(CAR_SUSPENSION_SIZE * 2);
    buf.fill(0xff, CAR_SUSPENSION_SIZE);
    const view = new DataView(buf.buffer);

    const zeros = decodeCarSuspension(view, 0);
    expect(zeros.carId).toBe(0);
    expect(zeros.price).toBe(0);
    expect(zeros.stage).toBe(0);
    expect(Array.from(zeros.unk_0x0c)).toEqual(new Array(64).fill(0));

    const allOnes = decodeCarSuspension(view, CAR_SUSPENSION_SIZE);
    expect(allOnes.carId).toBe(0xffffffff);
    expect(allOnes.price).toBe(-1);
    expect(allOnes.stage).toBe(0xff);
    expect(allOnes.unk_0x09).toBe(0xff);
    expect(allOnes.unk_0x0a).toBe(0xffff);
    expect(Array.from(allOnes.unk_0x0c)).toEqual(new Array(64).fill(0xff));
  });

  it('decodes full tables and empty tables via GtdbTableSlice', () => {
    const outer = new Uint8Array(256);
    const sub = outer.subarray(20);
    const sliceOffset = 16;

    const first: CarSuspensionSeed = {
      carId: 0x11111111,
      price: 0,
      stage: 0,
      unk_0x09: 0,
      unk_0x0a: 1,
      unk_0x0c: Uint8Array.from({ length: 64 }, (_, idx) => idx),
    };
    const second: CarSuspensionSeed = {
      carId: 0x11111111,
      price: 16000,
      stage: 3,
      unk_0x09: 2,
      unk_0x0a: 0x2233,
      unk_0x0c: Uint8Array.from({ length: 64 }, (_, idx) => 255 - idx),
    };

    const view = new DataView(sub.buffer, sub.byteOffset + sliceOffset, CAR_SUSPENSION_SIZE * 2);
    writeCarSuspension(view, 0, first);
    writeCarSuspension(view, CAR_SUSPENSION_SIZE, second);

    const rows = decodeCarSuspensionTable(
      sub,
      makeSlice({ offset: sliceOffset, size: CAR_SUSPENSION_SIZE * 2, count: 2 }),
    );
    expect(rows).toEqual([first, second]);

    expect(decodeCarSuspensionTable(sub, makeSlice({ offset: 0, size: 0, count: 0 }))).toEqual([]);
  });

  it('throws GtdbError on truncated buffer, invalid offset, wrong elementSize, and misaligned size', () => {
    const shortView = new DataView(new Uint8Array(CAR_SUSPENSION_SIZE - 1).buffer);
    expectGtdbErrorCode(() => decodeCarSuspension(shortView, 0), GtdbError.TruncatedBuffer);

    const exactView = new DataView(new Uint8Array(CAR_SUSPENSION_SIZE).buffer);
    expectGtdbErrorCode(() => decodeCarSuspension(exactView, -4), GtdbError.OutOfBounds);
    expectGtdbErrorCode(() => decodeCarSuspension(exactView, 1), GtdbError.TruncatedBuffer);

    const bytes = new Uint8Array(CAR_SUSPENSION_SIZE * 2);
    expectGtdbErrorCode(
      () => decodeCarSuspensionTable(bytes, makeSlice({ elementSize: 0x24 })),
      GtdbError.InvalidLayout,
    );
    expectGtdbErrorCode(
      () => decodeCarSuspensionTable(bytes, makeSlice({ size: CAR_SUSPENSION_SIZE + 4, count: null })),
      GtdbError.MisalignedTableSize,
    );
    expectGtdbErrorCode(
      () => decodeCarSuspensionTable(bytes, makeSlice({ offset: CAR_SUSPENSION_SIZE + 8 })),
      GtdbError.TruncatedBuffer,
    );
  });
});
