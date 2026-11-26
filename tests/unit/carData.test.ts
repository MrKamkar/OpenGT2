import { describe, expect, it } from 'vitest';
import {
  CAR_DATA_SIZE,
  GTMODE_DATA_TABLE_SPECS,
  GtdbError,
  type GtdbTableSlice,
  decodeCarData,
  decodeCarDataTable,
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

interface CarDataSeed {
  readonly carId: number;
  readonly brakePart: number;
  readonly specialCar: number;
  readonly weightPartId: number;
  readonly unk_0x0c: number;
  readonly unk_0x0e: number;
  readonly enginePartId: number;
  readonly unk_0x12: number;
  readonly unk_0x14: number;
  readonly unk_0x18: number;
  readonly turboPart: number;
  readonly drivetrainPart: number;
  readonly flywheel: number;
  readonly clutch: number;
  readonly unk_0x24: number;
  readonly differential: number;
  readonly transmission: number;
  readonly suspension: number;
  readonly unk_0x2c: number;
  readonly frontTyres: number;
  readonly rearTyres: number;
  readonly unk_0x34: number;
  readonly rimsCode3: number;
  readonly manufacturerId: number;
  readonly nameFirstPartIndex: number;
  readonly nameSecondPartIndex: number;
  readonly unk_0x40: number;
  readonly year: number;
  readonly unk_0x42: number;
  readonly newPrice: number;
}

function writeCarData(view: DataView, offset: number, seed: CarDataSeed): void {
  view.setUint32(offset + 0x00, seed.carId, true);
  view.setInt16(offset + 0x04, seed.brakePart, true);
  view.setInt32(offset + 0x06, seed.specialCar, true);
  view.setUint16(offset + 0x0a, seed.weightPartId, true);
  view.setUint16(offset + 0x0c, seed.unk_0x0c, true);
  view.setUint16(offset + 0x0e, seed.unk_0x0e, true);
  view.setUint16(offset + 0x10, seed.enginePartId, true);
  view.setUint16(offset + 0x12, seed.unk_0x12, true);
  view.setInt32(offset + 0x14, seed.unk_0x14, true);
  view.setInt32(offset + 0x18, seed.unk_0x18, true);
  view.setUint16(offset + 0x1c, seed.turboPart, true);
  view.setUint16(offset + 0x1e, seed.drivetrainPart, true);
  view.setUint16(offset + 0x20, seed.flywheel, true);
  view.setUint16(offset + 0x22, seed.clutch, true);
  view.setUint16(offset + 0x24, seed.unk_0x24, true);
  view.setUint16(offset + 0x26, seed.differential, true);
  view.setUint16(offset + 0x28, seed.transmission, true);
  view.setUint16(offset + 0x2a, seed.suspension, true);
  view.setUint32(offset + 0x2c, seed.unk_0x2c, true);
  view.setUint16(offset + 0x30, seed.frontTyres, true);
  view.setUint16(offset + 0x32, seed.rearTyres, true);
  view.setUint32(offset + 0x34, seed.unk_0x34, true);
  view.setUint16(offset + 0x38, seed.rimsCode3, true);
  view.setUint16(offset + 0x3a, seed.manufacturerId, true);
  view.setUint16(offset + 0x3c, seed.nameFirstPartIndex, true);
  view.setUint16(offset + 0x3e, seed.nameSecondPartIndex, true);
  view.setUint8(offset + 0x40, seed.unk_0x40);
  view.setUint8(offset + 0x41, seed.year);
  view.setUint16(offset + 0x42, seed.unk_0x42, true);
  view.setUint32(offset + 0x44, seed.newPrice, true);
}

function makeSlice(overrides: Partial<GtdbTableSlice> = {}): GtdbTableSlice {
  return {
    index: 30,
    name: 'CarData',
    offset: 0,
    size: CAR_DATA_SIZE,
    elementSize: CAR_DATA_SIZE,
    count: 1,
    evidence: 'E3',
    ...overrides,
  };
}

describe('CarData decoder (M5.3)', () => {
  it('matches the GTMODE_DATA_TABLE_SPECS elementSize (0x48 / 72 B)', () => {
    const spec = GTMODE_DATA_TABLE_SPECS.find((s) => s.name === 'CarData');
    expect(spec?.elementSize).toBe(CAR_DATA_SIZE);
    expect(CAR_DATA_SIZE).toBe(0x48);
  });

  it('decodes all 30 fields with exact LE offsets, signed/unsigned types, and sub-view byteOffset', () => {
    const backing = new Uint8Array(128);
    backing.fill(0xbb);

    const expected: CarDataSeed = {
      carId: 0x80041234,
      brakePart: -321,
      specialCar: -1,
      weightPartId: 101,
      unk_0x0c: 102,
      unk_0x0e: 103,
      enginePartId: 104,
      unk_0x12: 105,
      unk_0x14: -106,
      unk_0x18: -107,
      turboPart: 108,
      drivetrainPart: 109,
      flywheel: 110,
      clutch: 111,
      unk_0x24: 112,
      differential: 113,
      transmission: 114,
      suspension: 115,
      unk_0x2c: 0x90000116,
      frontTyres: 117,
      rearTyres: 118,
      unk_0x34: 0xa0000119,
      rimsCode3: 120,
      manufacturerId: 121,
      nameFirstPartIndex: 122,
      nameSecondPartIndex: 123,
      unk_0x40: 1,
      year: 99,
      unk_0x42: 125,
      newPrice: 0xf0000000,
    };

    const view = new DataView(backing.buffer, 16, 96);
    writeCarData(view, 12, expected);

    expect(decodeCarData(view, 12)).toEqual(expected);
  });

  it('handles all-zero and all-0xFF boundary values', () => {
    const buf = new Uint8Array(CAR_DATA_SIZE * 2);
    buf.fill(0xff, CAR_DATA_SIZE);
    const view = new DataView(buf.buffer);

    const zeros = decodeCarData(view, 0);
    expect(zeros.carId).toBe(0);
    expect(zeros.brakePart).toBe(0);
    expect(zeros.specialCar).toBe(0);
    expect(zeros.newPrice).toBe(0);

    const allOnes = decodeCarData(view, CAR_DATA_SIZE);
    expect(allOnes.carId).toBe(0xffffffff);
    expect(allOnes.brakePart).toBe(-1);
    expect(allOnes.specialCar).toBe(-1);
    expect(allOnes.unk_0x14).toBe(-1);
    expect(allOnes.unk_0x18).toBe(-1);
    expect(allOnes.unk_0x2c).toBe(0xffffffff);
    expect(allOnes.unk_0x34).toBe(0xffffffff);
    expect(allOnes.unk_0x40).toBe(0xff);
    expect(allOnes.year).toBe(0xff);
    expect(allOnes.newPrice).toBe(0xffffffff);
  });

  it('decodes full tables and empty tables via GtdbTableSlice', () => {
    const outer = new Uint8Array(256);
    const sub = outer.subarray(20);
    const sliceOffset = 16;

    const first: CarDataSeed = {
      carId: 0x00010001,
      brakePart: 1,
      specialCar: 0,
      weightPartId: 0,
      unk_0x0c: 0,
      unk_0x0e: 0,
      enginePartId: 0,
      unk_0x12: 0,
      unk_0x14: 0,
      unk_0x18: 0,
      turboPart: 0,
      drivetrainPart: 0,
      flywheel: 0,
      clutch: 1,
      unk_0x24: 0,
      differential: 2,
      transmission: 3,
      suspension: 4,
      unk_0x2c: 0,
      frontTyres: 5,
      rearTyres: 5,
      unk_0x34: 0,
      rimsCode3: 6,
      manufacturerId: 7,
      nameFirstPartIndex: 8,
      nameSecondPartIndex: 9,
      unk_0x40: 0,
      year: 95,
      unk_0x42: 0,
      newPrice: 25000,
    };
    const second: CarDataSeed = {
      ...first,
      carId: 0x00010002,
      specialCar: 1,
      unk_0x40: 1,
      year: 98,
      newPrice: 500000,
    };

    const view = new DataView(sub.buffer, sub.byteOffset + sliceOffset, CAR_DATA_SIZE * 2);
    writeCarData(view, 0, first);
    writeCarData(view, CAR_DATA_SIZE, second);

    expect(
      decodeCarDataTable(sub, makeSlice({ offset: sliceOffset, size: CAR_DATA_SIZE * 2, count: 2 })),
    ).toEqual([first, second]);

    expect(decodeCarDataTable(sub, makeSlice({ offset: 0, size: 0, count: 0 }))).toEqual([]);
  });

  it('throws GtdbError on truncated buffer, invalid offset, wrong elementSize, and misaligned size', () => {
    const shortView = new DataView(new Uint8Array(CAR_DATA_SIZE - 1).buffer);
    expectGtdbErrorCode(() => decodeCarData(shortView, 0), GtdbError.TruncatedBuffer);

    const exactView = new DataView(new Uint8Array(CAR_DATA_SIZE).buffer);
    expectGtdbErrorCode(() => decodeCarData(exactView, -1), GtdbError.OutOfBounds);
    expectGtdbErrorCode(() => decodeCarData(exactView, 4), GtdbError.TruncatedBuffer);

    const bytes = new Uint8Array(CAR_DATA_SIZE * 2);
    expectGtdbErrorCode(
      () => decodeCarDataTable(bytes, makeSlice({ elementSize: 0x14 })),
      GtdbError.InvalidLayout,
    );
    expectGtdbErrorCode(
      () => decodeCarDataTable(bytes, makeSlice({ size: CAR_DATA_SIZE + 2, count: null })),
      GtdbError.MisalignedTableSize,
    );
    expectGtdbErrorCode(
      () => decodeCarDataTable(bytes, makeSlice({ offset: CAR_DATA_SIZE + 8 })),
      GtdbError.TruncatedBuffer,
    );
  });
});
