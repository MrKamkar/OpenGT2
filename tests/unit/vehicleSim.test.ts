import { describe, expect, it } from 'vitest';
import { InputManager } from '../../src/core/input';
import type { CarCatalogEntry } from '../../src/formats/gtdb';
import { buildCollisionMesh, parseTro } from '../../src/formats/track';
import { buildCarPhysicsSpec } from '../../src/physics/carSpec';
import { CollisionIndex } from '../../src/physics/collisionIndex';
import { DriveControlAdapter } from '../../src/physics/driveControls';
import { FIXED_DT } from '../../src/physics/fixedStep';
import { GRAVITY_MPS2, createFlatAsphaltCollisionIndex } from '../../src/physics';
import { VEC3_FORWARD, VEC3_RIGHT, quatRotateVec3, vec3Dot } from '../../src/physics/math';
import { VehicleSimulation } from '../../src/physics/vehicleSim';
import { buildSyntheticTro, type SyntheticSegmentSpec } from '../fixtures/buildTro';

function createTestEntry(): CarCatalogEntry {
  return {
    carId: 77,
    carIdHex: '0x0000004d',
    name: { displayName: 'Sim Test Car', firstPart: 'Sim', secondPart: 'Car', isFallback: false },
    carData: {
      carId: 77,
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
      newPrice: 22000,
    },
    dimensions: {
      carId: 77,
      unk_0x04: 0,
      length: 4300,
      height: 1320,
      unk_0x0c: 0,
      weightKg: 1220,
      rmWeightMultiplier: 50,
      unk_0x11: 0,
      unk_0x12: 0,
    },
    engine: {
      carId: 77,
      engineTypeNameIndex: 0,
      engineTypeName2Index: 0,
      unk_0x08: 0,
      unk_0x0a: 0,
      bandAcceleration: [1500, 2100, 2600, 2850, 2750, 2400, 2000],
      engineCc: 2400,
      ps: 240,
      maxPowerRpmRaw: 680,
      torqueKgmRaw: 285,
      torqueRpmStringIndex: 0,
      baseUnits: [1, 1, 1, 1, 1],
      bandRpms: [10, 20, 35, 50, 60, 70, 75],
      bandPointCount: 7,
    },
    engineSummary: null,
    gearboxes: [
      {
        carId: 77,
        price: 0,
        type: 0,
        unk_0x09: 0,
        unk_0x0a: new Uint8Array(16),
        finalGear: 3900,
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

function createWalledFlatTrackIndex(): CollisionIndex {
  // 100 m wide (-50..+50 m X) x 704 m long (+64..-640 m Z) using 11 cell-aligned 64 m segments
  const segments: SyntheticSegmentSpec[] = [];
  for (let cellIdx = -1; cellIdx < 10; cellIdx += 1) {
    const cellCenterRawY = cellIdx * 4096 + 2048;
    segments.push({
      centerRaw: [0, cellCenterRawY, 0],
      subMesh0: {
        localVertices: [
          [-3200, 0, 0],
          [-3200, 4096, 0],
          [3200, 4096, 0],
          [3200, 0, 0],
        ],
        polygons: [{ listIndex: 2, vertices: [0, 1, 2, 3], colors: [{ r: 100, g: 100, b: 100 }] }],
      },
      subMesh1: { localVertices: [], polygons: [] },
      // Side walls at X=-50 m (normal +X) and X=+50 m (normal -X)
      walls2D: [
        { v0: 0, v1: 1, nxFixed12: 4096, nyFixed12: 0 },
        { v0: 3, v1: 2, nxFixed12: -4096, nyFixed12: 0 },
      ],
    });
  }
  const mesh = buildCollisionMesh(parseTro(buildSyntheticTro({ uvEntries: [], segments })));
  return new CollisionIndex(mesh);
}

function createBankedTrackIndex(): CollisionIndex {
  // Slight 5% cross-slope along X across a 200 m square
  const tro = parseTro(
    buildSyntheticTro({
      uvEntries: [],
      segments: [
        {
          centerRaw: [0, 0, 0],
          subMesh0: {
            localVertices: [
              [-6400, -6400, 320],
              [-6400, 6400, 320],
              [6400, 6400, -320],
              [6400, -6400, -320],
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

describe('Full VehicleSimulation integration (M9.6)', () => {
  it('settles stably at rest without sinking, bouncing, or drifting', () => {
    const spec = buildCarPhysicsSpec(createTestEntry());
    const sim = new VehicleSimulation(spec, createWalledFlatTrackIndex(), {
      initialPosition: { x: 0, y: spec.comHeightMeters + 0.1, z: 0 },
    });

    for (let i = 0; i < 240; i += 1) {
      sim.stepFixed({ throttle: 0, brake: 0, handbrake: 0, steer: 0 });
    }

    const snap = sim.getSnapshot();
    expect(Math.abs(snap.pose.position.y - spec.comHeightMeters)).toBeLessThan(0.02);
    expect(snap.speedMps).toBeLessThan(0.05);
    for (const w of snap.wheels) {
      expect(w.grounded).toBe(true);
      expect(w.normalForce).toBeGreaterThan(0);
    }
  });

  it('accelerates smoothly along -Z through gears and brakes to a full stop without backward creep', () => {
    const spec = buildCarPhysicsSpec(createTestEntry());
    const sim = new VehicleSimulation(spec, createWalledFlatTrackIndex(), {
      initialPosition: { x: 0, y: spec.comHeightMeters, z: 0 },
    });

    // Full throttle for 7.5 seconds
    for (let i = 0; i < 900; i += 1) {
      sim.stepFixed({ throttle: 1, brake: 0, handbrake: 0, steer: 0 });
    }
    const accelSnap = sim.getSnapshot();
    expect(accelSnap.pose.position.z).toBeLessThan(-60);
    expect(accelSnap.forwardSpeedMps).toBeGreaterThan(25);
    expect(accelSnap.gear).toBeGreaterThanOrEqual(2);
    expect(accelSnap.engineRpm).toBeLessThanOrEqual(spec.engine.redlineRpm + 250);

    // Full brake until stopped and hold brake
    for (let i = 0; i < 480; i += 1) {
      sim.stepFixed({ throttle: 0, brake: 1, handbrake: 0, steer: 0 });
    }
    const stoppedSnap = sim.getSnapshot();
    expect(stoppedSnap.speedMps).toBeLessThan(0.02);
    expect(Math.abs(stoppedSnap.forwardSpeedMps)).toBeLessThan(0.02);

    // Hold brake for another 1 second -> zero backward creep
    const zAtStop = stoppedSnap.pose.position.z;
    for (let i = 0; i < 120; i += 1) {
      sim.stepFixed({ throttle: 0, brake: 1, handbrake: 0, steer: 0 });
    }
    const heldSnap = sim.getSnapshot();
    expect(Math.abs(heldSnap.pose.position.z - zAtStop)).toBeLessThan(0.01);
    expect(heldSnap.speedMps).toBeLessThan(0.01);
  });

  it('steers left (+steer) smoothly into a +Y CCW turn toward -X without flipping on flat or banked tracks', () => {
    const spec = buildCarPhysicsSpec(createTestEntry());
    const sim = new VehicleSimulation(spec, createWalledFlatTrackIndex(), {
      initialPosition: { x: 0, y: spec.comHeightMeters, z: 0 },
    });

    // Build moderate speed then apply gentle left steer (+0.4)
    for (let i = 0; i < 180; i += 1) {
      sim.stepFixed({ throttle: 0.9, brake: 0, handbrake: 0, steer: 0 });
    }
    for (let i = 0; i < 180; i += 1) {
      sim.stepFixed({ throttle: 0.4, brake: 0, handbrake: 0, steer: 0.4 });
    }

    const snap = sim.getSnapshot();
    const fwd = quatRotateVec3(snap.pose.orientation, VEC3_FORWARD);
    expect(fwd.x).toBeLessThan(-0.15); // turned left (-X)
    expect(snap.pose.position.x).toBeLessThan(-1.0);
    expect(snap.wheels.every((w) => w.grounded)).toBe(true);

    // Also verify stability on banked surface
    const bankedSim = new VehicleSimulation(spec, createBankedTrackIndex(), {
      initialPosition: { x: 0, y: spec.comHeightMeters + 0.05, z: 0 },
    });
    for (let i = 0; i < 240; i += 1) {
      bankedSim.stepFixed({ throttle: 0.6, brake: 0, handbrake: 0, steer: 0.25 });
    }
    const bankedSnap = bankedSim.getSnapshot();
    expect(Number.isFinite(bankedSnap.speedMps)).toBe(true);
    expect(bankedSnap.wheels.filter((w) => w.grounded).length).toBeGreaterThanOrEqual(3);
  });

  it('slides cleanly along side barrier walls without escaping or tunneling', () => {
    const spec = buildCarPhysicsSpec(createTestEntry());
    const sim = new VehicleSimulation(spec, createWalledFlatTrackIndex(), {
      initialPosition: { x: -42, y: spec.comHeightMeters, z: 0 },
      initialYawRad: 0.35, // angled toward the left barrier at x = -50
    });

    for (let i = 0; i < 360; i += 1) {
      sim.stepFixed({ throttle: 0.85, brake: 0, handbrake: 0, steer: 0 });
      const pos = sim.getPose().position;
      expect(pos.x).toBeGreaterThan(-51.5);
      expect(Number.isFinite(pos.x)).toBe(true);
    }

    const snap = sim.getSnapshot();
    expect(snap.wallCollisionCount).toBeGreaterThan(0);
    expect(snap.pose.position.z).toBeLessThan(-10);
  });

  it('produces bit-exact identical state across 30 Hz, 60 Hz, and 144 Hz frame schedules', () => {
    const spec = buildCarPhysicsSpec(createTestEntry());
    const index = createWalledFlatTrackIndex();

    const runConstantControls = (frameDeltas: readonly number[]) => {
      const sim = new VehicleSimulation(spec, index, {
        initialPosition: { x: 0, y: spec.comHeightMeters + 0.05, z: 0 },
      });
      for (const dt of frameDeltas) {
        sim.update(dt, { throttle: 0.85, brake: 0, handbrake: 0, steer: 0.15 });
      }
      return sim.getSnapshot();
    };

    const sched30 = Array.from({ length: 60 }, () => 1 / 30);
    const sched60 = Array.from({ length: 120 }, () => 1 / 60);
    const sched144 = Array.from({ length: 288 }, (_, i) => (i === 287 ? 1 / 144 + 1e-9 : 1 / 144));

    const r30 = runConstantControls(sched30);
    const r60 = runConstantControls(sched60);
    const r144 = runConstantControls(sched144);

    expect(r30.stepCount).toBe(240);
    expect(r60.stepCount).toBe(240);
    expect(r144.stepCount).toBe(240);

    expect(Object.is(r30.pose.position.x, r60.pose.position.x)).toBe(true);
    expect(Object.is(r30.pose.position.x, r144.pose.position.x)).toBe(true);
    expect(Object.is(r30.pose.position.z, r60.pose.position.z)).toBe(true);
    expect(Object.is(r30.pose.position.z, r144.pose.position.z)).toBe(true);
    expect(Object.is(r30.pose.orientation.y, r60.pose.orientation.y)).toBe(true);
    expect(Object.is(r30.pose.orientation.y, r144.pose.orientation.y)).toBe(true);
    expect(Object.is(r30.engineRpm, r60.engineRpm)).toBe(true);
    expect(Object.is(r30.engineRpm, r144.engineRpm)).toBe(true);
  });

  it('remains yaw-stable through a high-speed keyboard step steer and straight release', () => {
    const spec = buildCarPhysicsSpec(createTestEntry());
    const sim = new VehicleSimulation(spec, createWalledFlatTrackIndex(), {
      initialPosition: { x: 0, y: spec.comHeightMeters + 0.05, z: 0 },
    });

    // Build high forward speed (> 22 m/s)
    for (let i = 0; i < 960; i += 1) {
      sim.stepFixed({ throttle: 1, brake: 0, handbrake: 0, steer: 0 });
    }
    expect(sim.getSnapshot().speedMps).toBeGreaterThan(22);

    // Apply brief steering pulse then release steering back to center
    for (let i = 0; i < 60; i += 1) {
      sim.stepFixed({ throttle: 0.7, brake: 0, handbrake: 0, steer: 0.35 });
    }
    const midYawRate = Math.abs(sim.getSnapshot().angularVelocity.y);
    expect(midYawRate).toBeGreaterThan(0.05);

    for (let i = 0; i < 120; i += 1) {
      sim.stepFixed({ throttle: 0.8, brake: 0, handbrake: 0, steer: 0 });
    }
    const endSnap = sim.getSnapshot();
    expect(Number.isFinite(endSnap.speedMps)).toBe(true);
    expect(Math.abs(endSnap.angularVelocity.y)).toBeLessThan(midYawRate * 0.35);
    expect(endSnap.wheels.filter((w) => w.grounded).length).toBeGreaterThanOrEqual(3);
  });

  it('delivers crisp keyboard turn-in at 50 km/h and 120 km/h without spinout and reverses cleanly', () => {
    const spec = buildCarPhysicsSpec(createTestEntry());
    const index = createFlatAsphaltCollisionIndex(4000, 4000);
    const radToDeg = 180 / Math.PI;

    const measureTurnAtTargetKph = (targetKph: number) => {
      const input = new InputManager({ initialContext: 'race' });
      const adapter = new DriveControlAdapter({
        inputManager: input,
        gamepadProvider: () => [],
      });
      const sim = new VehicleSimulation(spec, index, {
        initialPosition: { x: 0, y: spec.comHeightMeters, z: 0 },
      });

      // Accelerate straight up to target speed
      input.handleKeyEvent({ type: 'keydown', code: 'KeyW', repeat: false });
      for (let i = 0; i < 1200; i += 1) {
        const snap = sim.getSnapshot();
        if (snap.speedKph >= targetKph) {
          break;
        }
        const { controls } = adapter.step(FIXED_DT, snap.speedMps);
        sim.stepFixed(controls, FIXED_DT);
      }
      expect(sim.getSnapshot().speedKph).toBeGreaterThanOrEqual(targetKph - 2);

      // Modulate light throttle while steering full left via KeyA for 1.0 s
      input.handleKeyEvent({ type: 'keyup', code: 'KeyW', repeat: false });
      input.handleKeyEvent({ type: 'keydown', code: 'KeyA', repeat: false });

      const startFwd = quatRotateVec3(sim.getPose().orientation, VEC3_FORWARD);
      const startAngle = Math.atan2(-startFwd.x, -startFwd.z);
      let unwrappedDeltaRad = 0;
      let prevAngle = startAngle;
      let peakLatG = 0;
      let maxBodySlipDeg = 0;

      for (let step = 0; step < 120; step += 1) {
        const preSnap = sim.getSnapshot();
        if (preSnap.speedKph < targetKph - 1) {
          input.handleKeyEvent({ type: 'keydown', code: 'KeyW', repeat: false });
        } else {
          input.handleKeyEvent({ type: 'keyup', code: 'KeyW', repeat: false });
        }
        const { controls } = adapter.step(FIXED_DT, preSnap.speedMps);
        sim.stepFixed(controls, FIXED_DT);

        const snap = sim.getSnapshot();
        const fwd = quatRotateVec3(snap.pose.orientation, VEC3_FORWARD);
        const right = quatRotateVec3(snap.pose.orientation, VEC3_RIGHT);
        const angle = Math.atan2(-fwd.x, -fwd.z);
        let dAng = angle - prevAngle;
        if (dAng > Math.PI) dAng -= Math.PI * 2;
        if (dAng < -Math.PI) dAng += Math.PI * 2;
        unwrappedDeltaRad += dAng;
        prevAngle = angle;

        const latG = (snap.speedMps * Math.abs(snap.angularVelocity.y)) / GRAVITY_MPS2;
        if (latG > peakLatG) peakLatG = latG;

        const latSpeed = vec3Dot(snap.linearVelocity, right);
        const slipDeg = Math.abs(
          Math.atan2(latSpeed, Math.max(Math.abs(snap.forwardSpeedMps), 1.0)) * radToDeg,
        );
        if (slipDeg > maxBodySlipDeg) maxBodySlipDeg = slipDeg;
      }

      return {
        headingDeg: unwrappedDeltaRad * radToDeg,
        peakLatG,
        maxBodySlipDeg,
        finalGrounded: sim.getSnapshot().wheels.filter((w) => w.grounded).length,
      };
    };

    const low = measureTurnAtTargetKph(50);
    expect(low.headingDeg).toBeGreaterThanOrEqual(25);
    expect(low.peakLatG).toBeGreaterThanOrEqual(0.8);
    expect(low.maxBodySlipDeg).toBeLessThan(25);
    expect(low.finalGrounded).toBe(4);

    const high = measureTurnAtTargetKph(120);
    expect(high.headingDeg).toBeGreaterThanOrEqual(18);
    expect(high.peakLatG).toBeGreaterThanOrEqual(0.8);
    expect(high.maxBodySlipDeg).toBeLessThan(25);
    expect(high.finalGrounded).toBe(4);

    // Steering reversal KeyA -> KeyD at 80 km/h reverses yaw rate cleanly within 0.5 s
    const revInput = new InputManager({ initialContext: 'race' });
    const revAdapter = new DriveControlAdapter({
      inputManager: revInput,
      gamepadProvider: () => [],
    });
    const revSim = new VehicleSimulation(spec, index, {
      initialPosition: { x: 0, y: spec.comHeightMeters, z: 0 },
    });
    revInput.handleKeyEvent({ type: 'keydown', code: 'KeyW', repeat: false });
    for (let i = 0; i < 600; i += 1) {
      const snap = revSim.getSnapshot();
      if (snap.speedKph >= 80) break;
      const { controls } = revAdapter.step(FIXED_DT, snap.speedMps);
      revSim.stepFixed(controls, FIXED_DT);
    }
    revInput.handleKeyEvent({ type: 'keyup', code: 'KeyW', repeat: false });
    revInput.handleKeyEvent({ type: 'keydown', code: 'KeyA', repeat: false });
    for (let i = 0; i < 48; i += 1) {
      const { controls } = revAdapter.step(FIXED_DT, revSim.getSnapshot().speedMps);
      revSim.stepFixed(controls, FIXED_DT);
    }
    const yawLeft = revSim.getSnapshot().angularVelocity.y;
    expect(yawLeft).toBeGreaterThan(0.2);

    revInput.handleKeyEvent({ type: 'keyup', code: 'KeyA', repeat: false });
    revInput.handleKeyEvent({ type: 'keydown', code: 'KeyD', repeat: false });
    for (let i = 0; i < 60; i += 1) {
      const { controls } = revAdapter.step(FIXED_DT, revSim.getSnapshot().speedMps);
      revSim.stepFixed(controls, FIXED_DT);
    }
    const yawRight = revSim.getSnapshot().angularVelocity.y;
    expect(yawRight).toBeLessThan(-0.2);
  });
});
