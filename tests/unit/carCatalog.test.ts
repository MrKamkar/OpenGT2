import { describe, expect, it } from 'vitest';
import {
  CarCatalog,
  type CarData,
  type CarDimensions,
  type CarEngineData,
  type CarGearbox,
  type CarRearTyres,
  type CarSuspension,
  type CarTyres,
  buildCarCatalogFromBuffers,
  formatCarIdHex,
  pairGtdbRegionVariants,
  parseUnistrdb,
  selectDefaultGtdbVariant,
} from '../../src/formats/gtdb';
import type { VolEntry } from '../../src/formats/vol';
import {
  buildSyntheticGtmodeData,
  buildSyntheticUnistrdb,
} from '../fixtures/buildGtdb';

function makeFileEntry(path: string): VolEntry {
  return {
    path,
    kind: 'file',
    address: 0x800,
    size: 128,
    unixTime: 946684800,
    isGzip: path.endsWith('.gz'),
  };
}

function makeCarData(overrides: Partial<CarData> & { readonly carId: number }): CarData {
  return {
    brakePart: 0,
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
    clutch: 0,
    unk_0x24: 0,
    differential: 0,
    transmission: 0,
    suspension: 0,
    unk_0x2c: 0,
    frontTyres: 0,
    rearTyres: 0,
    unk_0x34: 0,
    rimsCode3: 0,
    manufacturerId: 1,
    nameFirstPartIndex: 0,
    nameSecondPartIndex: 1,
    unk_0x40: 0,
    year: 98,
    unk_0x42: 0,
    newPrice: 25000,
    ...overrides,
  };
}

function makeDimensions(carId: number, weightKg = 1120): CarDimensions {
  return {
    carId,
    unk_0x04: 0,
    length: 4100,
    height: 1280,
    unk_0x0c: 0,
    weightKg,
    rmWeightMultiplier: 65,
    unk_0x11: 0,
    unk_0x12: 0,
  };
}

function makeEngine(carId: number, ps = 240): CarEngineData {
  return {
    carId,
    engineTypeNameIndex: 2,
    engineTypeName2Index: 3,
    unk_0x08: 0,
    unk_0x0a: 0,
    bandAcceleration: new Array<number>(16).fill(0xffff),
    engineCc: 1998,
    ps,
    maxPowerRpmRaw: 750,
    torqueKgmRaw: 285,
    torqueRpmStringIndex: 4,
    baseUnits: [100, 0, 0, 80, 75],
    bandRpms: new Array<number>(16).fill(0xff),
    bandPointCount: 10,
  };
}

function makeGearbox(carId: number, type: number, price: number): CarGearbox {
  return {
    carId,
    price,
    type,
    unk_0x09: 0,
    unk_0x0a: new Uint8Array(16),
    finalGear: 4100,
    unk_0x1c: 0,
    unk_0x20: 0,
  };
}

function makeSuspension(carId: number, stage: number, price: number): CarSuspension {
  return {
    carId,
    price,
    stage,
    unk_0x09: 0,
    unk_0x0a: 0,
    unk_0x0c: new Uint8Array(64),
  };
}

function makeFrontTyres(carId: number, type: number, price: number): CarTyres {
  return {
    carId,
    price,
    type,
    unk_0x09: 0,
    unk_0x0a: 0x100,
    unk_0x0c: type * 2,
  };
}

function makeRearTyres(carId: number, type: number): CarRearTyres {
  return {
    carId,
    type,
    unk_0x05: 0,
    unk_0x06: 0x100,
    unk_0x08: type * 2,
  };
}

describe('CarCatalog (M5.5)', () => {
  it('joins CarData, dimensions, engine, and multiple part variants by carId with O(1) lookup', () => {
    const strings = parseUnistrdb(
      buildSyntheticUnistrdb(['Proto', 'Alpha', 'I4', 'DOHC', '5500 rpm', 'Beta', '']),
    );

    const catalog = new CarCatalog({
      region: 'eng',
      cars: [
        makeCarData({ carId: 0x01020304, nameFirstPartIndex: 0, nameSecondPartIndex: 1 }),
        makeCarData({
          carId: 0x05060708,
          nameFirstPartIndex: 5,
          nameSecondPartIndex: 6,
          newPrice: 40000,
        }),
      ],
      dimensions: [makeDimensions(0x01020304, 1050), makeDimensions(0x05060708, 1280)],
      engines: [makeEngine(0x01020304, 210), makeEngine(0x05060708, 305)],
      gearboxes: [
        makeGearbox(0x01020304, 0, 0),
        makeGearbox(0x01020304, 1, 2400),
        makeGearbox(0x01020304, 3, 10000),
        makeGearbox(0x05060708, 0, 0),
      ],
      suspensions: [
        makeSuspension(0x01020304, 0, 0),
        makeSuspension(0x01020304, 2, 7500),
      ],
      frontTyres: [
        makeFrontTyres(0x01020304, 0, 0),
        makeFrontTyres(0x01020304, 2, 4800),
        makeFrontTyres(0x01020304, 4, 10200),
      ],
      rearTyres: [
        makeRearTyres(0x01020304, 0),
        makeRearTyres(0x01020304, 2),
      ],
      strings,
    });

    expect(catalog.region).toBe('eng');
    expect(catalog.size).toBe(2);
    expect(catalog.listCars()).toHaveLength(2);
    expect(catalog.hasCar(0x01020304)).toBe(true);
    expect(catalog.hasCar(0x99999999)).toBe(false);
    expect(catalog.hasCar(-1)).toBe(false);

    const first = catalog.getCar(0x01020304);
    expect(first).toBeDefined();
    expect(first?.carIdHex).toBe('0x01020304');
    expect(first?.name).toEqual({
      displayName: 'Proto Alpha',
      firstPart: 'Proto',
      secondPart: 'Alpha',
      isFallback: false,
    });
    expect(first?.dimensions?.weightKg).toBe(1050);
    expect(first?.engine?.ps).toBe(210);
    expect(first?.engineSummary).toEqual({
      typeName: 'I4',
      typeName2: 'DOHC',
      torqueRpmLabel: '5500 rpm',
      maxPowerRpm: 7500,
      torqueKgm: 28.5,
    });
    expect(first?.gearboxes).toHaveLength(3);
    expect(first?.suspensions).toHaveLength(2);
    expect(first?.frontTyres).toHaveLength(3);
    expect(first?.rearTyres).toHaveLength(2);

    const second = catalog.getCar(0x05060708);
    expect(second?.name).toEqual({
      displayName: 'Beta',
      firstPart: 'Beta',
      secondPart: null,
      isFallback: false,
    });
    expect(second?.suspensions).toEqual([]);
    expect(second?.frontTyres).toEqual([]);
    expect(catalog.getCar(0xdeadbeef)).toBeUndefined();
  });

  it('handles missing related rows and falls back to hex carId when unistrdb is absent or indices fail', () => {
    const strings = parseUnistrdb(buildSyntheticUnistrdb(['', '   ']));
    const catalog = new CarCatalog({
      cars: [
        makeCarData({ carId: 0x00abcdef, nameFirstPartIndex: 0, nameSecondPartIndex: 99 }),
      ],
      dimensions: [],
      engines: [],
      gearboxes: [],
      suspensions: [],
      frontTyres: [],
      rearTyres: [],
      strings,
    });

    const car = catalog.getCar(0x00abcdef);
    expect(car?.name).toEqual({
      displayName: '0x00abcdef',
      firstPart: null,
      secondPart: null,
      isFallback: true,
    });
    expect(car?.dimensions).toBeNull();
    expect(car?.engine).toBeNull();
    expect(car?.engineSummary).toBeNull();

    const noStringsCatalog = new CarCatalog({
      cars: [makeCarData({ carId: 0x80000001 })],
      dimensions: [],
      engines: [],
      gearboxes: [],
      suspensions: [],
      frontTyres: [],
      rearTyres: [],
    });
    expect(formatCarIdHex(0x80000001)).toBe('0x80000001');
    expect(noStringsCatalog.getCar(0x80000001)?.name.displayName).toBe('0x80000001');
    expect(noStringsCatalog.getCar(0x80000001)?.name.isFallback).toBe(true);
  });

  it('builds a CarCatalog directly from synthetic gtmode_data and unistrdb binary buffers', () => {
    const gtmodeBuf = buildSyntheticGtmodeData({
      cars: [makeCarData({ carId: 0x11223344, nameFirstPartIndex: 0, nameSecondPartIndex: 1 })],
      dimensions: [makeDimensions(0x11223344, 980)],
      engines: [makeEngine(0x11223344, 185)],
      gearboxes: [makeGearbox(0x11223344, 0, 0), makeGearbox(0x11223344, 3, 9500)],
      suspensions: [makeSuspension(0x11223344, 1, 3200)],
      frontTyres: [makeFrontTyres(0x11223344, 1, 2500)],
      rearTyres: [makeRearTyres(0x11223344, 1)],
    });
    const unistrBuf = buildSyntheticUnistrdb([
      'Concept',
      'Roadster',
      'V6',
      'SOHC',
      '6000 rpm',
    ]);

    const catalog = buildCarCatalogFromBuffers(gtmodeBuf, unistrBuf, 'usa');
    expect(catalog.region).toBe('usa');
    expect(catalog.size).toBe(1);
    const car = catalog.getCar(0x11223344);
    expect(car?.name.displayName).toBe('Concept Roadster');
    expect(car?.dimensions?.weightKg).toBe(980);
    expect(car?.engine?.ps).toBe(185);
    expect(car?.gearboxes).toHaveLength(2);
    expect(car?.suspensions).toHaveLength(1);
    expect(car?.frontTyres).toHaveLength(1);
    expect(car?.rearTyres).toHaveLength(1);
  });

  it('pairs regional gtmode_data and unistrdb entries (including unprefixed JP -> jpn) and selects default', () => {
    const variants = pairGtdbRegionVariants({
      gtmodeData: [
        { kind: 'gtmode_data', region: null, entry: makeFileEntry('carparam/gtmode_data.dat.gz') },
        { kind: 'gtmode_data', region: 'eng', entry: makeFileEntry('carparam/eng_gtmode_data.dat.gz') },
        { kind: 'gtmode_data', region: 'usa', entry: makeFileEntry('carparam/usa_gtmode_data.dat.gz') },
      ],
      gtmodeRace: [],
      unistrdb: [
        { kind: 'unistrdb', region: 'eng', entry: makeFileEntry('carparam/eng_unistrdb.dat.gz') },
        { kind: 'unistrdb', region: 'jpn', entry: makeFileEntry('carparam/jpn_unistrdb.dat.gz') },
        { kind: 'unistrdb', region: 'usa', entry: makeFileEntry('carparam/usa_unistrdb.dat.gz') },
      ],
      arcadeData: [],
      licenseData: [],
    });

    expect(variants).toHaveLength(3);
    expect(variants[0]?.id).toBe('jpn');
    expect(variants[0]?.unistrdb?.path).toBe('carparam/jpn_unistrdb.dat.gz');
    expect(variants[1]?.id).toBe('eng');
    expect(variants[1]?.unistrdb?.path).toBe('carparam/eng_unistrdb.dat.gz');

    expect(selectDefaultGtdbVariant(variants)?.id).toBe('eng');
    const [jpVariant, , usaVariant] = variants;
    if (jpVariant === undefined || usaVariant === undefined) {
      throw new Error('Expected paired jpn and usa variants');
    }
    expect(selectDefaultGtdbVariant([jpVariant, usaVariant])?.id).toBe('usa');
    expect(selectDefaultGtdbVariant([jpVariant])?.id).toBe('jpn');
    expect(selectDefaultGtdbVariant([])).toBeUndefined();
  });
});
