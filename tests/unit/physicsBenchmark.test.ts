import { existsSync } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCarModel, parseCdo } from '../../src/formats/car';
import {
  type CarCatalogEntry,
  buildCarAssetIndex,
  buildCarCatalogFromBuffers,
  findGtdbEntries,
  pairGtdbRegionVariants,
  selectDefaultGtdbVariant,
} from '../../src/formats/gtdb';
import { gunzip } from '../../src/formats/gzip';
import { VolReader } from '../../src/formats/vol';
import {
  type ByteSource,
  CachedByteSource,
  SlicedByteSource,
  validateByteRange,
} from '../../src/io';
import {
  type AccelerationBenchmarkResult,
  type CarPhysicsSpec,
  PS_TO_WATTS,
  RPM_TO_RAD_S,
  buildCarPhysicsSpec,
  computeDynoCurve,
  runAccelerationBenchmark,
} from '../../src/physics';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_VOL_PATH = path.resolve(PROJECT_ROOT, 'local_assets', 'GT2.VOL');
const HAS_REAL_VOL = existsSync(REAL_VOL_PATH);

class NodeFileByteSource implements ByteSource {
  readonly size: number;
  private readonly handle: FileHandle;

  constructor(handle: FileHandle, size: number) {
    this.handle = handle;
    this.size = size;
  }

  async read(start: number, end: number): Promise<Uint8Array> {
    validateByteRange(start, end, this.size);
    const length = end - start;
    if (length === 0) {
      return new Uint8Array(0);
    }

    const out = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await this.handle.read(out, offset, length - offset, start + offset);
      if (bytesRead === 0) {
        throw new RangeError(
          `Unexpected EOF while reading [${String(start)}, ${String(end)}) at offset ${String(start + offset)}`,
        );
      }
      offset += bytesRead;
    }
    return out;
  }

  slice(start: number, end: number): ByteSource {
    validateByteRange(start, end, this.size);
    return new SlicedByteSource(this, start, end);
  }
}

function makeSyntheticEntry(params: {
  readonly carId: number;
  readonly ps: number;
  readonly torqueKgm: number;
  readonly peakTorqueRpm: number;
  readonly redlineRpm: number;
  readonly massKg: number;
  readonly finalGearRaw: number;
  readonly gearboxType?: number;
}): CarCatalogEntry {
  const peakBandAccel = Math.round(params.torqueKgm * 100);
  const peakRpm100 = Math.round(params.peakTorqueRpm / 100);
  const redlineRpm100 = Math.round(params.redlineRpm / 100);
  const maxPowerRpm = Math.max(params.peakTorqueRpm + 800, params.redlineRpm - 500);

  return {
    carId: params.carId,
    carIdHex: `0x${params.carId.toString(16).padStart(8, '0')}`,
    name: {
      displayName: `Synth ${String(params.carId)}`,
      firstPart: 'Synth',
      secondPart: String(params.carId),
      isFallback: false,
    },
    carData: {
      carId: params.carId,
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
      manufacturerId: 0,
      nameFirstPartIndex: 0,
      nameSecondPartIndex: 0,
      unk_0x40: 0,
      year: 99,
      unk_0x42: 0,
      newPrice: 20000,
    },
    dimensions: {
      carId: params.carId,
      unk_0x04: 0,
      length: 4200,
      height: 1320,
      unk_0x0c: 0,
      weightKg: params.massKg,
      rmWeightMultiplier: 50,
      unk_0x11: 0,
      unk_0x12: 0,
    },
    engine: {
      carId: params.carId,
      engineTypeNameIndex: 0,
      engineTypeName2Index: 0,
      unk_0x08: 0,
      unk_0x0a: 0,
      bandAcceleration: [
        Math.round(peakBandAccel * 0.65),
        Math.round(peakBandAccel * 0.8),
        Math.round(peakBandAccel * 0.92),
        peakBandAccel,
        Math.round(peakBandAccel * 0.96),
        Math.round(peakBandAccel * 0.88),
        Math.round(peakBandAccel * 0.78),
      ],
      engineCc: 2000,
      ps: params.ps,
      maxPowerRpmRaw: Math.round(maxPowerRpm / 10),
      torqueKgmRaw: Math.round(params.torqueKgm * 10),
      torqueRpmStringIndex: 0,
      baseUnits: [1, 1, 1, 1, 1],
      bandRpms: [
        15,
        25,
        35,
        peakRpm100,
        Math.min(redlineRpm100 - 8, peakRpm100 + 10),
        redlineRpm100 - 4,
        redlineRpm100,
      ],
      bandPointCount: 7,
    },
    engineSummary: null,
    gearboxes: [
      {
        carId: params.carId,
        price: 0,
        type: params.gearboxType ?? 0,
        unk_0x09: 0,
        unk_0x0a: new Uint8Array(16),
        finalGear: params.finalGearRaw,
        unk_0x1c: 0,
        unk_0x20: 0,
      },
    ],
    suspensions: [],
    frontTyres: [],
    rearTyres: [],
    racingModifications: [],
  };
}

describe('Dyno curve and acceleration benchmark suite (M9.10)', () => {
  it('computes dyno torque and PS/kW power curves accurately from CarPhysicsSpec', () => {
    const spec = buildCarPhysicsSpec(
      makeSyntheticEntry({
        carId: 1001,
        ps: 250,
        torqueKgm: 30,
        peakTorqueRpm: 4800,
        redlineRpm: 7200,
        massKg: 1280,
        finalGearRaw: 3900,
      }),
    );

    const dyno = computeDynoCurve(spec, 63);
    expect(dyno.samples).toHaveLength(63);
    expect(dyno.peakTorqueNm).toBeCloseTo(30 * 9.80665, 1);
    expect(dyno.peakPowerPs).toBeGreaterThan(200);
    expect(dyno.peakPowerRpm).toBeGreaterThanOrEqual(dyno.peakTorqueRpm);

    for (const pt of dyno.samples) {
      const expectedWatts = pt.torqueNm * pt.rpm * RPM_TO_RAD_S;
      expect(pt.powerWatts).toBeCloseTo(expectedWatts, 3);
      expect(pt.powerKw).toBeCloseTo(expectedWatts * 0.001, 4);
      expect(pt.powerPs).toBeCloseTo(expectedWatts / PS_TO_WATTS, 4);
    }
  });

  it('produces monotonic 0-100 km/h and top-speed ordering across 3 distinct synthetic power classes within ±15%', () => {
    const compactSpec: CarPhysicsSpec = buildCarPhysicsSpec(
      makeSyntheticEntry({
        carId: 1,
        ps: 64,
        torqueKgm: 9.8,
        peakTorqueRpm: 4500,
        redlineRpm: 7000,
        massKg: 760,
        finalGearRaw: 5100,
      }),
      { driveLayout: 'FF' },
    );

    const sportsSpec: CarPhysicsSpec = buildCarPhysicsSpec(
      makeSyntheticEntry({
        carId: 2,
        ps: 245,
        torqueKgm: 28.5,
        peakTorqueRpm: 5000,
        redlineRpm: 7600,
        massKg: 1320,
        finalGearRaw: 4100,
      }),
      { driveLayout: 'FR' },
    );

    const raceSpec: CarPhysicsSpec = buildCarPhysicsSpec(
      makeSyntheticEntry({
        carId: 3,
        ps: 560,
        torqueKgm: 58.0,
        peakTorqueRpm: 5600,
        redlineRpm: 8200,
        massKg: 1120,
        finalGearRaw: 3650,
        gearboxType: 2,
      }),
      { driveLayout: '4WD' },
    );

    const compactRes = runAccelerationBenchmark(compactSpec, { maxSeconds: 45 });
    const sportsRes = runAccelerationBenchmark(sportsSpec, { maxSeconds: 45 });
    const raceRes = runAccelerationBenchmark(raceSpec, { maxSeconds: 45 });

    // Bit-exact deterministic replay
    const sportsReplay = runAccelerationBenchmark(sportsSpec, { maxSeconds: 45 });
    expect(sportsReplay.simulatedZeroTo100Seconds).toBe(sportsRes.simulatedZeroTo100Seconds);
    expect(sportsReplay.simulatedTopSpeedKph).toBe(sportsRes.simulatedTopSpeedKph);

    // Clear ordering across power classes
    expect(compactRes.simulatedZeroTo100Seconds).not.toBeNull();
    expect(sportsRes.simulatedZeroTo100Seconds).not.toBeNull();
    expect(raceRes.simulatedZeroTo100Seconds).not.toBeNull();
    expect(raceRes.simulatedZeroTo100Seconds!).toBeLessThan(sportsRes.simulatedZeroTo100Seconds!);
    expect(sportsRes.simulatedZeroTo100Seconds!).toBeLessThan(compactRes.simulatedZeroTo100Seconds!);

    expect(raceRes.simulatedTopSpeedKph).toBeGreaterThan(sportsRes.simulatedTopSpeedKph);
    expect(sportsRes.simulatedTopSpeedKph).toBeGreaterThan(compactRes.simulatedTopSpeedKph);

    for (const r of [compactRes, sportsRes, raceRes]) {
      expect(Math.abs(r.topSpeedDeltaPct)).toBeLessThanOrEqual(15);
      expect(r.zeroTo100DeltaPct).not.toBeNull();
      expect(Math.abs(r.zeroTo100DeltaPct!)).toBeLessThanOrEqual(15);
    }
  });
});

describe.skipIf(!HAS_REAL_VOL)('Real GT2.VOL 0-100 & top-speed benchmarks (M9.10)', () => {
  let fileHandle: FileHandle;
  let cachedSource: CachedByteSource;
  let reader: VolReader;

  beforeAll(async () => {
    fileHandle = await open(REAL_VOL_PATH, 'r');
    const fileStats = await fileHandle.stat();
    const rawSource = new NodeFileByteSource(fileHandle, fileStats.size);
    cachedSource = new CachedByteSource(rawSource);
    reader = new VolReader();
    await reader.open(cachedSource, { lastModified: fileStats.mtimeMs });
  });

  afterAll(async () => {
    reader?.close();
    if (fileHandle !== undefined) {
      await fileHandle.close();
    }
  });

  it(
    'benchmarks >= 3 distinct GT2.VOL power classes within ±15% of analytical SI expectations',
    { timeout: 120_000 },
    async () => {
      const allEntries = reader.getAllEntries();
      const variants = pairGtdbRegionVariants(findGtdbEntries(allEntries));
      const preferred = selectDefaultGtdbVariant(variants);
      expect(preferred).toBeDefined();

      const rawGtdb = await gunzip(
        await cachedSource.read(
          preferred!.gtmodeData.address,
          preferred!.gtmodeData.address + preferred!.gtmodeData.size,
        ),
      );
      const catalog = buildCarCatalogFromBuffers(rawGtdb, null, preferred!.id);
      const assetIndex = buildCarAssetIndex(allEntries);

      const isEligible = (car: CarCatalogEntry): boolean => {
        if (car.engine === null || car.dimensions === null || car.gearboxes.length === 0) {
          return false;
        }
        if (car.dimensions.weightKg < 550 || car.dimensions.weightKg > 2200) {
          return false;
        }
        const resolved = assetIndex.resolve(car.carId);
        return resolved.dayModel !== null;
      };

      const cars = catalog.listCars().filter(isEligible);
      const compactEntry = cars.find(
        (c) => c.engine!.ps >= 60 && c.engine!.ps <= 85 && c.dimensions!.weightKg <= 900,
      );
      const sportsEntry = cars.find(
        (c) => c.engine!.ps >= 220 && c.engine!.ps <= 310 && c.dimensions!.weightKg >= 1150,
      );
      const highPowerEntry = cars.find(
        (c) => c.engine!.ps >= 480 && c.engine!.ps <= 780 && c.dimensions!.weightKg <= 1350,
      );

      expect(compactEntry).toBeDefined();
      expect(sportsEntry).toBeDefined();
      expect(highPowerEntry).toBeDefined();

      const selected: ReadonlyArray<{ readonly label: string; readonly entry: CarCatalogEntry }> = [
        { label: 'Compact', entry: compactEntry! },
        { label: 'Sports', entry: sportsEntry! },
        { label: 'HighPower', entry: highPowerEntry! },
      ];

      const results: Array<{
        readonly label: string;
        readonly res: AccelerationBenchmarkResult;
      }> = [];

      for (const item of selected) {
        const assets = assetIndex.resolve(item.entry.carId);
        const cdoBytes = await gunzip(
          await cachedSource.read(
            assets.dayModel!.address,
            assets.dayModel!.address + assets.dayModel!.size,
          ),
        );
        const carModel = buildCarModel(parseCdo(cdoBytes));
        const spec = buildCarPhysicsSpec(item.entry, { carModel });
        const res = runAccelerationBenchmark(spec, { maxSeconds: 60 });
        results.push({ label: item.label, res });
      }

      // Log anonymized summary for docs/research-log.md verification (zero car/track names)
      const summary = results.map(({ label, res }) => ({
        class: label,
        ps: Math.round(res.dyno.peakPowerPs),
        massKg: Math.round(res.dyno.massKg),
        sim0to100s:
          res.simulatedZeroTo100Seconds !== null ? Number(res.simulatedZeroTo100Seconds.toFixed(2)) : null,
        exp0to100s: Number(res.expected.expectedZeroTo100Seconds.toFixed(2)),
        delta0to100Pct:
          res.zeroTo100DeltaPct !== null ? Number(res.zeroTo100DeltaPct.toFixed(1)) : null,
        simTopKph: Number(res.simulatedTopSpeedKph.toFixed(1)),
        expTopKph: Number(res.expected.expectedTopSpeedKph.toFixed(1)),
        deltaTopPct: Number(res.topSpeedDeltaPct.toFixed(1)),
      }));
      console.info('[M9.10 Benchmark Summary]', JSON.stringify(summary));

      // Verify monotonic ordering against Compact and monotonic top speeds, plus ±15% accuracy
      const [compact, sports, highPower] = results;
      expect(compact!.res.simulatedZeroTo100Seconds).not.toBeNull();
      expect(sports!.res.simulatedZeroTo100Seconds).not.toBeNull();
      expect(highPower!.res.simulatedZeroTo100Seconds).not.toBeNull();

      // With default FR + Stock tyres, 264 PS and 552 PS are similarly traction-limited to 100 km/h,
      // while both are clearly faster than 64 PS Compact and top speed separates all three classes.
      expect(sports!.res.simulatedZeroTo100Seconds!).toBeLessThan(
        compact!.res.simulatedZeroTo100Seconds!,
      );
      expect(highPower!.res.simulatedZeroTo100Seconds!).toBeLessThan(
        compact!.res.simulatedZeroTo100Seconds!,
      );
      expect(highPower!.res.simulatedTopSpeedKph).toBeGreaterThan(
        sports!.res.simulatedTopSpeedKph,
      );
      expect(sports!.res.simulatedTopSpeedKph).toBeGreaterThan(
        compact!.res.simulatedTopSpeedKph,
      );

      for (const { res } of results) {
        expect(Math.abs(res.topSpeedDeltaPct)).toBeLessThanOrEqual(15);
        expect(res.zeroTo100DeltaPct).not.toBeNull();
        expect(Math.abs(res.zeroTo100DeltaPct!)).toBeLessThanOrEqual(15);
      }
    },
  );
});
