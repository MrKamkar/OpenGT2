import { existsSync } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TrackAssetIndex } from '../../src/assets/trackAssetIndex';
import { WheelAssetIndex } from '../../src/assets/wheelAssetIndex';
import {
  buildCarModel,
  cdpToIndexedImage,
  parseCdo,
  parseCdp,
  withCarModelTexture,
} from '../../src/formats/car';
import {
  buildCarAssetIndex,
  buildCarCatalogFromBuffers,
  findGtdbEntries,
  pairGtdbRegionVariants,
  selectDefaultGtdbVariant,
} from '../../src/formats/gtdb';
import { gunzip } from '../../src/formats/gzip';
import { decodeIndexedImageToRgba } from '../../src/formats/ps1';
import { parseTim, timToIndexedImage } from '../../src/formats/tim';
import {
  buildCollisionMesh,
  parseTro,
  raycastCollisionMesh,
  troRawToEngineVec3,
} from '../../src/formats/track';
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
  GRAVITY_MPS2,
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
  CAR_WHEEL_CDP_PALETTE_INDEX,
  OrbitCamera,
  buildCarMeshData,
  buildCarWorldModelMatrix,
  computeCarVisualBottomY,
  computeWheelArchMaxUpJounce,
  computeWheelCenterLateralX,
  hasCdpWheelPalette,
  resolveAutoLodIndex,
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

  it('keeps wheels planted without bump-stop chatter across Catalog Track #0 crests and dips (M9.21)', async () => {
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
    const trackIndex = new TrackAssetIndex(allEntries);
    const track0Entry = trackIndex.listTracks()[0]!;
    const troBytes = await gunzip(
      await cachedSource.read(track0Entry.troEntry.address, track0Entry.troEntry.address + track0Entry.troEntry.size),
    );
    const tro = parseTro(troBytes);
    const mesh = buildCollisionMesh(tro);
    const colIndex = new CollisionIndex(mesh);

    const cars = catalog.listCars();
    const testEntries = [
      cars[1]!,
      cars.find(
        (c) =>
          c.carData.specialCar === 0 &&
          c.engine !== null &&
          c.engine.ps >= 240 &&
          c.dimensions !== null &&
          c.dimensions.weightKg >= 1100 &&
          assetIndex.resolve(c.carId).dayModel !== null,
      )!,
    ];

    const segCenters = tro.segments.map((s) =>
      troRawToEngineVec3(s.centerlineCenterRaw.x, s.centerlineCenterRaw.y, s.centerlineCenterRaw.z),
    );

    const crestStartSegments = [17, 67, 127];
    for (const carEntry of testEntries) {
      const assets = assetIndex.resolve(carEntry.carId);
      const cdoBytes = await gunzip(
        await cachedSource.read(assets.dayModel!.address, assets.dayModel!.address + assets.dayModel!.size),
      );
      const spec = buildCarPhysicsSpec(carEntry, { carModel: buildCarModel(parseCdo(cdoBytes)) });

      for (const startSeg of crestStartSegments) {
        const c0 = segCenters[startSeg]!;
        const cNext = segCenters[(startSeg + 2) % segCenters.length]!;
        const fx = cNext.x - c0.x;
        const fz = cNext.z - c0.z;
        const fLen = Math.hypot(fx, fz);
        const yaw = Math.atan2(-(fx / fLen), -(fz / fLen));
        const hit = colIndex.raycastWheelDown({ x: c0.x, y: c0.y + 8, z: c0.z }, { x: 0, y: -1, z: 0 }, 24);
        expect(hit).not.toBeNull();

        const sim = new VehicleSimulation(spec, colIndex, {
          initialPosition: { x: hit!.point.x, y: hit!.point.y + spec.comHeightMeters + 0.02, z: hit!.point.z },
          initialYawRad: yaw,
        });

        for (let w = 0; w < 24; w += 1) {
          sim.stepFixed({ throttle: 0, brake: 0, handbrake: 1, steer: 0 }, FIXED_DT);
        }

        let totalWheelFrames = 0;
        let groundedWheelFrames = 0;
        let allAirborneFrames = 0;
        let bumpStopFrames = 0;
        let pitchSqSum = 0;
        const totalSteps = 600; // 5.0 seconds over each crested section

        for (let step = 0; step < totalSteps; step += 1) {
          const snap = sim.getSnapshot();
          const pos = snap.pose.position;
          let nearestIdx = startSeg;
          let nearestDist = Infinity;
          for (let offset = -5; offset <= 30; offset += 1) {
            const idx = (startSeg + offset + segCenters.length) % segCenters.length;
            const pt = segCenters[idx]!;
            const d = Math.hypot(pt.x - pos.x, pt.z - pos.z);
            if (d < nearestDist) {
              nearestDist = d;
              nearestIdx = idx;
            }
          }
          const targetPt = segCenters[(nearestIdx + 2) % segCenters.length]!;
          const right = quatRotateVec3(snap.pose.orientation, VEC3_RIGHT);
          const toTargetX = targetPt.x - pos.x;
          const toTargetZ = targetPt.z - pos.z;
          const toLen = Math.max(0.1, Math.hypot(toTargetX, toTargetZ));
          const rightDot = (toTargetX / toLen) * right.x + (toTargetZ / toLen) * right.z;
          const steer = Math.max(-0.85, Math.min(0.85, -rightDot * 1.8));
          const targetSpeedMps = 25.0; // ~90 km/h
          const throttle = snap.speedMps < targetSpeedMps ? 1 : 0;

          sim.stepFixed({ throttle, brake: 0, handbrake: 0, steer }, FIXED_DT);

          const post = sim.getSnapshot();
          let stepGrounded = 0;
          for (let wi = 0; wi < 4; wi += 1) {
            totalWheelFrames += 1;
            const w = post.wheels[wi]!;
            if (w.grounded) {
              groundedWheelFrames += 1;
              stepGrounded += 1;
            }
            const axle = spec.wheels[wi]!.axle;
            if (w.compression >= spec.suspension[axle].maxTravelMeters * 0.85) {
              bumpStopFrames += 1;
            }
          }
          if (stepGrounded === 0) {
            allAirborneFrames += 1;
          }
          const postFwd = quatRotateVec3(post.pose.orientation, VEC3_FORWARD);
          const roadHit = colIndex.raycastWheelDown(
            { x: post.pose.position.x, y: post.pose.position.y + 4, z: post.pose.position.z },
            { x: 0, y: -1, z: 0 },
            10,
          );
          const roadSin =
            roadHit !== null
              ? postFwd.x * roadHit.normal.x + postFwd.y * roadHit.normal.y + postFwd.z * roadHit.normal.z
              : postFwd.y;
          const pitchRad = Math.asin(Math.max(-1, Math.min(1, roadSin)));
          pitchSqSum += pitchRad * pitchRad;
        }

        const wheelContactPct = (groundedWheelFrames / totalWheelFrames) * 100;
        const bumpStopPct = (bumpStopFrames / totalWheelFrames) * 100;
        const airAllPct = (allAirborneFrames / totalSteps) * 100;
        const pitchRmsDeg = (Math.sqrt(pitchSqSum / totalSteps) * 180) / Math.PI;

        expect(bumpStopPct).toBeLessThan(5);
        expect(wheelContactPct).toBeGreaterThanOrEqual(92);
        expect(airAllPct).toBeLessThan(2);
        expect(pitchRmsDeg).toBeLessThan(5);
      }
    }
  }, 60_000);

  it('achieves crisp ABS trail-braking turn-in on flat asphalt across real GT2 cars (M9.22)', async () => {
    const allEntries = reader.getAllEntries();
    const preferred = selectDefaultGtdbVariant(pairGtdbRegionVariants(findGtdbEntries(allEntries)));
    const rawGtdb = await gunzip(
      await cachedSource.read(
        preferred!.gtmodeData.address,
        preferred!.gtmodeData.address + preferred!.gtmodeData.size,
      ),
    );
    const catalog = buildCarCatalogFromBuffers(rawGtdb, null, preferred!.id);
    const assetIndex = buildCarAssetIndex(allEntries);
    const cars = catalog.listCars();
    const sampleCars = [
      cars[1]!,
      cars.find(
        (c) =>
          c.engine !== null &&
          c.engine.ps >= 240 &&
          c.dimensions !== null &&
          assetIndex.resolve(c.carId).dayModel !== null,
      )!,
    ];

    const colIndex = createFlatAsphaltCollisionIndex(6000, 400);
    for (const carEntry of sampleCars) {
      const assets = assetIndex.resolve(carEntry.carId);
      const cdoBytes = await gunzip(
        await cachedSource.read(assets.dayModel!.address, assets.dayModel!.address + assets.dayModel!.size),
      );
      const spec = buildCarPhysicsSpec(carEntry, { carModel: buildCarModel(parseCdo(cdoBytes)) });
      const sim = new VehicleSimulation(spec, colIndex, {
        initialPosition: { x: 0, y: spec.comHeightMeters, z: 0 },
      });

      for (let i = 0; i < 1800; i += 1) {
        sim.stepFixed({ throttle: 1, brake: 0, handbrake: 0, steer: 0 }, FIXED_DT);
        if (sim.getSnapshot().speedMps >= 37) break; // ~133 km/h
      }

      let peakLatG = 0;
      let minFrontSlip = 0;
      for (let i = 0; i < 96; i += 1) {
        sim.stepFixed({ throttle: 0, brake: 1, handbrake: 0, steer: 1 }, FIXED_DT);
        const snap = sim.getSnapshot();
        const latG = (snap.speedMps * Math.abs(snap.angularVelocity.y)) / GRAVITY_MPS2;
        if (latG > peakLatG) peakLatG = latG;
        const fMin = Math.min(snap.wheels[0].slipRatio, snap.wheels[1].slipRatio);
        if (fMin < minFrontSlip) minFrontSlip = fMin;
      }

      expect(peakLatG).toBeGreaterThanOrEqual(0.8);
      expect(minFrontSlip).toBeGreaterThan(-0.35);
    }
  }, 60_000);

  it('decodes CDP palette 0 stock alloy rims (distinct from palette 15 brake lights) and carwheel/*.tim assets cleanly (M9.23)', async () => {
    const allEntries = reader.getAllEntries();
    const preferred = selectDefaultGtdbVariant(pairGtdbRegionVariants(findGtdbEntries(allEntries)));
    const rawGtdb = await gunzip(
      await cachedSource.read(
        preferred!.gtmodeData.address,
        preferred!.gtmodeData.address + preferred!.gtmodeData.size,
      ),
    );
    const catalog = buildCarCatalogFromBuffers(rawGtdb, null, preferred!.id);
    const assetIndex = buildCarAssetIndex(allEntries);
    const wheelIndex = new WheelAssetIndex(allEntries);
    expect(CAR_WHEEL_CDP_PALETTE_INDEX).toBe(0);

    // Check Catalog Car #1 plus first 20 textured cars
    const cars = catalog.listCars();
    let validRimCount = 0;
    let checked = 0;
    for (let ci = 1; ci < cars.length && checked < 20; ci += 1) {
      const assets = assetIndex.resolve(cars[ci]!.carId);
      if (assets.dayModel === null || assets.dayTexture === null) continue;
      const [cdoBytes, cdpBytes] = await Promise.all([
        gunzip(await cachedSource.read(assets.dayModel.address, assets.dayModel.address + assets.dayModel.size)),
        gunzip(await cachedSource.read(assets.dayTexture.address, assets.dayTexture.address + assets.dayTexture.size)),
      ]);
      const cdo = parseCdo(cdoBytes);
      const cdp = parseCdp(cdpBytes);
      const model = withCarModelTexture(buildCarModel(cdo), cdp, { variant: 'day' });
      checked += 1;

      if (!hasCdpWheelPalette(model, 0)) continue;
      validRimCount += 1;

      const indexed = cdpToIndexedImage(cdp, 0);
      const rimRgba = decodeIndexedImageToRgba(indexed, 0, { transparencyMode: 'transparent-zero' });
      let opaquePixels = 0;
      let sumR = 0;
      let sumB = 0;
      for (let py = 4; py < 44; py += 1) {
        for (let px = 4; px < 44; px += 1) {
          const base = (py * rimRgba.width + px) * 4;
          if ((rimRgba.rgba[base + 3] ?? 0) >= 128) {
            opaquePixels += 1;
            sumR += rimRgba.rgba[base] ?? 0;
            sumB += rimRgba.rgba[base + 2] ?? 0;
          }
        }
      }
      expect(opaquePixels).toBeGreaterThan(200);
      if (ci === 1) {
        // Catalog Car #1 palette 0 is a neutral stock rim (not reddish brake-light palette 15)
        const avgR = sumR / opaquePixels;
        const avgB = sumB / opaquePixels;
        expect(Math.abs(avgR - avgB)).toBeLessThan(35);
      }
    }
    expect(validRimCount).toBeGreaterThanOrEqual(18);

    // Sample 10 carwheel/*.tim files
    const wheelPaths = wheelIndex.listPaths().slice(0, 10);
    expect(wheelPaths.length).toBe(10);
    const entryMap = new Map(allEntries.map((e) => [e.path, e]));
    for (const wp of wheelPaths) {
      const entry = entryMap.get(wp)!;
      const raw = await cachedSource.read(entry.address, entry.address + entry.size);
      const bytes = entry.isGzip ? await gunzip(raw) : raw;
      const decoded = decodeIndexedImageToRgba(timToIndexedImage(parseTim(bytes)), 0, {
        transparencyMode: 'transparent-zero',
      });
      expect(decoded.width).toBe(48);
      expect(decoded.height).toBe(48);
      let opaque = 0;
      for (let p = 3; p < decoded.rgba.length; p += 4) {
        if ((decoded.rgba[p] ?? 0) >= 128) opaque += 1;
      }
      expect(opaque).toBeGreaterThan(200);
    }
  }, 60_000);

  it('verifies CDO renderFlags & 0x08 normal bijection, finite geometric normals, and Auto LOD0 framing (M9.24–M9.25)', async () => {
    const allEntries = reader.getAllEntries();
    const preferred = selectDefaultGtdbVariant(pairGtdbRegionVariants(findGtdbEntries(allEntries)));
    const rawGtdb = await gunzip(
      await cachedSource.read(
        preferred!.gtmodeData.address,
        preferred!.gtmodeData.address + preferred!.gtmodeData.size,
      ),
    );
    const catalog = buildCarCatalogFromBuffers(rawGtdb, null, preferred!.id);
    const assetIndex = buildCarAssetIndex(allEntries);

    let checkedModels = 0;
    for (const carEntry of catalog.listCars()) {
      if (checkedModels >= 40) break;
      const assets = assetIndex.resolve(carEntry.carId);
      if (assets.dayModel === null) continue;
      const cdoBytes = await gunzip(
        await cachedSource.read(assets.dayModel.address, assets.dayModel.address + assets.dayModel.size),
      );
      const cdo = parseCdo(cdoBytes);
      const carModel = buildCarModel(cdo);
      const lod0 = carModel.lods[0];
      if (lod0 === undefined || lod0.vertexCount === 0) continue;
      checkedModels += 1;

      const allTris = [...lod0.untexturedTriangles, ...lod0.texturedTriangles];
      for (const tri of allTris) {
        if (tri.singleSided) {
          expect(tri.normals.some((n) => n !== 0)).toBe(true);
        } else {
          expect(tri.normals).toEqual([0, 0, 0]);
        }
      }

      const meshData = buildCarMeshData(carModel, 0);
      for (let vi = 0; vi < meshData.vertexCount; vi += 1) {
        const nx = meshData.normalsFloat32[vi * 3] ?? 0;
        const ny = meshData.normalsFloat32[vi * 3 + 1] ?? 0;
        const nz = meshData.normalsFloat32[vi * 3 + 2] ?? 0;
        const len = Math.hypot(nx, ny, nz);
        expect(len).toBeGreaterThan(0.9);
        expect(len).toBeLessThan(1.1);
      }

      const camera = new OrbitCamera({ aspect: 16 / 9 });
      camera.fitToBounds(meshData.boundsMeters.min, meshData.boundsMeters.max);
      expect(resolveAutoLodIndex(camera.getState().distance, carModel.lods)).toBe(0);
    }
    expect(checkedModels).toBe(40);
  }, 60_000);

  it('verifies E3 TRO polygon surfaceCode invariants across all 126 tracks and multi-surface raycasts on Track #0 (M9.30)', async () => {
    const allEntries = reader.getAllEntries();
    const troEntries = allEntries
      .filter(
        (e) =>
          e.kind === 'file' &&
          e.path.toLowerCase().startsWith('crsobj/') &&
          e.path.toLowerCase().endsWith('.tro.gz'),
      )
      .sort((a, b) => a.path.localeCompare(b.path));
    expect(troEntries.length).toBe(126);

    const groundCounts = new Array<number>(8).fill(0);
    const wallCounts = new Array<number>(8).fill(0);
    let lat0Less1 = 0;
    let cnt01 = 0;
    let lat1Less2 = 0;
    let cnt12 = 0;
    let lat2Less3 = 0;
    let cnt23 = 0;

    for (let ti = 0; ti < troEntries.length; ti += 1) {
      const e = troEntries[ti]!;
      const tro = parseTro(await gunzip(await cachedSource.read(e.address, e.address + e.size)));
      const col = buildCollisionMesh(tro);

      if (ti === 0) {
        const idx = new CollisionIndex(col);
        const seenSurfaces = new Set<string>();
        const down = { x: 0, y: -1, z: 0 };
        for (let t = 0; t < col.triangleCount; t += 1) {
          const b = t * 9;
          const cx = ((col.vertices[b] ?? 0) + (col.vertices[b + 3] ?? 0) + (col.vertices[b + 6] ?? 0)) / 3;
          const cy = ((col.vertices[b + 1] ?? 0) + (col.vertices[b + 4] ?? 0) + (col.vertices[b + 7] ?? 0)) / 3;
          const cz = ((col.vertices[b + 2] ?? 0) + (col.vertices[b + 5] ?? 0) + (col.vertices[b + 8] ?? 0)) / 3;
          const hit = idx.raycastWheelDown({ x: cx, y: cy + 2, z: cz }, down, 4);
          if (hit !== null) {
            seenSurfaces.add(hit.surfaceType);
          }
        }
        expect(seenSurfaces.has('asphalt')).toBe(true);
        expect(seenSurfaces.has('kerb')).toBe(true);
        expect(seenSurfaces.has('grass') || seenSurfaces.has('gravel')).toBe(true);
      }

      const barriersBySeg = new Map<number, typeof col.wallBarriers[number][]>();
      for (const b of col.wallBarriers) {
        let arr = barriersBySeg.get(b.segmentIndex);
        if (arr === undefined) {
          arr = [];
          barriersBySeg.set(b.segmentIndex, arr);
        }
        arr.push(b);
      }

      const tSum = new Array<number>(8).fill(0);
      const tCnt = new Array<number>(8).fill(0);

      for (const seg of tro.segments) {
        const sm = seg.subMesh0.vertexCount > 0 ? seg.subMesh0 : seg.subMesh1;
        const rev = seg.subMesh0.vertexCount > 0;
        const verts = sm.worldVerticesRaw;
        const barriers = barriersBySeg.get(seg.segmentIndex);
        const nextSeg = tro.segments[seg.nextSegment] ?? seg;
        const cx0 = seg.centerlineStartRaw.x / 64;
        const cz0 = -seg.centerlineStartRaw.y / 64;
        const dxC = nextSeg.centerlineStartRaw.x / 64 - cx0;
        const dzC = -nextSeg.centerlineStartRaw.y / 64 - cz0;
        const lenC = Math.hypot(dxC, dzC) || 1;

        for (const poly of sm.polygons) {
          const [v0, v1, v2] = rev
            ? [poly.vertices[0], poly.vertices[2], poly.vertices[1]]
            : [poly.vertices[0], poly.vertices[1], poly.vertices[2]];
          const x0 = (verts[v0 * 3] ?? 0) / 64;
          const y0 = (verts[v0 * 3 + 2] ?? 0) / 64;
          const z0 = -(verts[v0 * 3 + 1] ?? 0) / 64;
          const x1 = (verts[v1 * 3] ?? 0) / 64;
          const y1 = (verts[v1 * 3 + 2] ?? 0) / 64;
          const z1 = -(verts[v1 * 3 + 1] ?? 0) / 64;
          const x2 = (verts[v2 * 3] ?? 0) / 64;
          const y2 = (verts[v2 * 3 + 2] ?? 0) / 64;
          const z2 = -(verts[v2 * 3 + 1] ?? 0) / 64;

          const ex1 = x1 - x0;
          const ey1 = y1 - y0;
          const ez1 = z1 - z0;
          const ex2 = x2 - x0;
          const ey2 = y2 - y0;
          const ez2 = z2 - z0;
          const cx = ey1 * ez2 - ez1 * ey2;
          const cy = ez1 * ex2 - ex1 * ez2;
          const cz = ex1 * ey2 - ey1 * ex2;
          const len = Math.hypot(cx, cy, cz);
          if (len < 1e-6) continue;

          const code = poly.surfaceCode;
          if (cy / len < 0.5) {
            wallCounts[code] = (wallCounts[code] ?? 0) + 1;
            continue;
          }
          groundCounts[code] = (groundCounts[code] ?? 0) + 1;

          if (barriers === undefined || barriers.length === 0) continue;
          const mx = (x0 + x1 + x2) / 3;
          const mz = (z0 + z1 + z2) / 3;
          let inside = true;
          for (const b of barriers) {
            if ((mx - b.start.x) * b.normal.x + (mz - b.start.z) * b.normal.z < -0.1) {
              inside = false;
              break;
            }
          }
          if (!inside) continue;
          const lat = Math.abs((mx - cx0) * (-dzC / lenC) + (mz - cz0) * (dxC / lenC));
          tSum[code] = (tSum[code] ?? 0) + lat;
          tCnt[code] = (tCnt[code] ?? 0) + 1;
        }
      }

      if ((tCnt[0] ?? 0) >= 50 && (tCnt[1] ?? 0) >= 10) {
        cnt01 += 1;
        if (tSum[0]! / tCnt[0]! < tSum[1]! / tCnt[1]!) lat0Less1 += 1;
      }
      if ((tCnt[1] ?? 0) >= 10 && (tCnt[2] ?? 0) >= 10) {
        cnt12 += 1;
        if (tSum[1]! / tCnt[1]! < tSum[2]! / tCnt[2]!) lat1Less2 += 1;
      }
      if ((tCnt[2] ?? 0) >= 10 && (tCnt[3] ?? 0) >= 10) {
        cnt23 += 1;
        if (tSum[2]! / tCnt[2]! <= tSum[3]! / tCnt[3]! + 1.0) lat2Less3 += 1;
      }
    }

    expect(groundCounts[7]).toBe(0);
    expect(wallCounts[7]).toBe(0);
    for (let c = 1; c <= 6; c += 1) {
      const g = groundCounts[c] ?? 0;
      const w = wallCounts[c] ?? 0;
      expect(g / (g + w)).toBeGreaterThanOrEqual(0.94);
    }
    expect(lat0Less1 / cnt01).toBeGreaterThanOrEqual(0.9);
    expect(lat1Less2 / cnt12).toBeGreaterThanOrEqual(0.9);
    expect(lat2Less3 / cnt23).toBeGreaterThanOrEqual(0.9);
  }, 60_000);
  it('removes only thin stacked road-marking overlays from real track collision (decal filter)', async () => {
    const trackIndex = new TrackAssetIndex(reader.getAllEntries());
    let totalOff = 0;
    let totalRemoved = 0;
    let checked = 0;
    for (const track of trackIndex.listTracks().slice(0, 4)) {
      const troEntry = track.troEntry;
      const tro = parseTro(
        await gunzip(await cachedSource.read(troEntry.address, troEntry.address + troEntry.size)),
      );
      const off = buildCollisionMesh(tro, { maxDecalHeightMeters: 0 });
      const on = buildCollisionMesh(tro);
      const keep = new Set<string>();
      for (let ti = 0; ti < on.triangleCount; ti += 1) {
        keep.add(Array.from(on.vertices.subarray(ti * 9, ti * 9 + 9)).join(','));
      }
      totalOff += off.triangleCount;
      totalRemoved += off.triangleCount - on.triangleCount;
      for (let ti = 0; ti < off.triangleCount && checked < 400; ti += 1) {
        const v = off.vertices.subarray(ti * 9, ti * 9 + 9);
        if (keep.has(Array.from(v).join(','))) continue;
        const cx = (v[0]! + v[3]! + v[6]!) / 3;
        const cy = (v[1]! + v[4]! + v[7]!) / 3;
        const cz = (v[2]! + v[5]! + v[8]!) / 3;
        // Every removed triangle must still have continuous asphalt 0.5-15 cm directly below it (centroid gap > 0 and <= 15 cm).
        const hit = raycastCollisionMesh(on, { x: cx, y: cy + 0.01, z: cz }, { x: 0, y: -1, z: 0 }, 1, {
          surfaceFilter: ['ground'],
          doubleSided: true,
        });
        expect(hit).not.toBeNull();
        expect(cy - hit!.point.y).toBeGreaterThan(0);
        expect(cy - hit!.point.y).toBeLessThanOrEqual(0.151);
        checked += 1;
      }
    }
    expect(totalRemoved).toBeGreaterThan(0);
    expect(totalRemoved / totalOff).toBeLessThan(0.15);
  });
});
