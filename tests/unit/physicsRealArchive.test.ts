import { existsSync } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TrackAssetIndex } from '../../src/assets/trackAssetIndex';
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
  RAD_S_TO_RPM,
  VEC3_FORWARD,
  VEC3_RIGHT,
  VEC3_UP,
  VehicleSimulation,
  buildCarPhysicsSpec,
  createFlatAsphaltCollisionIndex,
  getDrivenWheelRadiusMeters,
  getGearRatio,
  quatRotateVec3,
} from '../../src/physics';
import {
  buildCarWorldModelMatrix,
  computeCarVisualBottomY,
  computeWheelArchMaxUpJounce,
  computeWheelCenterLateralX,
} from '../../src/renderer';

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

  it('orients >= 99% of real subBlock98 barriers inward and keeps wall-ramming cars inside track bounds', async () => {
    const allEntries = reader.getAllEntries();
    const preferred = selectDefaultGtdbVariant(pairGtdbRegionVariants(findGtdbEntries(allEntries)));
    expect(preferred).toBeDefined();

    const rawGtdb = await gunzip(
      await cachedSource.read(
        preferred!.gtmodeData.address,
        preferred!.gtmodeData.address + preferred!.gtmodeData.size,
      ),
    );
    const catalog = buildCarCatalogFromBuffers(rawGtdb, null, preferred!.id);
    const cars = catalog.listCars();
    const fastCar = cars.find((c) => c.engine !== null && c.engine.ps >= 220) ?? cars[0]!;
    const assetIndex = buildCarAssetIndex(allEntries);
    const carAssets = assetIndex.resolve(fastCar.carId);
    const cdoBytes = await gunzip(
      await cachedSource.read(
        carAssets.dayModel!.address,
        carAssets.dayModel!.address + carAssets.dayModel!.size,
      ),
    );
    const carSpec = buildCarPhysicsSpec(fastCar, { carModel: buildCarModel(parseCdo(cdoBytes)) });

    const troEntries = allEntries
      .filter(
        (e) =>
          e.kind === 'file' &&
          e.path.toLowerCase().startsWith('crsobj/') &&
          e.path.toLowerCase().endsWith('.tro.gz'),
      )
      .sort((a, b) => a.size - b.size);

    let totalCheckedBarriers = 0;
    let inwardBarriers = 0;
    let rammedTracks = 0;

    for (let t = 0; t < Math.min(5, troEntries.length); t += 1) {
      const troEntry = troEntries[t]!;
      const troBytes = await gunzip(
        await cachedSource.read(troEntry.address, troEntry.address + troEntry.size),
      );
      const tro = parseTro(troBytes);
      const mesh = buildCollisionMesh(tro);

      // Verify barrier normals point inward toward adjacent ground triangle (or segment centroid fallback)
      const segGroundSum = new Map<number, { sx: number; sz: number; n: number; tris: number[] }>();
      for (let ti = 0; ti < mesh.triangleCount; ti += 1) {
        if (mesh.surfaceTypes[ti] !== 0) continue;
        const si = mesh.segmentIndices[ti] ?? 0;
        const vb = ti * 9;
        const cx = ((mesh.vertices[vb] ?? 0) + (mesh.vertices[vb + 3] ?? 0) + (mesh.vertices[vb + 6] ?? 0)) / 3;
        const cz = ((mesh.vertices[vb + 2] ?? 0) + (mesh.vertices[vb + 5] ?? 0) + (mesh.vertices[vb + 8] ?? 0)) / 3;
        const rec = segGroundSum.get(si) ?? { sx: 0, sz: 0, n: 0, tris: [] };
        rec.sx += cx;
        rec.sz += cz;
        rec.n += 1;
        rec.tris.push(ti);
        segGroundSum.set(si, rec);
      }

      const tolSq = 0.05 * 0.05;
      for (const b of mesh.wallBarriers) {
        const g = segGroundSum.get(b.segmentIndex);
        if (g === undefined || g.n === 0) continue;
        const mx = (b.start.x + b.end.x) * 0.5;
        const mz = (b.start.z + b.end.z) * 0.5;
        let refX = 0;
        let refZ = 0;
        let adjCount = 0;
        let hasPos = false;
        let hasNeg = false;
        for (const ti of g.tris) {
          const vb = ti * 9;
          const pts: readonly (readonly [number, number])[] = [
            [mesh.vertices[vb] ?? 0, mesh.vertices[vb + 2] ?? 0],
            [mesh.vertices[vb + 3] ?? 0, mesh.vertices[vb + 5] ?? 0],
            [mesh.vertices[vb + 6] ?? 0, mesh.vertices[vb + 8] ?? 0],
          ];
          let hA = -1;
          let hB = -1;
          for (let k = 0; k < 3; k += 1) {
            const [px, pz] = pts[k]!;
            if (hA < 0 && (px - b.start.x) ** 2 + (pz - b.start.z) ** 2 <= tolSq) {
              hA = k;
              continue;
            }
            if (hB < 0 && (px - b.end.x) ** 2 + (pz - b.end.z) ** 2 <= tolSq) {
              hB = k;
            }
          }
          if (hA >= 0 && hB >= 0 && hA !== hB) {
            const [ox, oz] = pts[3 - hA - hB]!;
            const sideDot = (ox - mx) * b.normal.x + (oz - mz) * b.normal.z;
            if (sideDot > 0.2) hasPos = true;
            if (sideDot < -0.2) hasNeg = true;
            refX += ox;
            refZ += oz;
            adjCount += 1;
          }
        }
        // Skip double-sided barrier edges (e.g., road-to-grass-apron dividers with ground polygons on both sides).
        if (adjCount === 0 || (hasPos && hasNeg)) continue;
        const dot = (refX / adjCount - mx) * b.normal.x + (refZ / adjCount - mz) * b.normal.z;
        totalCheckedBarriers += 1;
        if (dot >= -0.05) {
          inwardBarriers += 1;
        }
      }

      // Run aggressive wall-ramming stress test on first 3 tracks with grounded spawn
      if (rammedTracks >= 3) {
        continue;
      }
      const idx = new CollisionIndex(mesh);
      let spawnPos: { x: number; y: number; z: number } | null = null;
      let spawnYaw = 0;
      for (let si = 0; si < tro.segments.length; si += 1) {
        const seg = tro.segments[si]!;
        const nextSeg = tro.segments[seg.nextSegment] ?? tro.segments[(si + 1) % tro.segments.length]!;
        const c0 = troRawToEngineVec3(seg.centerlineCenterRaw.x, seg.centerlineCenterRaw.y, seg.centerlineCenterRaw.z);
        const c1 = troRawToEngineVec3(nextSeg.centerlineCenterRaw.x, nextSeg.centerlineCenterRaw.y, nextSeg.centerlineCenterRaw.z);
        const fx = c1.x - c0.x;
        const fz = c1.z - c0.z;
        const fLen = Math.hypot(fx, fz);
        if (fLen < 1.0) continue;
        const hit = idx.raycastWheelDown({ x: c0.x, y: c0.y + 8, z: c0.z }, { x: 0, y: -1, z: 0 }, 20);
        if (hit !== null && hit.normal.y > 0.9) {
          spawnPos = { x: hit.point.x, y: hit.point.y + carSpec.comHeightMeters + 0.05, z: hit.point.z };
          spawnYaw = Math.atan2(-(fx / fLen), -(fz / fLen));
          break;
        }
      }
      if (spawnPos === null) continue;
      rammedTracks += 1;

      const sim = new VehicleSimulation(carSpec, idx, {
        initialPosition: spawnPos,
        initialYawRad: spawnYaw,
      });

      // Accelerate hard into left barriers (steps 60..420) then right barriers (steps 420..840)
      for (let step = 0; step < 840; step += 1) {
        const steer = step < 60 ? 0 : step < 420 ? 0.85 : -0.85;
        sim.stepFixed({ throttle: 1, brake: 0, handbrake: 0, steer }, FIXED_DT);
        const snap = sim.getSnapshot();
        expect(Number.isFinite(snap.pose.position.x)).toBe(true);
        expect(Number.isFinite(snap.pose.position.y)).toBe(true);
        expect(Number.isFinite(snap.pose.position.z)).toBe(true);
        // Car must remain strictly inside track bounds (never fall into void or escape behind barriers)
        expect(snap.pose.position.x).toBeGreaterThanOrEqual(mesh.bounds.min.x - 1.0);
        expect(snap.pose.position.x).toBeLessThanOrEqual(mesh.bounds.max.x + 1.0);
        expect(snap.pose.position.z).toBeGreaterThanOrEqual(mesh.bounds.min.z - 1.0);
        expect(snap.pose.position.z).toBeLessThanOrEqual(mesh.bounds.max.z + 1.0);
        expect(snap.pose.position.y).toBeGreaterThanOrEqual(mesh.bounds.min.y - 1.0);
        expect(snap.pose.position.y).toBeLessThanOrEqual(mesh.bounds.max.y + 6.0);
      }

      const finalSnap = sim.getSnapshot();
      expect(finalSnap.wallCollisionCount).toBeGreaterThan(0);
      const downCheck = idx.raycastWheelDown(
        { x: finalSnap.pose.position.x, y: finalSnap.pose.position.y + 3, z: finalSnap.pose.position.z },
        { x: 0, y: -1, z: 0 },
        10,
      );
      expect(downCheck).not.toBeNull();
    }

    expect(totalCheckedBarriers).toBeGreaterThan(500);
    expect(inwardBarriers / totalCheckedBarriers).toBeGreaterThanOrEqual(0.99);
    expect(rammedTracks).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it('keeps high-power (~550 PS) cars in low gears (1-2, never 4-5) across 40-80 km/h under full throttle', async () => {
    const allEntries = reader.getAllEntries();
    const preferred = selectDefaultGtdbVariant(pairGtdbRegionVariants(findGtdbEntries(allEntries)));
    expect(preferred).toBeDefined();

    const rawGtdb = await gunzip(
      await cachedSource.read(
        preferred!.gtmodeData.address,
        preferred!.gtmodeData.address + preferred!.gtmodeData.size,
      ),
    );
    const catalog = buildCarCatalogFromBuffers(rawGtdb, null, preferred!.id);
    const assetIndex = buildCarAssetIndex(allEntries);
    const highPowerCar = catalog
      .listCars()
      .find(
        (c) =>
          c.engine !== null &&
          c.dimensions !== null &&
          c.gearboxes.length > 0 &&
          c.engine.ps >= 480 &&
          c.engine.ps <= 780 &&
          c.dimensions.weightKg <= 1350 &&
          assetIndex.resolve(c.carId).dayModel !== null,
      );
    expect(highPowerCar).toBeDefined();

    const carAssets = assetIndex.resolve(highPowerCar!.carId);
    const cdoBytes = await gunzip(
      await cachedSource.read(
        carAssets.dayModel!.address,
        carAssets.dayModel!.address + carAssets.dayModel!.size,
      ),
    );
    const spec = buildCarPhysicsSpec(highPowerCar!, {
      carModel: buildCarModel(parseCdo(cdoBytes)),
    });
    const sim = new VehicleSimulation(spec, createFlatAsphaltCollisionIndex(6000, 40), {
      initialPosition: { x: 0, y: spec.comHeightMeters, z: 0 },
      transmissionMode: 'auto',
    });

    for (let i = 0; i < 18; i += 1) {
      sim.stepFixed({ throttle: 0, brake: 0, handbrake: 1, steer: 0 }, FIXED_DT);
    }

    const gearsInBand: number[] = [];
    let checkedHookedRpm = 0;
    const drivenRadius = getDrivenWheelRadiusMeters(spec);

    for (let step = 0; step < 1200; step += 1) {
      sim.stepFixed({ throttle: 1, brake: 0, handbrake: 0, steer: 0 }, FIXED_DT);
      const snap = sim.getSnapshot();
      if (snap.speedKph >= 40 && snap.speedKph <= 80) {
        gearsInBand.push(snap.gear);
      }
      const rearSlip = Math.abs(snap.wheels[2].slipRatio);
      if (snap.speedKph >= 40 && rearSlip < 0.12 && snap.gear >= 1) {
        const expectedRpm =
          (snap.forwardSpeedMps / drivenRadius) *
          getGearRatio(spec, snap.gear) *
          spec.drivetrain.finalDriveRatio *
          RAD_S_TO_RPM;
        if (expectedRpm > spec.engine.idleRpm * 1.2) {
          const relErr = Math.abs(snap.engineRpm - expectedRpm) / expectedRpm;
          expect(relErr).toBeLessThanOrEqual(0.15);
          checkedHookedRpm += 1;
        }
      }
      if (snap.speedKph >= 150) {
        break;
      }
    }

    expect(gearsInBand.length).toBeGreaterThan(20);
    for (const g of gearsInBand) {
      expect(g).toBeGreaterThanOrEqual(1);
      expect(g).toBeLessThanOrEqual(2);
    }
    expect(checkedHookedRpm).toBeGreaterThan(10);
  }, 60_000);

  it('prevents wall escapes on catalog Track #0 across previously leaking curved and pit-divider segments', async () => {
    const allEntries = reader.getAllEntries();
    const preferred = selectDefaultGtdbVariant(pairGtdbRegionVariants(findGtdbEntries(allEntries)));
    expect(preferred).toBeDefined();

    const rawGtdb = await gunzip(
      await cachedSource.read(
        preferred!.gtmodeData.address,
        preferred!.gtmodeData.address + preferred!.gtmodeData.size,
      ),
    );
    const catalog = buildCarCatalogFromBuffers(rawGtdb, null, preferred!.id);
    const fastCar = catalog.listCars().find((c) => c.engine !== null && c.engine.ps >= 220) ?? catalog.listCars()[0]!;
    const assetIndex = buildCarAssetIndex(allEntries);
    const carAssets = assetIndex.resolve(fastCar.carId);
    const cdoBytes = await gunzip(
      await cachedSource.read(
        carAssets.dayModel!.address,
        carAssets.dayModel!.address + carAssets.dayModel!.size,
      ),
    );
    const carSpec = buildCarPhysicsSpec(fastCar, { carModel: buildCarModel(parseCdo(cdoBytes)) });

    const trackIndex = new TrackAssetIndex(allEntries);
    const track0Entry = trackIndex.listTracks()[0];
    expect(track0Entry).toBeDefined();
    const troEntry = track0Entry!.troEntry;

    const troBytes = await gunzip(
      await cachedSource.read(troEntry.address, troEntry.address + troEntry.size),
    );
    const tro = parseTro(troBytes);
    const mesh = buildCollisionMesh(tro);
    const colIndex = new CollisionIndex(mesh);

    const targetSegments = [63, 99, 102, 105, 108, 141, 144, 147];
    let testedCases = 0;

    for (const segIdx of targetSegments) {
      const seg = tro.segments[segIdx];
      if (seg === undefined || seg.walls2D.length === 0) continue;
      const nextSeg = tro.segments[seg.nextSegment] ?? tro.segments[(segIdx + 1) % tro.segments.length]!;
      const c0 = troRawToEngineVec3(seg.centerlineCenterRaw.x, seg.centerlineCenterRaw.y, seg.centerlineCenterRaw.z);
      const c1 = troRawToEngineVec3(nextSeg.centerlineCenterRaw.x, nextSeg.centerlineCenterRaw.y, nextSeg.centerlineCenterRaw.z);
      const colSeg = mesh.segments[segIdx];
      let spawnX = c0.x;
      let spawnZ = c0.z;
      let spawnYTop = c0.y + 8;
      if (colSeg !== undefined && colSeg.triangleCount > 0) {
        let sx = 0;
        let sy = -Infinity;
        let sz = 0;
        let n = 0;
        for (let ti = colSeg.triangleStart; ti < colSeg.triangleStart + colSeg.triangleCount; ti += 1) {
          if (mesh.surfaceTypes[ti] !== 0) continue;
          const vb = ti * 9;
          sx += ((mesh.vertices[vb] ?? 0) + (mesh.vertices[vb + 3] ?? 0) + (mesh.vertices[vb + 6] ?? 0)) / 3;
          sy = Math.max(sy, mesh.vertices[vb + 1] ?? 0, mesh.vertices[vb + 4] ?? 0, mesh.vertices[vb + 7] ?? 0);
          sz += ((mesh.vertices[vb + 2] ?? 0) + (mesh.vertices[vb + 5] ?? 0) + (mesh.vertices[vb + 8] ?? 0)) / 3;
          n += 1;
        }
        if (n > 0) {
          spawnX = sx / n;
          spawnZ = sz / n;
          spawnYTop = sy + 4;
        }
      }

      const hit = colIndex.raycastWheelDown({ x: spawnX, y: spawnYTop, z: spawnZ }, { x: 0, y: -1, z: 0 }, 24);
      if (hit === null || hit.normal.y < 0.7) continue;

      const fx = c1.x - c0.x;
      const fz = c1.z - c0.z;
      const fLen = Math.hypot(fx, fz);
      const baseYaw = fLen > 1.0 ? Math.atan2(-(fx / fLen), -(fz / fLen)) : 0;

      for (const yawOffset of [-0.9, 0.9]) {
        const sim = new VehicleSimulation(carSpec, colIndex, {
          initialPosition: { x: hit.point.x, y: hit.point.y + carSpec.comHeightMeters + 0.05, z: hit.point.z },
          initialYawRad: baseYaw + yawOffset,
        });
        testedCases += 1;

        for (let step = 0; step < 300; step += 1) {
          sim.stepFixed({ throttle: 1, brake: 0, handbrake: 0, steer: 0 }, FIXED_DT);
          const snap = sim.getSnapshot();
          expect(Number.isFinite(snap.pose.position.x)).toBe(true);
          expect(Number.isFinite(snap.pose.position.y)).toBe(true);
          expect(Number.isFinite(snap.pose.position.z)).toBe(true);
          const down = colIndex.raycastWheelDown(
            { x: snap.pose.position.x, y: snap.pose.position.y + 4, z: snap.pose.position.z },
            { x: 0, y: -1, z: 0 },
            20,
          );
          expect(down).not.toBeNull();
        }
      }
    }

    expect(testedCases).toBe(targetSegments.length * 2);
  }, 60_000);

  it('traverses the full closed centerline loop of Catalog Track #0 and multi-level tracks with zero overpass/underpass blocks', async () => {
    const allEntries = reader.getAllEntries();
    const trackIndex = new TrackAssetIndex(allEntries);
    const tracks = trackIndex.listTracks();
    expect(tracks.length).toBeGreaterThan(60);

    const halfExtents = { x: 0.88, y: 0.65, z: 2.15 };
    const comHeight = 0.48;

    let checkedTracks = 0;
    let checkedOverpassTracks = 0;
    let totalCenterlineSamples = 0;

    // Test Track #0 and every multi-level track in the catalog
    for (let ti = 0; ti < tracks.length; ti += 1) {
      const tr = tracks[ti]!;
      const troBytes = await gunzip(
        await cachedSource.read(tr.troEntry.address, tr.troEntry.address + tr.troEntry.size),
      );
      const tro = parseTro(troBytes);
      const pts = tro.segments.map((seg, i) => ({
        segIdx: i,
        ...troRawToEngineVec3(
          seg.centerlineCenterRaw.x,
          seg.centerlineCenterRaw.y,
          seg.centerlineCenterRaw.z,
        ),
      }));

      let hasOverpass = false;
      for (let i = 0; i < pts.length && !hasOverpass; i += 1) {
        for (let j = i + 4; j < pts.length; j += 1) {
          if (pts.length - (j - i) < 4) continue;
          const dXZ = Math.hypot(pts[i]!.x - pts[j]!.x, pts[i]!.z - pts[j]!.z);
          const dY = Math.abs(pts[i]!.y - pts[j]!.y);
          if (dXZ < 25 && dY > 2.5) {
            hasOverpass = true;
            break;
          }
        }
      }

      if (ti !== 0 && !hasOverpass) {
        continue;
      }

      checkedTracks += 1;
      if (hasOverpass) {
        checkedOverpassTracks += 1;
      }

      const mesh = buildCollisionMesh(tro);
      const colIndex = new CollisionIndex(mesh);
      let falseBlocks = 0;

      for (let i = 0; i < pts.length; i += 1) {
        const p0 = pts[i]!;
        const nextIdx =
          tro.segments[i]!.nextSegment < pts.length
            ? tro.segments[i]!.nextSegment
            : (i + 1) % pts.length;
        const p1 = pts[nextIdx]!;
        const segLen = Math.hypot(p1.x - p0.x, p1.z - p0.z);
        if (segLen < 0.5 || segLen > 120) {
          continue;
        }
        const steps = Math.max(2, Math.ceil(segLen / 2.0));
        const dx = (p1.x - p0.x) / segLen;
        const dz = (p1.z - p0.z) / segLen;
        const yaw = Math.atan2(-dx, -dz);
        const quat = { x: 0, y: Math.sin(yaw * 0.5), z: 0, w: Math.cos(yaw * 0.5) };
        let prevPos: { x: number; y: number; z: number } | null = null;

        for (let s = 0; s < steps; s += 1) {
          const f = s / steps;
          const x = p0.x + (p1.x - p0.x) * f;
          const yEst = p0.y + (p1.y - p0.y) * f;
          const z = p0.z + (p1.z - p0.z) * f;
          const hit = colIndex.raycastWheelDown(
            { x, y: yEst + 2.0, z },
            { x: 0, y: -1, z: 0 },
            6.0,
          );
          if (hit === null || hit.normal.y < 0.5) {
            continue;
          }
          totalCenterlineSamples += 1;
          const groundY = hit.point.y;
          const pos = { x, y: groundY + comHeight, z };
          const res = colIndex.resolveChassisWallCollisions({
            position: pos,
            prevPosition: prevPos ?? { x: x - dx * 2.0, y: groundY + comHeight, z: z - dz * 2.0 },
            orientation: quat,
            linearVelocity: { x: dx * 30, y: 0, z: dz * 30 },
            angularVelocity: { x: 0, y: 0, z: 0 },
            halfExtents,
            massKg: 1200,
            inertiaY: 2000,
          });
          if (res.collided) {
            // Check whether any non-adjacent segment barrier blocked this centerline sample
            for (const b of mesh.wallBarriers) {
              const diff = Math.abs(b.segmentIndex - i);
              const wrapDiff = Math.min(diff, tro.segments.length - diff);
              if (wrapDiff <= 4) {
                continue;
              }
              const bdx = b.end.x - b.start.x;
              const bdz = b.end.z - b.start.z;
              const bLenSq = bdx * bdx + bdz * bdz;
              if (bLenSq < 1e-6) continue;
              const t = Math.max(
                0,
                Math.min(1, ((x - b.start.x) * bdx + (z - b.start.z) * bdz) / bLenSq),
              );
              const distXZ = Math.hypot(x - (b.start.x + bdx * t), z - (b.start.z + bdz * t));
              if (distXZ < 3.0) {
                falseBlocks += 1;
                break;
              }
            }
          }
          prevPos = pos;
        }
      }

      expect(falseBlocks).toBe(0);
    }

    expect(checkedTracks).toBeGreaterThanOrEqual(10);
    expect(checkedOverpassTracks).toBeGreaterThanOrEqual(10);
    expect(totalCenterlineSamples).toBeGreaterThan(5000);
  }, 120_000);

  it('maintains solid ground clearance with zero floor sinking or teleport popping during real-track wall slams', async () => {
    const allEntries = reader.getAllEntries();
    const preferred = selectDefaultGtdbVariant(pairGtdbRegionVariants(findGtdbEntries(allEntries)));
    expect(preferred).toBeDefined();

    const rawGtdb = await gunzip(
      await cachedSource.read(
        preferred!.gtmodeData.address,
        preferred!.gtmodeData.address + preferred!.gtmodeData.size,
      ),
    );
    const catalog = buildCarCatalogFromBuffers(rawGtdb, null, preferred!.id);
    const assetIndex = buildCarAssetIndex(allEntries);
    const sports = catalog
      .listCars()
      .find(
        (c) =>
          c.engine !== null &&
          c.dimensions !== null &&
          c.engine.ps >= 220 &&
          c.engine.ps <= 310 &&
          assetIndex.resolve(c.carId).dayModel !== null,
      );
    expect(sports).toBeDefined();
    const cdoBytes = await gunzip(
      await cachedSource.read(
        assetIndex.resolve(sports!.carId).dayModel!.address,
        assetIndex.resolve(sports!.carId).dayModel!.address +
          assetIndex.resolve(sports!.carId).dayModel!.size,
      ),
    );
    const carSpec = buildCarPhysicsSpec(sports!, { carModel: buildCarModel(parseCdo(cdoBytes)) });

    const trackIndex = new TrackAssetIndex(allEntries);
    const track0Entry = trackIndex.listTracks()[0]!;
    const troBytes = await gunzip(
      await cachedSource.read(track0Entry.troEntry.address, track0Entry.troEntry.address + track0Entry.troEntry.size),
    );
    const tro = parseTro(troBytes);
    const colIndex = new CollisionIndex(buildCollisionMesh(tro));

    const segStart = 152;
    const sp0 = troRawToEngineVec3(
      tro.segments[segStart]!.centerlineCenterRaw.x,
      tro.segments[segStart]!.centerlineCenterRaw.y,
      tro.segments[segStart]!.centerlineCenterRaw.z,
    );
    const nextIdx = tro.segments[segStart]!.nextSegment;
    const sp1 = troRawToEngineVec3(
      tro.segments[nextIdx]!.centerlineCenterRaw.x,
      tro.segments[nextIdx]!.centerlineCenterRaw.y,
      tro.segments[nextIdx]!.centerlineCenterRaw.z,
    );
    const fdx = sp1.x - sp0.x;
    const fdz = sp1.z - sp0.z;
    const flen = Math.hypot(fdx, fdz);
    const yaw = Math.atan2(-(fdx / flen), -(fdz / flen));
    const hit = colIndex.raycastWheelDown({ x: sp0.x, y: sp0.y + 4, z: sp0.z }, { x: 0, y: -1, z: 0 }, 12);
    expect(hit).not.toBeNull();

    const sim = new VehicleSimulation(carSpec, colIndex, {
      initialPosition: { x: hit!.point.x, y: hit!.point.y + carSpec.comHeightMeters + 0.02, z: hit!.point.z },
      initialYawRad: yaw,
    });

    for (let s = 0; s < 420; s += 1) {
      sim.stepFixed({ throttle: 1, brake: 0, handbrake: 0, steer: 0 }, FIXED_DT);
    }

    let minCornerClearance = Infinity;
    let popEvents = 0;
    let prevPos = sim.getPose().position;

    for (let s = 0; s < 360; s += 1) {
      sim.stepFixed({ throttle: 1, brake: 0, handbrake: 0, steer: s < 180 ? 0.8 : 0 }, FIXED_DT);
      const snap = sim.getSnapshot();
      const pos = snap.pose.position;
      const stepDist = Math.hypot(pos.x - prevPos.x, pos.y - prevPos.y, pos.z - prevPos.z);
      if (stepDist > Math.max(snap.speedMps * FIXED_DT * 2.5, 0.6)) {
        popEvents += 1;
      }

      const up = quatRotateVec3(snap.pose.orientation, VEC3_UP);
      const right = quatRotateVec3(snap.pose.orientation, VEC3_RIGHT);
      const fwd = quatRotateVec3(snap.pose.orientation, VEC3_FORWARD);
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const cx = pos.x + right.x * sx * carSpec.halfExtents.x + fwd.x * sz * carSpec.halfExtents.z;
          const cy =
            pos.y +
            right.y * sx * carSpec.halfExtents.x +
            fwd.y * sz * carSpec.halfExtents.z -
            up.y * carSpec.comHeightMeters;
          const cz = pos.z + right.z * sx * carSpec.halfExtents.x + fwd.z * sz * carSpec.halfExtents.z;
          const cHit = colIndex.raycastWheelDown({ x: cx, y: cy + 3, z: cz }, { x: 0, y: -1, z: 0 }, 10);
          if (cHit !== null) {
            const clearance = cy - cHit.point.y;
            if (clearance < minCornerClearance) {
              minCornerClearance = clearance;
            }
          }
        }
      }
      prevPos = pos;
    }

    expect(sim.getSnapshot().wallCollisionCount).toBeGreaterThan(0);
    expect(minCornerClearance).toBeGreaterThanOrEqual(-0.085);
    expect(popEvents).toBe(0);
  }, 60_000);

  it('aligns real CDO wheel X/Y/width inside body fenders and places tyres flush on ground with authentic ride height', async () => {
    const allEntries = reader.getAllEntries();
    const preferred = selectDefaultGtdbVariant(pairGtdbRegionVariants(findGtdbEntries(allEntries)));
    expect(preferred).toBeDefined();

    const rawGtdb = await gunzip(
      await cachedSource.read(
        preferred!.gtmodeData.address,
        preferred!.gtmodeData.address + preferred!.gtmodeData.size,
      ),
    );
    const catalog = buildCarCatalogFromBuffers(rawGtdb, null, preferred!.id);
    const assetIndex = buildCarAssetIndex(allEntries);

    const widthRatios: number[] = [];
    let checkedWheels = 0;
    let lateralWithinFenders = 0;
    let archCheckedWheels = 0;
    let archClearWheels = 0;
    let groundContactSampleTested = false;

    for (const car of catalog.listCars()) {
      const carAssets = assetIndex.resolve(car.carId);
      if (carAssets.dayModel === null) {
        continue;
      }
      const cdoBytes = await gunzip(
        await cachedSource.read(
          carAssets.dayModel.address,
          carAssets.dayModel.address + carAssets.dayModel.size,
        ),
      );
      const carModel = buildCarModel(parseCdo(cdoBytes));
      const lod0 = carModel.lods[0];
      if (lod0 === undefined || lod0.vertexCount === 0) {
        continue;
      }

      const bodyHalfW =
        (Math.max(Math.abs(lod0.boundingBox.low.x), Math.abs(lod0.boundingBox.high.x)) *
          lod0.vertexScale) /
        4096;
      const maxUpJounce = computeWheelArchMaxUpJounce(carModel, 0);

      for (let wi = 0; wi < 4; wi += 1) {
        const w = carModel.wheels[wi]!;
        if (w.radiusMeters <= 0.05 || w.widthMeters <= 0.05) {
          continue;
        }
        checkedWheels += 1;

        const absX = Math.abs(w.positionMeters.x);
        const absMenuX = Math.abs(w.positionMeters.menuX);
        if (absX > 0.1 && absMenuX > 0.1) {
          widthRatios.push((absX - absMenuX) / (w.widthMeters * 0.5));
        }

        const centerX = computeWheelCenterLateralX(w);
        const outerFaceX = Math.abs(centerX) + w.widthMeters * 0.5;
        if (outerFaceX <= bodyHalfW + 0.02) {
          lateralWithinFenders += 1;
        }

        const sign = w.side === 'left' ? -1 : 1;
        let archTopY = Infinity;
        for (let vi = 0; vi < lod0.vertexCount; vi += 1) {
          const base = vi * 3;
          const vx = lod0.positionsMeters[base] ?? 0;
          const vy = lod0.positionsMeters[base + 1] ?? 0;
          const vz = lod0.positionsMeters[base + 2] ?? 0;
          if (
            vx * sign > bodyHalfW * 0.7 &&
            Math.abs(vz - w.positionMeters.z) < w.radiusMeters * 0.6 &&
            vy > w.positionMeters.y + 0.05 &&
            vy < archTopY
          ) {
            archTopY = vy;
          }
        }
        if (Number.isFinite(archTopY)) {
          archCheckedWheels += 1;
          const compressedTopY = w.positionMeters.y + w.radiusMeters + (maxUpJounce[wi] ?? 0);
          if (compressedTopY <= archTopY) {
            archClearWheels += 1;
          }
        }
      }

      if (!groundContactSampleTested && car.engine !== null && car.engine.ps >= 200) {
        groundContactSampleTested = true;
        const spec = buildCarPhysicsSpec(car, { carModel });
        const bottomY = computeCarVisualBottomY(carModel, 0);
        const mat = buildCarWorldModelMatrix(
          { position: { x: 0, y: spec.comHeightMeters, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
          spec.comHeightMeters,
          bottomY,
        );
        const lowestTyreLocalY = Math.min(
          ...carModel.wheels.map((w) => w.positionMeters.y - w.radiusMeters),
        );
        const lowestTyreWorldY = (mat[5] ?? 0) * lowestTyreLocalY + (mat[13] ?? 0);
        const bodyFloorLocalY = (lod0.boundingBox.low.y * lod0.vertexScale) / 4096;
        const bodyFloorWorldY = (mat[5] ?? 0) * bodyFloorLocalY + (mat[13] ?? 0);
        expect(Math.abs(lowestTyreWorldY)).toBeLessThanOrEqual(0.001);
        expect(bodyFloorWorldY).toBeGreaterThanOrEqual(0.05);
      }
    }

    widthRatios.sort((a, b) => a - b);
    const medianRatio = widthRatios[Math.floor(widthRatios.length / 2)] ?? 0;
    expect(checkedWheels).toBeGreaterThan(2000);
    expect(medianRatio).toBeGreaterThanOrEqual(0.99);
    expect(medianRatio).toBeLessThanOrEqual(1.02);
    expect(lateralWithinFenders / checkedWheels).toBeGreaterThanOrEqual(0.98);
    expect(archCheckedWheels).toBeGreaterThan(1000);
    expect(archClearWheels / archCheckedWheels).toBeGreaterThanOrEqual(0.95);
    expect(groundContactSampleTested).toBe(true);
  }, 60_000);
});
