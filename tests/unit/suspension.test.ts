import { describe, expect, it } from 'vitest';
import { buildCollisionMesh, parseTro } from '../../src/formats/track';
import type { CarCatalogEntry } from '../../src/formats/gtdb';
import { GRAVITY_MPS2, buildCarPhysicsSpec } from '../../src/physics/carSpec';
import { CollisionIndex, type WheelRaycastHit } from '../../src/physics/collisionIndex';
import { FIXED_DT } from '../../src/physics/fixedStep';
import { quatFromAxisAngle } from '../../src/physics/math';
import {
  applyGravityForce,
  createRigidBodyParamsFromSpec,
  createRigidBodyState,
  integrateRigidBody,
} from '../../src/physics/rigidBody';
import {
  castSuspensionRays,
  createInitialSuspensionStates,
  solveSuspension,
} from '../../src/physics/suspension';
import type { WheelSlotTuple } from '../../src/physics/types';
import { buildSyntheticTro } from '../fixtures/buildTro';

function createTestCarSpec() {
  const entry: CarCatalogEntry = {
    carId: 1,
    carIdHex: '0x00000001',
    name: { displayName: 'Test Car', firstPart: 'Test', secondPart: 'Car', isFallback: false },
    carData: {
      carId: 1,
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
      newPrice: 10000,
    },
    dimensions: {
      carId: 1,
      unk_0x04: 0,
      length: 4200,
      height: 1320,
      unk_0x0c: 0,
      weightKg: 1200,
      rmWeightMultiplier: 50,
      unk_0x11: 0,
      unk_0x12: 0,
    },
    engine: null,
    engineSummary: null,
    gearboxes: [],
    suspensions: [],
    frontTyres: [],
    rearTyres: [],
    racingModifications: [],
  };
  return buildCarPhysicsSpec(entry);
}

function createFlatGroundIndex(): CollisionIndex {
  const tro = parseTro(
    buildSyntheticTro({
      uvEntries: [],
      segments: [
        {
          centerRaw: [0, 0, 0],
          subMesh0: {
            localVertices: [
              [-2000, -2000, 0],
              [-2000, 2000, 0],
              [2000, 2000, 0],
              [2000, -2000, 0],
            ],
            polygons: [{ listIndex: 2, vertices: [0, 1, 2, 3], colors: [{ r: 100, g: 100, b: 100 }] }],
          },
          subMesh1: { localVertices: [], polygons: [] },
        },
      ],
    }),
  );
  return new CollisionIndex(buildCollisionMesh(tro));
}

describe('4-wheel spring-damper suspension (M9.4)', () => {
  it('settles smoothly onto flat ground after drop without sinking, bouncing, or NaN', () => {
    const spec = createTestCarSpec();
    const rbParams = createRigidBodyParamsFromSpec(spec);
    const body = createRigidBodyState({ x: 0, y: spec.comHeightMeters + 0.2, z: 0 });
    const groundIndex = createFlatGroundIndex();
    let susp = createInitialSuspensionStates(spec);

    // Simulate 2.5 seconds at 120 Hz
    for (let i = 0; i < 300; i += 1) {
      applyGravityForce(body, rbParams);
      const hits = castSuspensionRays(body, spec, groundIndex);
      susp = solveSuspension(body, spec, hits, susp, FIXED_DT);
      integrateRigidBody(body, rbParams, FIXED_DT);
    }

    expect(Math.abs(body.position.y - spec.comHeightMeters)).toBeLessThan(0.015);
    expect(Math.abs(body.linearVelocity.y)).toBeLessThan(0.02);

    const totalNormalForce =
      susp[0].normalForce + susp[1].normalForce + susp[2].normalForce + susp[3].normalForce;
    expect(totalNormalForce).toBeCloseTo(spec.massKg * GRAVITY_MPS2, -1);
    for (const w of susp) {
      expect(w.grounded).toBe(true);
      expect(w.normalForce).toBeGreaterThan(0);
    }
  });

  it('produces zero pulling force when airborne', () => {
    const spec = createTestCarSpec();
    const body = createRigidBodyState({ x: 0, y: 50, z: 0 });
    const prev = createInitialSuspensionStates(spec);
    const noHits: WheelSlotTuple<WheelRaycastHit | null> = [null, null, null, null];

    const next = solveSuspension(body, spec, noHits, prev, FIXED_DT);
    for (const w of next) {
      expect(w.grounded).toBe(false);
      expect(w.normalForce).toBe(0);
    }
    expect(body.forceAccum.y).toBe(0);
  });

  it('transfers upward load via anti-roll bar when left and right compression differ', () => {
    const spec = createTestCarSpec();
    // Roll chassis slightly to compress left side more than right side
    const body = createRigidBodyState(
      { x: 0, y: spec.comHeightMeters, z: 0 },
      quatFromAxisAngle({ x: 0, y: 0, z: 1 }, 0.04),
    );
    const groundIndex = createFlatGroundIndex();
    const prev = createInitialSuspensionStates(spec);
    const hits = castSuspensionRays(body, spec, groundIndex);

    const next = solveSuspension(body, spec, hits, prev, FIXED_DT);
    expect(next[0].grounded).toBe(true);
    expect(next[1].grounded).toBe(true);
    expect(next[0].compression).toBeGreaterThan(next[1].compression);
    expect(next[0].antiRollForce).toBeGreaterThan(0);
    expect(next[1].antiRollForce).toBeLessThan(0);
    expect(next[1].normalForce).toBeGreaterThanOrEqual(0);
  });

  it('clamps extreme bottoming-out bump-stop forces cleanly with zero NaN', () => {
    const spec = createTestCarSpec();
    const body = createRigidBodyState({ x: 0, y: 0.05, z: 0 });
    const groundIndex = createFlatGroundIndex();
    const prev = createInitialSuspensionStates(spec);
    const hits = castSuspensionRays(body, spec, groundIndex);

    const next = solveSuspension(body, spec, hits, prev, FIXED_DT);
    for (const w of next) {
      expect(Number.isFinite(w.normalForce)).toBe(true);
      expect(w.normalForce).toBeGreaterThanOrEqual(0);
      expect(w.normalForce).toBeLessThanOrEqual(spec.massKg * GRAVITY_MPS2 * 1.2);
    }
  });

  it('keeps wheel raycasts grounded under extreme compression and nose-dive pitch without catching low ceilings', () => {
    const spec = createTestCarSpec();
    // Extreme compression + 0.25 rad nose-dive puts front wheel mounts below y = 0.15 m
    const body = createRigidBodyState(
      { x: 0, y: 0.12, z: 0 },
      quatFromAxisAngle({ x: 1, y: 0, z: 0 }, -0.25),
    );
    const groundIndex = createFlatGroundIndex();
    const hits = castSuspensionRays(body, spec, groundIndex);
    for (const h of hits) {
      expect(h).not.toBeNull();
      expect(h!.normal.y).toBeGreaterThanOrEqual(0.5);
    }
    const next = solveSuspension(body, spec, hits, createInitialSuspensionStates(spec), FIXED_DT);
    expect(next.every((w) => w.grounded && w.normalForce > 0)).toBe(true);

    // Low ceiling deck at y = 0.65 m directly above ground y = 0 m must NOT be hit by lifted rays
    const lowCeilingTro = parseTro(
      buildSyntheticTro({
        uvEntries: [],
        segments: [
          {
            centerRaw: [0, 0, 0],
            subMesh0: {
              localVertices: [
                [-2000, -2000, 0],
                [-2000, 2000, 0],
                [2000, 2000, 0],
                [2000, -2000, 0],
                // Ceiling quad above with downward normal (-Y) at raw Z = 42 (~0.656 m)
                [-2000, -2000, 42],
                [2000, -2000, 42],
                [2000, 2000, 42],
                [-2000, 2000, 42],
              ],
              polygons: [
                { listIndex: 2, vertices: [0, 1, 2, 3], colors: [{ r: 100, g: 100, b: 100 }] },
                { listIndex: 2, vertices: [4, 5, 6, 7], colors: [{ r: 80, g: 80, b: 80 }] },
              ],
            },
            subMesh1: { localVertices: [], polygons: [] },
          },
        ],
      }),
    );
    const ceilingIndex = new CollisionIndex(buildCollisionMesh(lowCeilingTro));
    const normalBody = createRigidBodyState({ x: 0, y: spec.comHeightMeters, z: 0 });
    const ceilingHits = castSuspensionRays(normalBody, spec, ceilingIndex);
    for (const h of ceilingHits) {
      expect(h).not.toBeNull();
      expect(h!.point.y).toBeCloseTo(0, 4);
      expect(h!.normal.y).toBeGreaterThan(0.9);
    }
  });
});
