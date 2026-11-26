import { describe, expect, it } from 'vitest';
import { parseCdp } from '../../src/formats/car/cdp';
import type { CarModelLod } from '../../src/formats/car';
import {
  CarAssetIndex,
  type CarCatalogEntry,
  encodeCarId,
} from '../../src/formats/gtdb';
import type { VolEntry } from '../../src/formats/vol';
import { resolveAutoLodIndex } from '../../src/renderer';
import {
  buildCarBodyOptions,
  filterViewerCars,
  findInitialViewableCar,
  formatPaintSlotLabel,
  samplePaintSlotPreviewCss,
} from '../../src/ui/carViewer';
import { buildSyntheticCdp } from '../fixtures/buildCdp';

function makeCatalogEntry(
  carId: number,
  displayName: string,
  rmBodyIds: readonly number[] = [],
): CarCatalogEntry {
  return {
    carId,
    carIdHex: `0x${(carId >>> 0).toString(16).padStart(8, '0')}`,
    name: {
      displayName,
      firstPart: displayName,
      secondPart: null,
      isFallback: false,
    },
    carData: {
      carId,
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
      nameSecondPartIndex: 0,
      unk_0x40: 0,
      year: 98,
      unk_0x42: 0,
      newPrice: 25000,
    },
    dimensions: null,
    engine: null,
    engineSummary: null,
    gearboxes: [],
    suspensions: [],
    frontTyres: [],
    rearTyres: [],
    racingModifications: rmBodyIds.map((rmBodyId) => ({
      carId,
      price: 50000,
      rmBodyId,
      unk_0x0c: new Uint8Array(16),
    })),
  };
}

function makeVolEntries(files: readonly string[]): VolEntry[] {
  return files.map((path, i) => ({
    path,
    kind: 'file',
    address: (i + 1) * 2048,
    size: 512,
    unixTime: 0,
    isGzip: path.endsWith('.gz'),
  }));
}

describe('CarViewerModel (M7.7)', () => {
  it('resolves Stock and RM bodies cleanly and ignores unresolvable bodies', () => {
    const stockId = encodeCarId('a1000');
    const rmId = encodeCarId('a100r');
    const missingId = encodeCarId('z9999');

    const assetIndex = new CarAssetIndex(
      makeVolEntries([
        'carobj/a1000.cdo.gz',
        'carobj/a1000.cdp.gz',
        'carobj/a1000.cno.gz',
        'carobj/a1000.cnp.gz',
        'carobj/a100r.cdo.gz',
        'carobj/a100r.cdp.gz',
      ]),
    );

    const carWithRm = makeCatalogEntry(stockId, 'Test GT', [rmId, stockId]);
    const bodies = buildCarBodyOptions(carWithRm, assetIndex);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toMatchObject({
      kind: 'stock',
      bodyCode: 'a1000',
      hasDay: true,
      hasNight: true,
    });
    expect(bodies[1]).toMatchObject({
      kind: 'rm',
      bodyCode: 'a100r',
      hasDay: true,
      hasNight: false,
    });

    const missingCar = makeCatalogEntry(missingId, 'Missing Car');
    expect(buildCarBodyOptions(missingCar, assetIndex)).toEqual([]);
    expect(findInitialViewableCar([missingCar, carWithRm], assetIndex)).toBe(carWithRm);
    expect(filterViewerCars([missingCar, carWithRm], assetIndex, 'a100r')).toEqual([carWithRm]);
  });

  it('selects auto LOD by camera distance against lod.maxDistance thresholds', () => {
    const lods = [
      { maxDistance: 5 } as unknown as CarModelLod,
      { maxDistance: 15 } as unknown as CarModelLod,
      { maxDistance: 300 } as unknown as CarModelLod,
    ];

    expect(resolveAutoLodIndex(3.2, lods)).toBe(0);
    expect(resolveAutoLodIndex(5.0, lods)).toBe(0);
    expect(resolveAutoLodIndex(5.1, lods)).toBe(1);
    expect(resolveAutoLodIndex(15.0, lods)).toBe(1);
    expect(resolveAutoLodIndex(25.0, lods)).toBe(2);
    expect(resolveAutoLodIndex(999, lods)).toBe(2);
  });

  it('formats paint labels and extracts representative CSS swatch colors', () => {
    expect(formatPaintSlotLabel(0, 0x30, '0')).toBe('#1 (0)');
    expect(formatPaintSlotLabel(2, 0x61, 'a')).toBe('#3 (a)');
    expect(formatPaintSlotLabel(1, 0x01, null)).toBe('#2 (0x01)');

    const cdp = parseCdp(
      buildSyntheticCdp({
        slots: [
          {
            colorId: 0x30,
            palettes: [[0x0000, 0x001f]],
            paintMasks: [0x0002],
          },
        ],
      }),
    );
    expect(samplePaintSlotPreviewCss(cdp.colorSlots[0]!)).toBe('rgb(255, 0, 0)');
  });
});
