import { describe, expect, it } from 'vitest';
import { buildCarModel, parseCdo } from '../../src/formats/car';
import type { CarCatalogEntry } from '../../src/formats/gtdb';
import {
  AIR_DENSITY_KG_M3,
  BAND_ACCEL_TO_KGM,
  GRAVITY_MPS2,
  KG_M_TO_NM,
  buildCarPhysicsSpec,
} from '../../src/physics/carSpec';
import { FIXED_DT } from '../../src/physics/fixedStep';
import { VEC3_FORWARD, quatRotateVec3 } from '../../src/physics/math';
import {
  applyAerodynamicForces,
  applyGravityForce,
  applyWorldForceAtPoint,
  createRigidBodyParamsFromSpec,
  createRigidBodyState,
  integrateRigidBody,
} from '../../src/physics/rigidBody';
import { buildSyntheticCdo } from '../fixtures/buildCdo';

function createSyntheticCatalogEntry(): CarCatalogEntry {
  return {
    carId: 0x01020304,
    carIdHex: '0x01020304',
    name: {
      displayName: 'Test Vehicle',
      firstPart: 'Test',
      secondPart: 'Vehicle',
      isFallback: false,
    },
    carData: {
      carId: 0x01020304,
      brakePart: 0,
      specialCar: 0,
      weightPartId: 0,
      unk_0x0c: 123,
      unk_0x0e: 456,
      enginePartId: 0,
      unk_0x12: 789,
      unk_0x14: 111,
      unk_0x18: 222,
      turboPart: 0,
      drivetrainPart: 0,
      flywheel: 0,
      clutch: 0,
      unk_0x24: 333,
      differential: 0,
      transmission: 0,
      suspension: 0,
      unk_0x2c: 444,
      frontTyres: 0,
      rearTyres: 0,
      unk_0x34: 555,
      rimsCode3: 1,
      manufacturerId: 2,
      nameFirstPartIndex: 1,
      nameSecondPartIndex: 2,
      unk_0x40: 0,
      year: 99,
      unk_0x42: 666,
      newPrice: 25000,
    },
    dimensions: {
      carId: 0x01020304,
      unk_0x04: 9999,
      length: 4400,
      height: 1300,
      unk_0x0c: 2650,
      weightKg: 1300,
      rmWeightMultiplier: 50,
      unk_0x11: 77,
      unk_0x12: 88,
    },
    engine: {
      carId: 0x01020304,
      engineTypeNameIndex: 1,
      engineTypeName2Index: 2,
      unk_0x08: 42,
      unk_0x0a: 43,
      // Non-monotonic & duplicate RPM sample to verify sanitization
      bandAcceleration: [1800, 2600, 2400, 2700, 2200, 0xffff],
      engineCc: 2000,
      ps: 220,
      maxPowerRpmRaw: 650,
      torqueKgmRaw: 270,
      torqueRpmStringIndex: 3,
      baseUnits: [1, 2, 3, 4, 5],
      bandRpms: [15, 50, 50, 40, 70, 0xff],
      bandPointCount: 5,
    },
    engineSummary: {
      typeName: 'I4',
      typeName2: 'DOHC',
      torqueRpmLabel: '4000',
      maxPowerRpm: 6500,
      torqueKgm: 27,
    },
    gearboxes: [
      {
        carId: 0x01020304,
        price: 0,
        type: 0,
        unk_0x09: 99,
        unk_0x0a: new Uint8Array(16).fill(0xaa),
        finalGear: 4100,
        unk_0x1c: 1234,
        unk_0x20: 5678,
      },
    ],
    suspensions: [
      {
        carId: 0x01020304,
        price: 0,
        stage: 1,
        unk_0x09: 11,
        unk_0x0a: 22,
        unk_0x0c: new Uint8Array(64).fill(0x55),
      },
    ],
    frontTyres: [
      {
        carId: 0x01020304,
        price: 0,
        type: 1,
        unk_0x09: 7,
        unk_0x0a: 8,
        unk_0x0c: 9,
      },
    ],
    rearTyres: [
      {
        carId: 0x01020304,
        type: 2,
        unk_0x05: 4,
        unk_0x06: 5,
        unk_0x08: 6,
      },
    ],
    racingModifications: [],
  };
}

describe('CarPhysicsSpec adapter & rigid-body dynamics (M9.3)', () => {
  it('maps E2/E3 GTDB fields into SI units, sanitizes torque bands, and ignores all E0 unk_0x.. fields', () => {
    const entryA = createSyntheticCatalogEntry();
    const specA = buildCarPhysicsSpec(entryA);

    expect(specA.massKg).toBe(1300);
    expect(specA.lengthMeters).toBeCloseTo(4.4, 6);
    expect(specA.heightMeters).toBeCloseTo(1.3, 6);
    expect(specA.drivetrain.finalDriveRatio).toBeCloseTo(4.1, 6);
    expect(specA.suspension.stage).toBe(1);
    expect(specA.tyres.front.label).toBe('Sports');
    expect(specA.tyres.rear.label).toBe('Hard');

    // Torque curve must be strictly ascending in RPM with merged 5000 RPM average (2500 raw -> 25 kg·m)
    for (let i = 1; i < specA.engine.torqueCurve.length; i += 1) {
      expect(specA.engine.torqueCurve[i]!.rpm).toBeGreaterThan(
        specA.engine.torqueCurve[i - 1]!.rpm,
      );
    }
    const p5000 = specA.engine.torqueCurve.find((p) => p.rpm === 5000);
    expect(p5000).toBeDefined();
    expect(p5000!.torqueNm).toBeCloseTo(2500 * BAND_ACCEL_TO_KGM * KG_M_TO_NM, 4);

    // Mutate EVERY E0 unk_0x.. field — output CarPhysicsSpec must remain bit-identical
    const entryB: CarCatalogEntry = {
      ...entryA,
      carData: {
        ...entryA.carData,
        unk_0x0c: 0xffff,
        unk_0x0e: 0xffff,
        unk_0x12: 0xffff,
        unk_0x14: -999,
        unk_0x18: -888,
        unk_0x24: 0xffff,
        unk_0x2c: 0xffffffff,
        unk_0x34: 0xffffffff,
        unk_0x40: 1,
        unk_0x42: 0xffff,
      },
      dimensions: {
        ...entryA.dimensions!,
        unk_0x04: 0xffffffff,
        unk_0x0c: 0xffff,
        unk_0x11: 0xff,
        unk_0x12: 0xffff,
      },
      engine: {
        ...entryA.engine!,
        unk_0x08: 0xffff,
        unk_0x0a: 0xffff,
      },
      gearboxes: [
        {
          ...entryA.gearboxes[0]!,
          unk_0x09: 0xff,
          unk_0x0a: new Uint8Array(16).fill(0x11),
          unk_0x1c: -1,
          unk_0x20: -2,
        },
      ],
      suspensions: [
        {
          ...entryA.suspensions[0]!,
          unk_0x09: 0xff,
          unk_0x0a: 0xffff,
          unk_0x0c: new Uint8Array(64).fill(0xff),
        },
      ],
      frontTyres: [
        {
          ...entryA.frontTyres[0]!,
          unk_0x09: 0xff,
          unk_0x0a: 0xffff,
          unk_0x0c: 0xffffffff,
        },
      ],
      rearTyres: [
        {
          ...entryA.rearTyres[0]!,
          unk_0x05: 0xff,
          unk_0x06: 0xffff,
          unk_0x08: 0xffffffff,
        },
      ],
    };
    const specB = buildCarPhysicsSpec(entryB);
    expect(specB).toEqual(specA);
  });

  it('extracts E3 wheel positions and radii when CarModel is provided', () => {
    const entry = createSyntheticCatalogEntry();
    const carModel = buildCarModel(
      parseCdo(
        buildSyntheticCdo({
          lods: [
            {
              maxDistance: 5,
              vertices: [
                [-3600, 0, -8000, 0],
                [3600, 0, -8000, 0],
                [3600, 4500, 8000, 0],
                [-3600, 4500, 8000, 0],
              ],
              normals: [[0, 500, 0]],
              triangles: [{ vertices: [0, 1, 2, 0], normals: [0, 0, 0, 0] }],
              quads: [],
              uvTriangles: [],
              uvQuads: [],
            },
          ],
        }),
      ),
    );
    const spec = buildCarPhysicsSpec(entry, { carModel });

    expect(spec.wheels[0].slot).toBe('frontLeft');
    expect(spec.wheels[0].localPosition.x).toBeLessThan(0);
    expect(spec.wheels[0].localPosition.z).toBeLessThan(0);
    expect(spec.wheels[3].slot).toBe('rearRight');
    expect(spec.wheels[3].localPosition.x).toBeGreaterThan(0);
    expect(spec.wheels[3].localPosition.z).toBeGreaterThan(0);
    expect(spec.wheels[0].radiusMeters).toBeCloseTo(carModel.wheels[0].radiusMeters, 5);
  });

  it('matches analytical free-fall and quadratic drag terminal velocity', () => {
    const spec = buildCarPhysicsSpec(createSyntheticCatalogEntry());
    const params = createRigidBodyParamsFromSpec(spec, { linearDamping: 0, angularDamping: 0 });
    const body = createRigidBodyState({ x: 0, y: 1000, z: 0 });

    // Free fall for 1.0 s (no drag)
    for (let i = 0; i < 120; i += 1) {
      applyGravityForce(body, params);
      integrateRigidBody(body, params, FIXED_DT);
    }
    expect(body.linearVelocity.y).toBeCloseTo(-GRAVITY_MPS2 * 1.0, 4);
    // Semi-implicit Euler shifts by 0.5 * g * dt relative to continuous integral
    expect(body.position.y).toBeCloseTo(1000 - 0.5 * GRAVITY_MPS2 * 1.0 - 0.5 * GRAVITY_MPS2 * FIXED_DT, 3);

    // Terminal velocity with aerodynamic drag (use CdA = 2.0 m^2 so terminal speed < 150 m/s clamp)
    const dragParams = { ...params, dragAreaCdA: 2.0 };
    const dragBody = createRigidBodyState({ x: 0, y: 5000, z: 0 });
    for (let i = 0; i < 120 * 40; i += 1) {
      applyGravityForce(dragBody, dragParams);
      applyAerodynamicForces(dragBody, dragParams);
      integrateRigidBody(dragBody, dragParams, FIXED_DT);
    }
    const expectedTerminal = Math.sqrt(
      (2 * dragParams.massKg * GRAVITY_MPS2) / (AIR_DENSITY_KG_M3 * dragParams.dragAreaCdA),
    );
    expect(Math.abs(dragBody.linearVelocity.y)).toBeCloseTo(expectedTerminal, 0);
  });

  it('produces right-handed yaw (+Y CCW = left) and maintains unit quaternion norm over 10,000 steps', () => {
    const spec = buildCarPhysicsSpec(createSyntheticCatalogEntry());
    const params = createRigidBodyParamsFromSpec(spec, { linearDamping: 0, angularDamping: 0 });
    const body = createRigidBodyState();

    // Leftward force (-X) at front axle (-Z) must generate positive (+Y) yaw torque
    applyWorldForceAtPoint(body, { x: -500, y: 0, z: 0 }, { x: 0, y: 0, z: -1.5 });
    integrateRigidBody(body, params, FIXED_DT);
    expect(body.angularVelocity.y).toBeGreaterThan(0);

    // Forward vector after small +Y rotation points toward -X and -Z
    for (let i = 0; i < 10_000; i += 1) {
      applyWorldForceAtPoint(body, { x: 10, y: 5, z: -10 }, { x: 0.2, y: -0.1, z: -0.5 });
      integrateRigidBody(body, params, FIXED_DT);
    }
    const q = body.orientation;
    const norm = Math.hypot(q.x, q.y, q.z, q.w);
    expect(norm).toBeCloseTo(1, 6);

    const turnTest = createRigidBodyState();
    applyWorldForceAtPoint(turnTest, { x: -1200, y: 0, z: 0 }, { x: 0, y: 0, z: -1.5 });
    for (let i = 0; i < 20; i += 1) {
      integrateRigidBody(turnTest, params, FIXED_DT);
    }
    const fwd = quatRotateVec3(turnTest.orientation, VEC3_FORWARD);
    expect(fwd.x).toBeLessThan(0); // turned left toward -X
    expect(fwd.z).toBeLessThan(0);
  });
});
