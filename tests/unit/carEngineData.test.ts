import { describe, expect, it } from 'vitest';
import {
  CAR_ENGINE_BAND_COUNT,
  CAR_ENGINE_BASE_UNITS_LENGTH,
  CAR_ENGINE_DATA_SIZE,
  GTMODE_DATA_TABLE_SPECS,
  GtdbError,
  type GtdbTableSlice,
  decodeCarEngineData,
  decodeCarEngineDataTable,
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

interface CarEngineDataSeed {
  readonly carId: number;
  readonly engineTypeNameIndex: number;
  readonly engineTypeName2Index: number;
  readonly unk_0x08: number;
  readonly unk_0x0a: number;
  readonly bandAcceleration: readonly number[];
  readonly engineCc: number;
  readonly ps: number;
  readonly maxPowerRpmRaw: number;
  readonly torqueKgmRaw: number;
  readonly torqueRpmStringIndex: number;
  readonly baseUnits: readonly number[];
  readonly bandRpms: readonly number[];
  readonly bandPointCount: number;
}

function writeCarEngineData(view: DataView, offset: number, seed: CarEngineDataSeed): void {
  view.setUint32(offset + 0x00, seed.carId, true);
  view.setUint16(offset + 0x04, seed.engineTypeNameIndex, true);
  view.setUint16(offset + 0x06, seed.engineTypeName2Index, true);
  view.setUint16(offset + 0x08, seed.unk_0x08, true);
  view.setUint16(offset + 0x0a, seed.unk_0x0a, true);
  for (let i = 0; i < CAR_ENGINE_BAND_COUNT; i += 1) {
    view.setUint16(offset + 0x0c + i * 2, seed.bandAcceleration[i] ?? 0, true);
  }
  view.setUint16(offset + 0x2c, seed.engineCc, true);
  view.setUint16(offset + 0x2e, seed.ps, true);
  view.setUint16(offset + 0x30, seed.maxPowerRpmRaw, true);
  view.setUint16(offset + 0x32, seed.torqueKgmRaw, true);
  view.setUint16(offset + 0x34, seed.torqueRpmStringIndex, true);
  for (let i = 0; i < CAR_ENGINE_BASE_UNITS_LENGTH; i += 1) {
    view.setUint8(offset + 0x36 + i, seed.baseUnits[i] ?? 0);
  }
  for (let i = 0; i < CAR_ENGINE_BAND_COUNT; i += 1) {
    view.setUint8(offset + 0x3b + i, seed.bandRpms[i] ?? 0);
  }
  view.setUint8(offset + 0x4b, seed.bandPointCount);
}

function makeSlice(overrides: Partial<GtdbTableSlice> = {}): GtdbTableSlice {
  return {
    index: 6,
    name: 'CarEngineData',
    offset: 0,
    size: CAR_ENGINE_DATA_SIZE,
    elementSize: CAR_ENGINE_DATA_SIZE,
    count: 1,
    evidence: 'E3',
    ...overrides,
  };
}

describe('CarEngineData decoder (M5.3)', () => {
  it('matches the GTMODE_DATA_TABLE_SPECS elementSize (0x4C / 76 B)', () => {
    const spec = GTMODE_DATA_TABLE_SPECS.find((s) => s.name === 'CarEngineData');
    expect(spec?.elementSize).toBe(CAR_ENGINE_DATA_SIZE);
    expect(CAR_ENGINE_DATA_SIZE).toBe(0x4c);
    expect(CAR_ENGINE_BAND_COUNT).toBe(16);
    expect(CAR_ENGINE_BASE_UNITS_LENGTH).toBe(5);
  });

  it('decodes all 14 fields and fixed internal arrays with sub-view byteOffset', () => {
    const backing = new Uint8Array(128);
    backing.fill(0x55);

    const expected: CarEngineDataSeed = {
      carId: 0x91234567,
      engineTypeNameIndex: 54,
      engineTypeName2Index: 55,
      unk_0x08: 0x1234,
      unk_0x0a: 0x5678,
      bandAcceleration: [
        903, 984, 1046, 1083, 1108, 1173, 1237, 1300, 1272, 1247, 1194, 1096, 989, 0xffff, 0xffff,
        0xffff,
      ],
      engineCc: 1498,
      ps: 100,
      maxPowerRpmRaw: 600,
      torqueKgmRaw: 130,
      torqueRpmStringIndex: 57,
      baseUnits: [100, 250, 60, 70, 70],
      bandRpms: [10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 0xff, 0xff, 0xff],
      bandPointCount: 13,
    };

    const view = new DataView(backing.buffer, 16, 100);
    writeCarEngineData(view, 12, expected);

    const decoded = decodeCarEngineData(view, 12);
    expect(decoded).toEqual(expected);
  });

  it('handles zero and max boundary values cleanly', () => {
    const buf = new Uint8Array(CAR_ENGINE_DATA_SIZE * 2);
    buf.fill(0xff, CAR_ENGINE_DATA_SIZE);
    const view = new DataView(buf.buffer);

    const zeroDecoded = decodeCarEngineData(view, 0);
    expect(zeroDecoded.carId).toBe(0);
    expect(zeroDecoded.bandAcceleration).toEqual(new Array(16).fill(0));
    expect(zeroDecoded.baseUnits).toEqual(new Array(5).fill(0));
    expect(zeroDecoded.bandRpms).toEqual(new Array(16).fill(0));
    expect(zeroDecoded.bandPointCount).toBe(0);

    const maxDecoded = decodeCarEngineData(view, CAR_ENGINE_DATA_SIZE);
    expect(maxDecoded.carId).toBe(0xffffffff);
    expect(maxDecoded.bandAcceleration).toEqual(new Array(16).fill(0xffff));
    expect(maxDecoded.baseUnits).toEqual(new Array(5).fill(0xff));
    expect(maxDecoded.bandRpms).toEqual(new Array(16).fill(0xff));
    expect(maxDecoded.bandPointCount).toBe(0xff);
    expect(maxDecoded.engineCc).toBe(0xffff);
  });

  it('decodes full tables and empty tables via GtdbTableSlice', () => {
    const outer = new Uint8Array(256);
    const sub = outer.subarray(24);
    const sliceOffset = 16;

    const first: CarEngineDataSeed = {
      carId: 0x00112233,
      engineTypeNameIndex: 10,
      engineTypeName2Index: 11,
      unk_0x08: 12,
      unk_0x0a: 13,
      bandAcceleration: Array.from({ length: 16 }, (_, idx) => 800 + idx * 20),
      engineCc: 1998,
      ps: 280,
      maxPowerRpmRaw: 650,
      torqueKgmRaw: 380,
      torqueRpmStringIndex: 42,
      baseUnits: [1, 2, 3, 4, 5],
      bandRpms: Array.from({ length: 16 }, (_, idx) => 10 + idx * 5),
      bandPointCount: 16,
    };
    const second: CarEngineDataSeed = {
      ...first,
      carId: 0x8899aabb,
      ps: 450,
      bandPointCount: 11,
    };

    const view = new DataView(sub.buffer, sub.byteOffset + sliceOffset, CAR_ENGINE_DATA_SIZE * 2);
    writeCarEngineData(view, 0, first);
    writeCarEngineData(view, CAR_ENGINE_DATA_SIZE, second);

    const rows = decodeCarEngineDataTable(
      sub,
      makeSlice({ offset: sliceOffset, size: CAR_ENGINE_DATA_SIZE * 2, count: 2 }),
    );
    expect(rows).toEqual([first, second]);

    expect(decodeCarEngineDataTable(sub, makeSlice({ offset: 0, size: 0, count: 0 }))).toEqual([]);
  });

  it('throws GtdbError on truncated buffer, negative offset, wrong elementSize, and misaligned size', () => {
    const shortView = new DataView(new Uint8Array(CAR_ENGINE_DATA_SIZE - 1).buffer);
    expectGtdbErrorCode(() => decodeCarEngineData(shortView, 0), GtdbError.TruncatedBuffer);

    const exactView = new DataView(new Uint8Array(CAR_ENGINE_DATA_SIZE).buffer);
    expectGtdbErrorCode(() => decodeCarEngineData(exactView, -2), GtdbError.OutOfBounds);
    expectGtdbErrorCode(() => decodeCarEngineData(exactView, 4), GtdbError.TruncatedBuffer);

    const bytes = new Uint8Array(CAR_ENGINE_DATA_SIZE * 2);
    expectGtdbErrorCode(
      () => decodeCarEngineDataTable(bytes, makeSlice({ elementSize: 0x14 })),
      GtdbError.InvalidLayout,
    );
    expectGtdbErrorCode(
      () => decodeCarEngineDataTable(bytes, makeSlice({ size: CAR_ENGINE_DATA_SIZE + 2, count: null })),
      GtdbError.MisalignedTableSize,
    );
    expectGtdbErrorCode(
      () => decodeCarEngineDataTable(bytes, makeSlice({ offset: CAR_ENGINE_DATA_SIZE + 8 })),
      GtdbError.TruncatedBuffer,
    );
  });
});
