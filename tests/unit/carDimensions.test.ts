import { describe, expect, it } from 'vitest';
import {
  CAR_DIMENSIONS_SIZE,
  GTMODE_DATA_TABLE_SPECS,
  GtdbError,
  type GtdbTableSlice,
  decodeCarDimensions,
  decodeCarDimensionsTable,
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

interface CarDimensionsSeed {
  readonly carId: number;
  readonly unk_0x04: number;
  readonly length: number;
  readonly height: number;
  readonly unk_0x0c: number;
  readonly weightKg: number;
  readonly rmWeightMultiplier: number;
  readonly unk_0x11: number;
  readonly unk_0x12: number;
}

function writeCarDimensions(view: DataView, offset: number, seed: CarDimensionsSeed): void {
  view.setUint32(offset + 0x00, seed.carId, true);
  view.setUint32(offset + 0x04, seed.unk_0x04, true);
  view.setUint16(offset + 0x08, seed.length, true);
  view.setUint16(offset + 0x0a, seed.height, true);
  view.setUint16(offset + 0x0c, seed.unk_0x0c, true);
  view.setUint16(offset + 0x0e, seed.weightKg, true);
  view.setUint8(offset + 0x10, seed.rmWeightMultiplier);
  view.setUint8(offset + 0x11, seed.unk_0x11);
  view.setUint16(offset + 0x12, seed.unk_0x12, true);
}

function makeSlice(overrides: Partial<GtdbTableSlice> = {}): GtdbTableSlice {
  return {
    index: 3,
    name: 'CarDimensions',
    offset: 0,
    size: CAR_DIMENSIONS_SIZE,
    elementSize: CAR_DIMENSIONS_SIZE,
    count: 1,
    evidence: 'E3',
    ...overrides,
  };
}

describe('CarDimensions decoder (M5.3)', () => {
  it('matches the GTMODE_DATA_TABLE_SPECS elementSize (0x14 / 20 B)', () => {
    const spec = GTMODE_DATA_TABLE_SPECS.find((s) => s.name === 'CarDimensions');
    expect(spec?.elementSize).toBe(CAR_DIMENSIONS_SIZE);
    expect(CAR_DIMENSIONS_SIZE).toBe(0x14);
  });

  it('decodes every field with exact LE offsets, unsigned carId, and sub-view byteOffset', () => {
    const backing = new Uint8Array(64);
    backing.fill(0xaa);

    const expected: CarDimensionsSeed = {
      carId: 0x8001f7dc,
      unk_0x04: 0xdeadbeef,
      length: 4321,
      height: 1295,
      unk_0x0c: 0x2650,
      weightKg: 1180,
      rmWeightMultiplier: 79,
      unk_0x11: 0x5a,
      unk_0x12: 0xfedc,
    };

    const view = new DataView(backing.buffer, 12, 44);
    writeCarDimensions(view, 8, expected);

    const decoded = decodeCarDimensions(view, 8);
    expect(decoded).toEqual(expected);
  });

  it('handles boundary values (all zeros and all 0xFFs)', () => {
    const buf = new Uint8Array(CAR_DIMENSIONS_SIZE * 2);
    buf.fill(0xff, CAR_DIMENSIONS_SIZE);
    const view = new DataView(buf.buffer);

    expect(decodeCarDimensions(view, 0)).toEqual({
      carId: 0,
      unk_0x04: 0,
      length: 0,
      height: 0,
      unk_0x0c: 0,
      weightKg: 0,
      rmWeightMultiplier: 0,
      unk_0x11: 0,
      unk_0x12: 0,
    });

    expect(decodeCarDimensions(view, CAR_DIMENSIONS_SIZE)).toEqual({
      carId: 0xffffffff,
      unk_0x04: 0xffffffff,
      length: 0xffff,
      height: 0xffff,
      unk_0x0c: 0xffff,
      weightKg: 0xffff,
      rmWeightMultiplier: 0xff,
      unk_0x11: 0xff,
      unk_0x12: 0xffff,
    });
  });

  it('decodes a full table slice including empty tables and subarray offsets', () => {
    const outer = new Uint8Array(128);
    const sub = outer.subarray(16);
    const sliceOffset = 20;

    const first: CarDimensionsSeed = {
      carId: 0x01020304,
      unk_0x04: 1,
      length: 3500,
      height: 1400,
      unk_0x0c: 2400,
      weightKg: 900,
      rmWeightMultiplier: 55,
      unk_0x11: 2,
      unk_0x12: 3,
    };
    const second: CarDimensionsSeed = {
      carId: 0xfedcba98,
      unk_0x04: 0x11223344,
      length: 4800,
      height: 1200,
      unk_0x0c: 2700,
      weightKg: 1550,
      rmWeightMultiplier: 68,
      unk_0x11: 9,
      unk_0x12: 0x7788,
    };

    const view = new DataView(sub.buffer, sub.byteOffset + sliceOffset, CAR_DIMENSIONS_SIZE * 2);
    writeCarDimensions(view, 0, first);
    writeCarDimensions(view, CAR_DIMENSIONS_SIZE, second);

    const rows = decodeCarDimensionsTable(
      sub,
      makeSlice({ offset: sliceOffset, size: CAR_DIMENSIONS_SIZE * 2, count: 2 }),
    );
    expect(rows).toEqual([first, second]);

    const empty = decodeCarDimensionsTable(sub, makeSlice({ offset: 0, size: 0, count: 0 }));
    expect(empty).toEqual([]);
  });

  it('throws typed GtdbError on truncated buffers, bad offsets, and mismatched slices', () => {
    const shortView = new DataView(new Uint8Array(CAR_DIMENSIONS_SIZE - 1).buffer);
    expectGtdbErrorCode(() => decodeCarDimensions(shortView, 0), GtdbError.TruncatedBuffer);

    const exactView = new DataView(new Uint8Array(CAR_DIMENSIONS_SIZE).buffer);
    expectGtdbErrorCode(() => decodeCarDimensions(exactView, -1), GtdbError.OutOfBounds);
    expectGtdbErrorCode(() => decodeCarDimensions(exactView, 1), GtdbError.TruncatedBuffer);

    const bytes = new Uint8Array(CAR_DIMENSIONS_SIZE * 2);
    expectGtdbErrorCode(
      () => decodeCarDimensionsTable(bytes, makeSlice({ elementSize: 0x10 })),
      GtdbError.InvalidLayout,
    );
    expectGtdbErrorCode(
      () => decodeCarDimensionsTable(bytes, makeSlice({ size: CAR_DIMENSIONS_SIZE + 1, count: null })),
      GtdbError.MisalignedTableSize,
    );
    expectGtdbErrorCode(
      () =>
        decodeCarDimensionsTable(
          bytes,
          makeSlice({ offset: CAR_DIMENSIONS_SIZE + 4, size: CAR_DIMENSIONS_SIZE, count: 1 }),
        ),
      GtdbError.TruncatedBuffer,
    );
    expectGtdbErrorCode(
      () => decodeCarDimensionsTable(bytes, makeSlice({ offset: -4 })),
      GtdbError.OutOfBounds,
    );
  });
});
