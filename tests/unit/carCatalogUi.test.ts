import { describe, expect, it } from 'vitest';
import { CarCatalog, type CarData, type CarDimensions, type CarEngineData } from '../../src/formats/gtdb';
import {
  buildCarDetailSections,
  filterAndSortCars,
  formatCarYear,
  formatHexBytesPreview,
} from '../../src/ui/carCatalog';

function makeCatalog(): CarCatalog {
  const cars: CarData[] = [
    {
      carId: 0x10000001,
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
      rimsCode3: 2,
      manufacturerId: 5,
      nameFirstPartIndex: 0,
      nameSecondPartIndex: 1,
      unk_0x40: 0,
      year: 97,
      unk_0x42: 0,
      newPrice: 28000,
    },
    {
      carId: 0x10000002,
      brakePart: 1,
      specialCar: 1,
      weightPartId: 1,
      unk_0x0c: 0,
      unk_0x0e: 0,
      enginePartId: 1,
      unk_0x12: 0,
      unk_0x14: 0,
      unk_0x18: 0,
      turboPart: 1,
      drivetrainPart: 1,
      flywheel: 0,
      clutch: 1,
      unk_0x24: 0,
      differential: 1,
      transmission: 1,
      suspension: 1,
      unk_0x2c: 0,
      frontTyres: 1,
      rearTyres: 1,
      unk_0x34: 1,
      rimsCode3: 4,
      manufacturerId: 9,
      nameFirstPartIndex: 2,
      nameSecondPartIndex: 3,
      unk_0x40: 1,
      year: 0,
      unk_0x42: 0,
      newPrice: 120000,
    },
  ];
  const dimensions: CarDimensions[] = [
    {
      carId: 0x10000001,
      unk_0x04: 0,
      length: 4200,
      height: 1300,
      unk_0x0c: 0,
      weightKg: 1180,
      rmWeightMultiplier: 70,
      unk_0x11: 0,
      unk_0x12: 0,
    },
  ];
  const engines: CarEngineData[] = [
    {
      carId: 0x10000001,
      engineTypeNameIndex: 4,
      engineTypeName2Index: 5,
      unk_0x08: 0,
      unk_0x0a: 0,
      bandAcceleration: new Array<number>(16).fill(0xffff),
      engineCc: 1998,
      ps: 280,
      maxPowerRpmRaw: 720,
      torqueKgmRaw: 350,
      torqueRpmStringIndex: 6,
      baseUnits: [100, 0, 0, 75, 70],
      bandRpms: new Array<number>(16).fill(0xff),
      bandPointCount: 11,
    },
  ];

  return new CarCatalog({
    region: 'eng',
    cars,
    dimensions,
    engines,
    gearboxes: [
      {
        carId: 0x10000001,
        price: 0,
        type: 0,
        unk_0x09: 0,
        unk_0x0a: new Uint8Array(16),
        finalGear: 4100,
        unk_0x1c: 0,
        unk_0x20: 0,
      },
    ],
    suspensions: [],
    frontTyres: [],
    rearTyres: [],
    strings: {
      fileSize: 64,
      count: 7,
      strings: ['Proto', 'Coupe', 'Omega', 'GT', 'I4', 'DOHC', '5000 rpm'],
    },
  });
}

describe('CarCatalog UI model (M5.6)', () => {
  it('filters by name, hex carId, or engine type and sorts deterministically with nulls last', () => {
    const entries = makeCatalog().listCars();

    expect(filterAndSortCars(entries, 'dohc', 'name', 'asc').map((e) => e.carId)).toEqual([
      0x10000001,
    ]);
    expect(filterAndSortCars(entries, '10000002', 'name', 'asc').map((e) => e.carId)).toEqual([
      0x10000002,
    ]);
    expect(filterAndSortCars(entries, '', 'newPrice', 'desc').map((e) => e.carId)).toEqual([
      0x10000002,
      0x10000001,
    ]);
    // Car 0x10000002 has null ps/weightKg/year=0 -> always sorts after 0x10000001 even in desc mode
    expect(filterAndSortCars(entries, '', 'ps', 'desc').map((e) => e.carId)).toEqual([
      0x10000001,
      0x10000002,
    ]);
    expect(filterAndSortCars(entries, '', 'weightKg', 'asc').map((e) => e.carId)).toEqual([
      0x10000001,
      0x10000002,
    ]);
  });

  it('formats years, byte previews, and builds E3/E2/E0 detail sections', () => {
    expect(formatCarYear(0)).toBe('—');
    expect(formatCarYear(5)).toBe('05');
    expect(formatCarYear(98)).toBe('98');
    expect(formatHexBytesPreview(new Uint8Array([0x0a, 0xff]), 8)).toBe('0a ff');

    const first = makeCatalog().getCar(0x10000001);
    if (first === undefined) {
      throw new Error('Expected synthetic car');
    }
    const sections = buildCarDetailSections(first);
    const allFields = sections.flatMap((section) => section.fields);
    expect(allFields.some((f) => f.evidence === 'E3')).toBe(true);
    expect(allFields.some((f) => f.evidence === 'E2')).toBe(true);
    expect(allFields.some((f) => f.evidence === 'E0' && f.label.startsWith('unk_'))).toBe(true);
  });
});
