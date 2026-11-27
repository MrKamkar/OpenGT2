import { existsSync } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCarModel, parseCdo } from '../../src/formats/car';
import {
  buildCarAssetIndex,
  buildCarCatalogFromBuffers,
  findGtdbEntries,
  pairGtdbRegionVariants,
  selectDefaultGtdbVariant,
} from '../../src/formats/gtdb';
import { gunzip } from '../../src/formats/gzip';
import { buildCollisionMesh, parseTro, troRawToEngineVec3 } from '../../src/formats/track';
import { VolReader } from '../../src/formats/vol';
import {
  type ByteSource,
  CachedByteSource,
  SlicedByteSource,
  validateByteRange,
} from '../../src/io';
import {
  CollisionIndex,
  FIXED_DT,
  VehicleSimulation,
  buildCarPhysicsSpec,
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

describe.skipIf(!HAS_REAL_VOL)('Real GT2.VOL vehicle physics integration (M9.6)', () => {
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

  it('builds finite CarPhysicsSpecs for 100% of CarCatalog cars and runs a deterministic 5 s headless track simulation', async () => {
    const allEntries = reader.getAllEntries();
    const discovered = findGtdbEntries(allEntries);
    const variants = pairGtdbRegionVariants(discovered);
    const preferred = selectDefaultGtdbVariant(variants);
    expect(preferred).toBeDefined();

    const rawGtdb = await gunzip(
      await cachedSource.read(
        preferred!.gtmodeData.address,
        preferred!.gtmodeData.address + preferred!.gtmodeData.size,
      ),
    );
    const rawStrings =
      preferred!.unistrdb !== null
        ? await gunzip(
            await cachedSource.read(
              preferred!.unistrdb.address,
              preferred!.unistrdb.address + preferred!.unistrdb.size,
            ),
          )
        : null;

    const catalog = buildCarCatalogFromBuffers(rawGtdb, rawStrings, preferred!.id);
    const cars = catalog.listCars();
    expect(cars.length).toBeGreaterThan(600);

    // 1. Validate buildCarPhysicsSpec across every car in CarCatalog (zero NaNs or invalid values)
    for (const car of cars) {
      const spec = buildCarPhysicsSpec(car);
      expect(Number.isFinite(spec.massKg) && spec.massKg > 0).toBe(true);
      expect(Number.isFinite(spec.lengthMeters) && spec.lengthMeters > 0).toBe(true);
      expect(Number.isFinite(spec.widthMeters) && spec.widthMeters > 0).toBe(true);
      expect(Number.isFinite(spec.heightMeters) && spec.heightMeters > 0).toBe(true);
      expect(Number.isFinite(spec.inertiaLocal.x) && spec.inertiaLocal.x > 0).toBe(true);
      expect(Number.isFinite(spec.inertiaLocal.y) && spec.inertiaLocal.y > 0).toBe(true);
      expect(Number.isFinite(spec.inertiaLocal.z) && spec.inertiaLocal.z > 0).toBe(true);
      expect(Number.isFinite(spec.engine.idleRpm) && spec.engine.idleRpm > 0).toBe(true);
      expect(
        Number.isFinite(spec.engine.redlineRpm) && spec.engine.redlineRpm > spec.engine.idleRpm,
      ).toBe(true);
      expect(Number.isFinite(spec.engine.peakTorqueNm) && spec.engine.peakTorqueNm > 0).toBe(true);
      expect(spec.engine.torqueCurve.length).toBeGreaterThanOrEqual(2);
      for (let i = 0; i < spec.engine.torqueCurve.length; i += 1) {
        const pt = spec.engine.torqueCurve[i]!;
        expect(Number.isFinite(pt.rpm) && pt.rpm > 0).toBe(true);
        expect(Number.isFinite(pt.torqueNm) && pt.torqueNm > 0).toBe(true);
        if (i > 0) {
          expect(pt.rpm).toBeGreaterThan(spec.engine.torqueCurve[i - 1]!.rpm);
        }
      }
      expect(
        Number.isFinite(spec.drivetrain.finalDriveRatio) && spec.drivetrain.finalDriveRatio > 0,
      ).toBe(true);
      expect(spec.drivetrain.gearRatios.length).toBeGreaterThanOrEqual(4);
    }

    // 2. Load 1 anonymized car CarModel and 1 anonymized track CollisionMesh (selected by size)
    const sampleCar = cars.find((c) => c.engine !== null && c.engine.ps >= 150) ?? cars[0]!;
    const assetIndex = buildCarAssetIndex(allEntries);
    const carAssets = assetIndex.resolve(sampleCar.carId);
    expect(carAssets.dayModel).not.toBeNull();
    const cdoBytes = await gunzip(
      await cachedSource.read(
        carAssets.dayModel!.address,
        carAssets.dayModel!.address + carAssets.dayModel!.size,
      ),
    );
    const carModel = buildCarModel(parseCdo(cdoBytes));
    const carSpec = buildCarPhysicsSpec(sampleCar, { carModel });

    const troEntries = allEntries
      .filter(
        (e) =>
          e.kind === 'file' &&
          e.path.toLowerCase().startsWith('crsobj/') &&
          e.path.toLowerCase().endsWith('.tro.gz'),
      )
      .sort((a, b) => a.size - b.size);
    expect(troEntries.length).toBeGreaterThan(0);

    // Find a grounded spawn point along a segment centerline on one of the smallest tracks
    let spawnIndex: CollisionIndex | null = null;
    let spawnPos = { x: 0, y: 0, z: 0 };
    let spawnYaw = 0;

    for (let t = 0; t < Math.min(5, troEntries.length) && spawnIndex === null; t += 1) {
      const troEntry = troEntries[t]!;
      const troBytes = await gunzip(
        await cachedSource.read(troEntry.address, troEntry.address + troEntry.size),
      );
      const tro = parseTro(troBytes);
      const mesh = buildCollisionMesh(tro);
      const idx = new CollisionIndex(mesh);

      for (let si = 0; si < tro.segments.length; si += 1) {
        const seg = tro.segments[si]!;
        const nextSeg = tro.segments[seg.nextSegment] ?? tro.segments[(si + 1) % tro.segments.length]!;
        const c0 = troRawToEngineVec3(
          seg.centerlineCenterRaw.x,
          seg.centerlineCenterRaw.y,
          seg.centerlineCenterRaw.z,
        );
        const c1 = troRawToEngineVec3(
          nextSeg.centerlineCenterRaw.x,
          nextSeg.centerlineCenterRaw.y,
          nextSeg.centerlineCenterRaw.z,
        );
        const fx = c1.x - c0.x;
        const fz = c1.z - c0.z;
        const fLen = Math.hypot(fx, fz);
        if (fLen < 1.0) {
          continue;
        }
        const dirX = fx / fLen;
        const dirZ = fz / fLen;

        const centerHit = idx.raycastWheelDown(
          { x: c0.x, y: c0.y + 8, z: c0.z },
          { x: 0, y: -1, z: 0 },
          20,
        );
        const aheadHit = idx.raycastWheelDown(
          { x: c0.x + dirX * 12, y: c0.y + 8, z: c0.z + dirZ * 12 },
          { x: 0, y: -1, z: 0 },
          20,
        );
        if (centerHit !== null && aheadHit !== null && centerHit.normal.y > 0.9) {
          spawnIndex = idx;
          spawnPos = {
            x: centerHit.point.x,
            y: centerHit.point.y + carSpec.comHeightMeters + 0.05,
            z: centerHit.point.z,
          };
          spawnYaw = Math.atan2(-dirX, -dirZ);
          break;
        }
      }
    }

    expect(spawnIndex).not.toBeNull();

    const runFiveSecondDrive = () => {
      const sim = new VehicleSimulation(carSpec, spawnIndex!, {
        initialPosition: spawnPos,
        initialYawRad: spawnYaw,
      });

      let peakSpeedMps = 0;
      let settledGroundedWheels = 0;

      // 5.0 seconds @ 120 Hz = 600 fixed steps
      for (let step = 0; step < 600; step += 1) {
        const controls =
          step < 120
            ? { throttle: 0, brake: 0, handbrake: 0, steer: 0 }
            : step < 420
              ? { throttle: 1, brake: 0, handbrake: 0, steer: 0 }
              : { throttle: 0, brake: 1, handbrake: 0, steer: 0 };

        sim.stepFixed(controls, FIXED_DT);
        const snap = sim.getSnapshot();
        expect(Number.isFinite(snap.pose.position.x)).toBe(true);
        expect(Number.isFinite(snap.pose.position.y)).toBe(true);
        expect(Number.isFinite(snap.pose.position.z)).toBe(true);
        expect(Number.isFinite(snap.speedMps)).toBe(true);
        expect(Number.isFinite(snap.engineRpm)).toBe(true);

        if (step === 119) {
          settledGroundedWheels = snap.wheels.filter((w) => w.grounded).length;
        }
        if (snap.speedMps > peakSpeedMps) {
          peakSpeedMps = snap.speedMps;
        }
      }

      return {
        finalSnap: sim.getSnapshot(),
        peakSpeedMps,
        settledGroundedWheels,
      };
    };

    const runA = runFiveSecondDrive();
    const runB = runFiveSecondDrive();

    expect(runA.settledGroundedWheels).toBeGreaterThanOrEqual(3);
    expect(runA.peakSpeedMps).toBeGreaterThan(10);
    expect(runA.finalSnap.speedMps).toBeLessThan(runA.peakSpeedMps * 0.75);

    // Deterministic repeatability across independent runs
    expect(Object.is(runA.finalSnap.pose.position.x, runB.finalSnap.pose.position.x)).toBe(true);
    expect(Object.is(runA.finalSnap.pose.position.y, runB.finalSnap.pose.position.y)).toBe(true);
    expect(Object.is(runA.finalSnap.pose.position.z, runB.finalSnap.pose.position.z)).toBe(true);
    expect(Object.is(runA.finalSnap.engineRpm, runB.finalSnap.engineRpm)).toBe(true);
    expect(runA.finalSnap.gear).toBe(runB.finalSnap.gear);
  }, 60_000);
});
