import { describe, expect, it } from 'vitest';
import {
  CAR_REAR_TYRES_SIZE,
  CAR_TYRES_SIZE,
  GTMODE_DATA_TABLE_SPECS,
  GtdbError,
  type GtdbTableSlice,
  decodeCarRearTyres,
  decodeCarRearTyresTable,
  decodeCarTyres,
  decodeCarTyresTable,
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

interface CarTyresSeed {
  readonly carId: number;
  readonly price: number;
  readonly type: number;
  readonly unk_0x09: number;
  readonly unk_0x0a: number;
  readonly unk_0x0c: number;
}

interface CarRearTyresSeed {
  readonly carId: number;
  readonly type: number;
  readonly unk_0x05: number;
  readonly unk_0x06: number;
  readonly unk_0x08: number;
}

function writeCarTyres(view: DataView, offset: number, seed: CarTyresSeed): void {
  view.setUint32(offset + 0x00, seed.carId, true);
  view.setInt32(offset + 0x04, seed.price, true);
  view.setUint8(offset + 0x08, seed.type);
  view.setUint8(offset + 0x09, seed.unk_0x09);
  view.setUint16(offset + 0x0a, seed.unk_0x0a, true);
  view.setUint32(offset + 0x0c, seed.unk_0x0c, true);
}

function writeCarRearTyres(view: DataView, offset: number, seed: CarRearTyresSeed): void {
  view.setUint32(offset + 0x00, seed.carId, true);
  view.setUint8(offset + 0x04, seed.type);
  view.setUint8(offset + 0x05, seed.unk_0x05);
  view.setUint16(offset + 0x06, seed.unk_0x06, true);
  view.setUint32(offset + 0x08, seed.unk_0x08, true);
}

function makeFrontSlice(overrides: Partial<GtdbTableSlice> = {}): GtdbTableSlice {
  return {
    index: 22,
    name: 'CarTyres',
    offset: 0,
    size: CAR_TYRES_SIZE,
    elementSize: CAR_TYRES_SIZE,
    count: 1,
    evidence: 'E3',
    ...overrides,
  };
}

function makeRearSlice(overrides: Partial<GtdbTableSlice> = {}): GtdbTableSlice {
  return {
    index: 23,
    name: 'CarRearTyres',
    offset: 0,
    size: CAR_REAR_TYRES_SIZE,
    elementSize: CAR_REAR_TYRES_SIZE,
    count: 1,
    evidence: 'E3',
    ...overrides,
  };
}

describe('CarTyres and CarRearTyres decoders (M5.3)', () => {
  it('matches the GTMODE_DATA_TABLE_SPECS elementSizes (0x10 / 16 B and 0x0C / 12 B)', () => {
    const frontSpec = GTMODE_DATA_TABLE_SPECS.find((s) => s.name === 'CarTyres');
    const rearSpec = GTMODE_DATA_TABLE_SPECS.find((s) => s.name === 'CarRearTyres');
    expect(frontSpec?.elementSize).toBe(CAR_TYRES_SIZE);
    expect(rearSpec?.elementSize).toBe(CAR_REAR_TYRES_SIZE);
    expect(CAR_TYRES_SIZE).toBe(0x10);
    expect(CAR_REAR_TYRES_SIZE).toBe(0x0c);
  });

  it('decodes CarTyres and CarRearTyres with exact LE offsets, signed price, and sub-view byteOffset', () => {
    const backing = new Uint8Array(96);
    backing.fill(0xee);

    const expectedFront: CarTyresSeed = {
      carId: 0x8002abcd,
      price: -4200,
      type: 6,
      unk_0x09: 0x12,
      unk_0x0a: 0x7fff,
      unk_0x0c: 0x90000010,
    };
    const expectedRear: CarRearTyresSeed = {
      carId: 0x8002abcd,
      type: 7,
      unk_0x05: 0x34,
      unk_0x06: 0xffff,
      unk_0x08: 0x80000008,
    };

    const view = new DataView(backing.buffer, 16, 64);
    writeCarTyres(view, 8, expectedFront);
    writeCarRearTyres(view, 32, expectedRear);

    expect(decodeCarTyres(view, 8)).toEqual(expectedFront);
    expect(decodeCarRearTyres(view, 32)).toEqual(expectedRear);
  });

  it('handles zero and max boundary values for both structs', () => {
    const frontBuf = new Uint8Array(CAR_TYRES_SIZE * 2);
    frontBuf.fill(0xff, CAR_TYRES_SIZE);
    const frontView = new DataView(frontBuf.buffer);

    expect(decodeCarTyres(frontView, 0)).toEqual({
      carId: 0,
      price: 0,
      type: 0,
      unk_0x09: 0,
      unk_0x0a: 0,
      unk_0x0c: 0,
    });
    expect(decodeCarTyres(frontView, CAR_TYRES_SIZE)).toEqual({
      carId: 0xffffffff,
      price: -1,
      type: 0xff,
      unk_0x09: 0xff,
      unk_0x0a: 0xffff,
      unk_0x0c: 0xffffffff,
    });

    const rearBuf = new Uint8Array(CAR_REAR_TYRES_SIZE * 2);
    rearBuf.fill(0xff, CAR_REAR_TYRES_SIZE);
    const rearView = new DataView(rearBuf.buffer);

    expect(decodeCarRearTyres(rearView, 0)).toEqual({
      carId: 0,
      type: 0,
      unk_0x05: 0,
      unk_0x06: 0,
      unk_0x08: 0,
    });
    expect(decodeCarRearTyres(rearView, CAR_REAR_TYRES_SIZE)).toEqual({
      carId: 0xffffffff,
      type: 0xff,
      unk_0x05: 0xff,
      unk_0x06: 0xffff,
      unk_0x08: 0xffffffff,
    });
  });

  it('decodes full tables and empty tables via GtdbTableSlice', () => {
    const outer = new Uint8Array(128);
    const sub = outer.subarray(12);

    const f1: CarTyresSeed = { carId: 1, price: 0, type: 0, unk_0x09: 0, unk_0x0a: 0, unk_0x0c: 0 };
    const f2: CarTyresSeed = {
      carId: 1,
      price: 18000,
      type: 5,
      unk_0x09: 0,
      unk_0x0a: 0x100,
      unk_0x0c: 0x0a,
    };
    const r1: CarRearTyresSeed = { carId: 1, type: 0, unk_0x05: 0, unk_0x06: 0, unk_0x08: 0 };
    const r2: CarRearTyresSeed = {
      carId: 1,
      type: 5,
      unk_0x05: 0,
      unk_0x06: 0x200,
      unk_0x08: 0x0a,
    };

    const frontOff = 8;
    const rearOff = 48;
    const fView = new DataView(sub.buffer, sub.byteOffset + frontOff, CAR_TYRES_SIZE * 2);
    writeCarTyres(fView, 0, f1);
    writeCarTyres(fView, CAR_TYRES_SIZE, f2);

    const rView = new DataView(sub.buffer, sub.byteOffset + rearOff, CAR_REAR_TYRES_SIZE * 2);
    writeCarRearTyres(rView, 0, r1);
    writeCarRearTyres(rView, CAR_REAR_TYRES_SIZE, r2);

    expect(
      decodeCarTyresTable(sub, makeFrontSlice({ offset: frontOff, size: CAR_TYRES_SIZE * 2, count: 2 })),
    ).toEqual([f1, f2]);
    expect(
      decodeCarRearTyresTable(
        sub,
        makeRearSlice({ offset: rearOff, size: CAR_REAR_TYRES_SIZE * 2, count: 2 }),
      ),
    ).toEqual([r1, r2]);

    expect(decodeCarTyresTable(sub, makeFrontSlice({ offset: 0, size: 0, count: 0 }))).toEqual([]);
    expect(decodeCarRearTyresTable(sub, makeRearSlice({ offset: 0, size: 0, count: 0 }))).toEqual([]);
  });

  it('throws GtdbError on truncated buffer, invalid offset, cross-mismatched elementSize, and misaligned size', () => {
    expectGtdbErrorCode(
      () => decodeCarTyres(new DataView(new Uint8Array(CAR_TYRES_SIZE - 1).buffer), 0),
      GtdbError.TruncatedBuffer,
    );
    expectGtdbErrorCode(
      () => decodeCarRearTyres(new DataView(new Uint8Array(CAR_REAR_TYRES_SIZE - 1).buffer), 0),
      GtdbError.TruncatedBuffer,
    );

    expectGtdbErrorCode(
      () => decodeCarTyres(new DataView(new Uint8Array(CAR_TYRES_SIZE).buffer), -1),
      GtdbError.OutOfBounds,
    );
    expectGtdbErrorCode(
      () => decodeCarRearTyres(new DataView(new Uint8Array(CAR_REAR_TYRES_SIZE).buffer), 1),
      GtdbError.TruncatedBuffer,
    );

    const bytes = new Uint8Array(64);
    expectGtdbErrorCode(() => decodeCarTyresTable(bytes, makeRearSlice()), GtdbError.InvalidLayout);
    expectGtdbErrorCode(() => decodeCarRearTyresTable(bytes, makeFrontSlice()), GtdbError.InvalidLayout);
    expectGtdbErrorCode(
      () => decodeCarTyresTable(bytes, makeFrontSlice({ size: CAR_TYRES_SIZE + 1, count: null })),
      GtdbError.MisalignedTableSize,
    );
    expectGtdbErrorCode(
      () => decodeCarRearTyresTable(bytes, makeRearSlice({ size: CAR_REAR_TYRES_SIZE + 1, count: null })),
      GtdbError.MisalignedTableSize,
    );
    expectGtdbErrorCode(
      () => decodeCarTyresTable(bytes, makeFrontSlice({ offset: 60 })),
      GtdbError.TruncatedBuffer,
    );
  });
});
