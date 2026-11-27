import { describe, expect, it } from 'vitest';
import { InputManager } from '../../src/core/input';
import type { CarCatalogEntry } from '../../src/formats/gtdb';
import { buildCollisionMesh, parseTro, TRO_SURFACE_ASPHALT, TRO_SURFACE_GRASS } from '../../src/formats/track';
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

  it('accelerates smoothly along -Z through gears and brakes to a full stop without backward creep in manual mode', () => {
    const spec = buildCarPhysicsSpec(createTestEntry());
    const sim = new VehicleSimulation(spec, createWalledFlatTrackIndex(), {
      initialPosition: { x: 0, y: spec.comHeightMeters, z: 0 },
      transmissionMode: 'manual',
    });

    // Full throttle for 7.5 seconds with manual upshifts
    for (let i = 0; i < 900; i += 1) {
      const snap = sim.getSnapshot();
      const needUpshift = snap.engineRpm >= spec.engine.redlineRpm * 0.93 && snap.gear < 5;
      sim.stepFixed({ throttle: 1, brake: 0, handbrake: 0, steer: 0, shiftUp: needUpshift });
    }
    const accelSnap = sim.getSnapshot();
    expect(accelSnap.pose.position.z).toBeLessThan(-60);
    expect(accelSnap.forwardSpeedMps).toBeGreaterThan(25);
    expect(accelSnap.gear).toBeGreaterThanOrEqual(2);
    expect(accelSnap.engineRpm).toBeLessThanOrEqual(spec.engine.redlineRpm + 250);

    // Full brake until stopped and hold brake -> stays in manual forward gear with zero creep
    for (let i = 0; i < 540; i += 1) {
      sim.stepFixed({ throttle: 0, brake: 1, handbrake: 0, steer: 0 });
    }
    const stoppedSnap = sim.getSnapshot();
    expect(stoppedSnap.speedMps).toBeLessThan(0.02);
    expect(Math.abs(stoppedSnap.forwardSpeedMps)).toBeLessThan(0.02);

    const zAtStop = stoppedSnap.pose.position.z;
    for (let i = 0; i < 120; i += 1) {
      sim.stepFixed({ throttle: 0, brake: 1, handbrake: 0, steer: 0 });
    }
    const heldSnap = sim.getSnapshot();
    expect(Math.abs(heldSnap.pose.position.z - zAtStop)).toBeLessThan(0.01);
    expect(heldSnap.speedMps).toBeLessThan(0.01);
    expect(heldSnap.gear).toBeGreaterThanOrEqual(1);
  });

  it('auto mode holds S past standstill to engage Reverse and holds W while reversing to brake and return to 1st without flicker', () => {
    const spec = buildCarPhysicsSpec(createTestEntry());
    const sim = new VehicleSimulation(spec, createWalledFlatTrackIndex(), {
      initialPosition: { x: 0, y: spec.comHeightMeters, z: 0 },
      transmissionMode: 'auto',
    });

    // Accelerate forward to > 15 m/s
    for (let i = 0; i < 480; i += 1) {
      sim.stepFixed({ throttle: 1, brake: 0, handbrake: 0, steer: 0 }, FIXED_DT);
    }
    expect(sim.getSnapshot().forwardSpeedMps).toBeGreaterThan(15);

    // Hold S/brake continuously: must brake cleanly without shifting to R at speed,
    // then engage R (-1) shortly after reaching rest and drive backwards
    let engagedReverseAtSpeed = false;
    let enteredReverseStep = -1;
    let prevGear = sim.getSnapshot().gear;
    let reversePhaseFlickers = 0;

    for (let step = 0; step < 600; step += 1) {
      const pre = sim.getSnapshot();
      sim.stepFixed({ throttle: 0, brake: 1, handbrake: 0, steer: 0 }, FIXED_DT);
      const snap = sim.getSnapshot();

      if (pre.forwardSpeedMps > 0.5 && snap.gear === -1) {
        engagedReverseAtSpeed = true;
      }
      if (enteredReverseStep < 0 && snap.gear === -1) {
        engagedReverseAtSpeed = pre.forwardSpeedMps > 0.5;
        enteredReverseStep = step;
      } else if (enteredReverseStep >= 0 && snap.gear !== prevGear) {
        reversePhaseFlickers += 1;
      }
      prevGear = snap.gear;
    }

    const revSnap = sim.getSnapshot();
    expect(engagedReverseAtSpeed).toBe(false);
    expect(enteredReverseStep).toBeGreaterThan(0);
    expect(reversePhaseFlickers).toBe(0);
    expect(revSnap.gear).toBe(-1);
    expect(revSnap.forwardSpeedMps).toBeLessThan(-3.5);

    // Now hold W/throttle while reversing: must brake to ~0 m/s in R, then shift into 1st and accelerate forward
    let shiftedToFirstStep = -1;
    let exitedReverseAtHighNegSpeed = false;
    let forwardPhaseFlickers = 0;

    for (let step = 0; step < 480; step += 1) {
      const pre = sim.getSnapshot();
      sim.stepFixed({ throttle: 1, brake: 0, handbrake: 0, steer: 0 }, FIXED_DT);
      const snap = sim.getSnapshot();

      if (shiftedToFirstStep < 0 && snap.gear === 1) {
        exitedReverseAtHighNegSpeed = pre.forwardSpeedMps < -0.5;
        shiftedToFirstStep = step;
      } else if (shiftedToFirstStep >= 0 && snap.gear < 1) {
        forwardPhaseFlickers += 1;
      }
    }

    const fwdSnap = sim.getSnapshot();
    expect(exitedReverseAtHighNegSpeed).toBe(false);
    expect(shiftedToFirstStep).toBeGreaterThan(0);
    expect(forwardPhaseFlickers).toBe(0);
    expect(fwdSnap.gear).toBeGreaterThanOrEqual(1);
    expect(fwdSnap.forwardSpeedMps).toBeGreaterThan(5.0);
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

  it('prevents floor sinking and discontinuous snap-back popping during high-speed wall slams', () => {
    const spec = buildCarPhysicsSpec(createTestEntry());
    const index = createWalledFlatTrackIndex();
    const sim = new VehicleSimulation(spec, index, {
      initialPosition: { x: -34, y: spec.comHeightMeters + 0.02, z: 45 },
    });

    // Accelerate straight to high speed (> 135 km/h)
    for (let i = 0; i < 1440; i += 1) {
      sim.stepFixed({ throttle: 1, brake: 0, handbrake: 0, steer: 0 }, FIXED_DT);
      if (sim.getSnapshot().speedKph >= 145) {
        break;
      }
    }
    expect(sim.getSnapshot().speedKph).toBeGreaterThanOrEqual(135);

    // Slam hard into the left barrier (x = -50 m, 16 m away) at high speed
    let prevPos = sim.getPose().position;
    let minCornerClearance = Infinity;
    let maxJumpRatio = 0;
    let peakWallCount = 0;

    for (let i = 0; i < 420; i += 1) {
      sim.stepFixed({ throttle: 1, brake: 0, handbrake: 0, steer: i < 240 ? 0.85 : 0 }, FIXED_DT);
      const snap = sim.getSnapshot();
      const pos = snap.pose.position;
      const stepDist = Math.hypot(pos.x - prevPos.x, pos.y - prevPos.y, pos.z - prevPos.z);
      const maxAllowedStep = Math.max(snap.speedMps * FIXED_DT * 2.5, 0.55);
      const ratio = stepDist / maxAllowedStep;
      if (ratio > maxJumpRatio) {
        maxJumpRatio = ratio;
      }

      const up = { x: 0, y: 1, z: 0 };
      const right = quatRotateVec3(snap.pose.orientation, VEC3_RIGHT);
      const fwd = quatRotateVec3(snap.pose.orientation, VEC3_FORWARD);
      const rotUp = quatRotateVec3(snap.pose.orientation, up);
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const cornerY =
            pos.y +
            right.y * sx * spec.halfExtents.x +
            fwd.y * sz * spec.halfExtents.z -
            rotUp.y * spec.comHeightMeters;
          if (cornerY < minCornerClearance) {
            minCornerClearance = cornerY;
          }
        }
      }

      expect(pos.x).toBeGreaterThan(-51.5);
      peakWallCount = snap.wallCollisionCount;
      prevPos = pos;
    }

    expect(peakWallCount).toBeGreaterThan(0);
    // Tyre-bottom plane stays above -(restClearance + 0.01 m) -> chassis sill never penetrates floor
    expect(minCornerClearance).toBeGreaterThanOrEqual(-0.085);
    expect(maxJumpRatio).toBeLessThanOrEqual(1.0);
  });

  it('maintains crisp peak-slip grip cornering at 60 & 130 km/h and smooth WASD + Space drift recovery (M9.18)', () => {
    const spec = buildCarPhysicsSpec(createTestEntry());
    const index = createFlatAsphaltCollisionIndex(4000, 4000);
    const radToDeg = 180 / Math.PI;
    const gravityMps2 = 9.81;

    const testGripSpeed = (targetKph: number) => {
      const input = new InputManager({ initialContext: 'race' });
      const adapter = new DriveControlAdapter({
        inputManager: input,
        gamepadProvider: () => [],
      });
      const sim = new VehicleSimulation(spec, index, {
        initialPosition: { x: 0, y: spec.comHeightMeters, z: 0 },
      });

      input.handleKeyEvent({ type: 'keydown', code: 'KeyW', repeat: false });
      for (let i = 0; i < 1500; i += 1) {
        const s = sim.getSnapshot();
        if (s.speedKph >= targetKph) break;
        const { controls } = adapter.step(FIXED_DT, s.speedMps);
        sim.stepFixed(controls, FIXED_DT);
      }

      const startSpeedMps = sim.getSnapshot().speedMps;
      const startFwd = quatRotateVec3(sim.getPose().orientation, VEC3_FORWARD);
      let prevAngle = Math.atan2(-startFwd.x, -startFwd.z);
      let headingDeltaRad = 0;

      // Full left keyboard hold while modulating throttle to hold entry speed
      input.handleKeyEvent({ type: 'keydown', code: 'KeyA', repeat: false });
      let steadyLatG = 0;
      let steadyFrontSlipDeg = 0;
      let steadyBodySlipDeg = 0;

      for (let i = 0; i < 150; i += 1) {
        const pre = sim.getSnapshot();
        if (pre.speedKph < targetKph - 1) {
          input.handleKeyEvent({ type: 'keydown', code: 'KeyW', repeat: false });
        } else {
          input.handleKeyEvent({ type: 'keyup', code: 'KeyW', repeat: false });
        }
        const { controls } = adapter.step(FIXED_DT, pre.speedMps);
        sim.stepFixed(controls, FIXED_DT);

        const snap = sim.getSnapshot();
        const fwd = quatRotateVec3(snap.pose.orientation, VEC3_FORWARD);
        const ang = Math.atan2(-fwd.x, -fwd.z);
        let dAng = ang - prevAngle;
        if (dAng > Math.PI) dAng -= Math.PI * 2;
        if (dAng < -Math.PI) dAng += Math.PI * 2;
        if (i < 120) {
          headingDeltaRad += dAng;
        }
        prevAngle = ang;

        if (i === 149) {
          const right = quatRotateVec3(snap.pose.orientation, VEC3_RIGHT);
          const latSpeed = vec3Dot(snap.linearVelocity, right);
          steadyLatG = (snap.speedMps * Math.abs(snap.angularVelocity.y)) / gravityMps2;
          steadyFrontSlipDeg =
            ((Math.abs(snap.wheels[0].slipAngleRad) + Math.abs(snap.wheels[1].slipAngleRad)) *
              0.5) *
            radToDeg;
          steadyBodySlipDeg =
            Math.atan2(latSpeed, Math.max(Math.abs(snap.forwardSpeedMps), 1.0)) * radToDeg;
        }
      }

      const endSpeedMps = sim.getSnapshot().speedMps;
      return {
        heading1sDeg: headingDeltaRad * radToDeg,
        steadyLatG,
        steadyFrontSlipDeg,
        absBodySlipDeg: Math.abs(steadyBodySlipDeg),
        speedLossPct: Math.max(0, ((startSpeedMps - endSpeedMps) / Math.max(1, startSpeedMps)) * 100),
      };
    };

    const grip60 = testGripSpeed(60);
    const grip130 = testGripSpeed(130);
    expect(grip60.steadyLatG).toBeGreaterThanOrEqual(0.9);
    expect(grip60.steadyFrontSlipDeg).toBeLessThanOrEqual(16);
    expect(grip60.heading1sDeg).toBeGreaterThanOrEqual(34);

    expect(grip130.steadyLatG).toBeGreaterThanOrEqual(0.9);
    expect(grip130.steadyFrontSlipDeg).toBeLessThanOrEqual(16);
    expect(grip130.absBodySlipDeg).toBeLessThan(16);
    expect(grip130.speedLossPct).toBeLessThanOrEqual(5.5);

    // Smooth controllable WASD + Space drift initiation & recovery at 95 km/h
    const driftInput = new InputManager({ initialContext: 'race' });
    const driftAdapter = new DriveControlAdapter({
      inputManager: driftInput,
      gamepadProvider: () => [],
    });
    const driftSim = new VehicleSimulation(spec, index, {
      initialPosition: { x: 0, y: spec.comHeightMeters, z: 0 },
    });

    driftInput.handleKeyEvent({ type: 'keydown', code: 'KeyW', repeat: false });
    for (let i = 0; i < 1200; i += 1) {
      const s = driftSim.getSnapshot();
      if (s.speedKph >= 95) break;
      const { controls } = driftAdapter.step(FIXED_DT, s.speedMps);
      driftSim.stepFixed(controls, FIXED_DT);
    }

    // Pull handbrake for 0.25 s while steering left + throttle, then release handbrake and catch
    driftInput.handleKeyEvent({ type: 'keydown', code: 'KeyA', repeat: false });
    driftInput.handleKeyEvent({ type: 'keydown', code: 'Space', repeat: false });
    let maxBodySlipDeg = 0;
    const measureBodySlipDeg = () => {
      const snap = driftSim.getSnapshot();
      const right = quatRotateVec3(snap.pose.orientation, VEC3_RIGHT);
      const latSpeed = vec3Dot(snap.linearVelocity, right);
      return Math.abs(
        Math.atan2(latSpeed, Math.max(Math.abs(snap.forwardSpeedMps), 1.0)) * radToDeg,
      );
    };

    for (let i = 0; i < 30; i += 1) {
      const { controls } = driftAdapter.step(FIXED_DT, driftSim.getSnapshot().speedMps);
      driftSim.stepFixed(controls, FIXED_DT);
      maxBodySlipDeg = Math.max(maxBodySlipDeg, measureBodySlipDeg());
    }

    driftInput.handleKeyEvent({ type: 'keyup', code: 'Space', repeat: false });
    for (let i = 0; i < 60; i += 1) {
      const { controls } = driftAdapter.step(FIXED_DT, driftSim.getSnapshot().speedMps);
      driftSim.stepFixed(controls, FIXED_DT);
      maxBodySlipDeg = Math.max(maxBodySlipDeg, measureBodySlipDeg());
    }

    // Release steer with light throttle (CSA + yaw damping recovers cleanly within 1.2 s)
    driftInput.handleKeyEvent({ type: 'keyup', code: 'KeyA', repeat: false });
    for (let i = 0; i < 144; i += 1) {
      const { controls } = driftAdapter.step(FIXED_DT, driftSim.getSnapshot().speedMps);
      driftSim.stepFixed(controls, FIXED_DT);
    }
    const recoveredSlipDeg = measureBodySlipDeg();

    expect(maxBodySlipDeg).toBeGreaterThanOrEqual(16);
    expect(maxBodySlipDeg).toBeLessThanOrEqual(52);
    expect(recoveredSlipDeg).toBeLessThan(10);
  });

  it('preserves front turn-in during ABS trail-braking while leaving handbrake drift lockup unaffected (M9.22)', () => {
    const spec = buildCarPhysicsSpec(createTestEntry());
    const index = createFlatAsphaltCollisionIndex(4000, 400);
    const radToDeg = 180 / Math.PI;

    // Part A: Full footbrake + full steer (trail-braking from > 115 km/h) must not lock front wheels
    const trailSim = new VehicleSimulation(spec, index, {
      initialPosition: { x: 0, y: spec.comHeightMeters, z: 0 },
    });
    for (let i = 0; i < 1200; i += 1) {
      trailSim.stepFixed({ throttle: 1, brake: 0, handbrake: 0, steer: 0 }, FIXED_DT);
      if (trailSim.getSnapshot().speedMps >= 32) break;
    }
    const trailStartHeading = (() => {
      const fwd = quatRotateVec3(trailSim.getSnapshot().pose.orientation, VEC3_FORWARD);
      return Math.atan2(-fwd.x, -fwd.z);
    })();
    let prevAngle = trailStartHeading;
    let headingDeltaRad = 0;
    let minFrontSlipRatio = 0;
    let peakLatG = 0;

    for (let i = 0; i < 120; i += 1) {
      trailSim.stepFixed({ throttle: 0, brake: 1, handbrake: 0, steer: 1 }, FIXED_DT);
      const snap = trailSim.getSnapshot();
      const frontMin = Math.min(snap.wheels[0].slipRatio, snap.wheels[1].slipRatio);
      if (frontMin < minFrontSlipRatio) minFrontSlipRatio = frontMin;
      const latG = (snap.speedMps * Math.abs(snap.angularVelocity.y)) / GRAVITY_MPS2;
      if (latG > peakLatG) peakLatG = latG;

      const fwd = quatRotateVec3(snap.pose.orientation, VEC3_FORWARD);
      const ang = Math.atan2(-fwd.x, -fwd.z);
      let dAng = ang - prevAngle;
      if (dAng > Math.PI) dAng -= Math.PI * 2;
      if (dAng < -Math.PI) dAng += Math.PI * 2;
      headingDeltaRad += dAng;
      prevAngle = ang;
    }

    expect(minFrontSlipRatio).toBeGreaterThan(-0.38);
    expect(peakLatG).toBeGreaterThanOrEqual(0.78);
    expect(headingDeltaRad * radToDeg).toBeGreaterThanOrEqual(12);

    // Part B: Rear handbrake lockup must remain unmodulated by ABS so drift initiation stays crisp
    const hbSim = new VehicleSimulation(spec, index, {
      initialPosition: { x: 0, y: spec.comHeightMeters, z: 0 },
    });
    for (let i = 0; i < 1200; i += 1) {
      hbSim.stepFixed({ throttle: 1, brake: 0, handbrake: 0, steer: 0 }, FIXED_DT);
      if (hbSim.getSnapshot().speedMps >= 26.4) break;
    }
    let minRearSlipRatio = 0;
    let peakBodySlipDeg = 0;
    const measureSlipDeg = () => {
      const snap = hbSim.getSnapshot();
      const right = quatRotateVec3(snap.pose.orientation, VEC3_RIGHT);
      const latSpeed = vec3Dot(snap.linearVelocity, right);
      return Math.abs(
        Math.atan2(latSpeed, Math.max(Math.abs(snap.forwardSpeedMps), 1.0)) * radToDeg,
      );
    };
    for (let i = 0; i < 36; i += 1) {
      hbSim.stepFixed({ throttle: 0, brake: 0, handbrake: 1, steer: 1 }, FIXED_DT);
      const snap = hbSim.getSnapshot();
      const rearMin = Math.min(snap.wheels[2].slipRatio, snap.wheels[3].slipRatio);
      if (rearMin < minRearSlipRatio) minRearSlipRatio = rearMin;
      const slipDeg = measureSlipDeg();
      if (slipDeg > peakBodySlipDeg) peakBodySlipDeg = slipDeg;
    }
    for (let i = 0; i < 60; i += 1) {
      hbSim.stepFixed({ throttle: 1, brake: 0, handbrake: 0, steer: 1 }, FIXED_DT);
      const slipDeg = measureSlipDeg();
      if (slipDeg > peakBodySlipDeg) peakBodySlipDeg = slipDeg;
    }

    expect(minRearSlipRatio).toBeLessThan(-0.45);
    expect(peakBodySlipDeg).toBeGreaterThanOrEqual(15);
  });

  it('toggles ABS On (crisp trail-braking + floored CBC over kerb unload + strong straight stop) vs ABS Off (wheel lockup understeer) (M9.29)', () => {
    const spec = buildCarPhysicsSpec(createTestEntry());
    const index = createFlatAsphaltCollisionIndex(4000, 4000);
    const radToDeg = 180 / Math.PI;

    const runTrailBrake = (absEnabled: boolean) => {
      const sim = new VehicleSimulation(spec, index, {
        initialPosition: { x: 0, y: spec.comHeightMeters, z: 0 },
        absEnabled,
      });
      expect(sim.isAbsEnabled()).toBe(absEnabled);
      expect(sim.getSnapshot().absEnabled).toBe(absEnabled);

      for (let i = 0; i < 1200; i += 1) {
        sim.stepFixed({ throttle: 1, brake: 0, handbrake: 0, steer: 0 }, FIXED_DT);
        if (sim.getSnapshot().speedKph >= 120) break;
      }

      const startFwd = quatRotateVec3(sim.getSnapshot().pose.orientation, VEC3_FORWARD);
      let prevAngle = Math.atan2(-startFwd.x, -startFwd.z);
      let headingDeltaRad = 0;
      let minFrontSlipRatio = 0;
      let sumLatG = 0;
      let samples = 0;

      for (let step = 0; step < 120; step += 1) {
        sim.stepFixed({ throttle: 0, brake: 1, handbrake: 0, steer: 1 }, FIXED_DT);
        const snap = sim.getSnapshot();
        minFrontSlipRatio = Math.min(
          minFrontSlipRatio,
          snap.wheels[0].slipRatio,
          snap.wheels[1].slipRatio,
        );
        const latG = (snap.speedMps * Math.abs(snap.angularVelocity.y)) / GRAVITY_MPS2;
        if (step >= 12 && step < 96) {
          sumLatG += latG;
          samples += 1;
        }
        const fwd = quatRotateVec3(snap.pose.orientation, VEC3_FORWARD);
        const ang = Math.atan2(-fwd.x, -fwd.z);
        let dAng = ang - prevAngle;
        if (dAng > Math.PI) dAng -= Math.PI * 2;
        if (dAng < -Math.PI) dAng += Math.PI * 2;
        headingDeltaRad += dAng;
        prevAngle = ang;
      }

      return {
        headingDeg: headingDeltaRad * radToDeg,
        avgLatG: sumLatG / Math.max(1, samples),
        minFrontSlipRatio,
      };
    };

    const absOn = runTrailBrake(true);
    const absOff = runTrailBrake(false);

    // ABS On preserves crisp trail-braking lateral grip & turn-in without front lockup
    expect(absOn.minFrontSlipRatio).toBeGreaterThan(-0.30);
    expect(absOn.avgLatG).toBeGreaterThanOrEqual(0.80);
    expect(absOn.headingDeg).toBeGreaterThanOrEqual(20);

    // ABS Off causes genuine front wheel lockup and degraded steering turn-in
    expect(absOff.minFrontSlipRatio).toBeLessThan(-0.55);
    expect(absOff.headingDeg).toBeLessThan(absOn.headingDeg - 6);

    // Straight-line braking with ABS On retains strong stopping power (>= 0.85 g)
    const straightSim = new VehicleSimulation(spec, index, {
      initialPosition: { x: 0, y: spec.comHeightMeters, z: 0 },
      absEnabled: true,
    });
    for (let i = 0; i < 1200; i += 1) {
      straightSim.stepFixed({ throttle: 1, brake: 0, handbrake: 0, steer: 0 }, FIXED_DT);
      if (straightSim.getSnapshot().speedKph >= 120) break;
    }
    const straightEntrySpeed = straightSim.getSnapshot().speedMps;
    for (let i = 0; i < 120; i += 1) {
      straightSim.stepFixed({ throttle: 0, brake: 1, handbrake: 0, steer: 0 }, FIXED_DT);
    }
    const straightDecelG =
      (straightEntrySpeed - straightSim.getSnapshot().speedMps) / 1.0 / GRAVITY_MPS2;
    expect(straightDecelG).toBeGreaterThanOrEqual(0.85);

    // Runtime toggle preserves state across reset() and floors CBC when inner front unloads over a kerb gap
    const kerbTro = parseTro(
      buildSyntheticTro({
        uvEntries: [],
        segments: [
          {
            centerRaw: [0, 0, 0],
            subMesh0: {
              // Ground strictly on x >= -0.35 m so left-side FL wheel unloads over a recess during left turn
              localVertices: [
                [-22, -6400, 0],
                [-22, 6400, 0],
                [6400, 6400, 0],
                [6400, -6400, 0],
              ],
              polygons: [{ listIndex: 2, vertices: [0, 1, 2, 3], colors: [{ r: 100, g: 100, b: 100 }] }],
            },
            subMesh1: { localVertices: [], polygons: [] },
          },
        ],
      }),
    );
    const kerbSim = new VehicleSimulation(spec, new CollisionIndex(buildCollisionMesh(kerbTro)), {
      initialPosition: { x: 0.45, y: spec.comHeightMeters, z: 40 },
      absEnabled: true,
    });
    kerbSim.setAbsEnabled(false);
    expect(kerbSim.isAbsEnabled()).toBe(false);
    kerbSim.setAbsEnabled(true);
    kerbSim.reset({ x: 0.45, y: spec.comHeightMeters, z: 40 }, 0);
    expect(kerbSim.isAbsEnabled()).toBe(true);

    for (let i = 0; i < 360; i += 1) {
      kerbSim.stepFixed({ throttle: 1, brake: 0, handbrake: 0, steer: 0 }, FIXED_DT);
      if (kerbSim.getSnapshot().speedKph >= 90) break;
    }
    const preKerbSpeed = kerbSim.getSnapshot().speedMps;
    let sawUnloadedInnerFront = false;
    let minOuterFrontFx = 0;
    for (let i = 0; i < 48; i += 1) {
      kerbSim.stepFixed({ throttle: 0, brake: 1, handbrake: 0, steer: 1 }, FIXED_DT);
      const snap = kerbSim.getSnapshot();
      if (!snap.wheels[0].grounded || snap.wheels[0].normalForce <= 1) {
        sawUnloadedInnerFront = true;
      }
      if (snap.wheels[1].longitudinalForceN < minOuterFrontFx) {
        minOuterFrontFx = snap.wheels[1].longitudinalForceN;
      }
    }
    const postKerbSpeed = kerbSim.getSnapshot().speedMps;
    expect(sawUnloadedInnerFront).toBe(true);
    expect(minOuterFrontFx).toBeLessThan(-1000);
    expect((preKerbSpeed - postKerbSpeed) / (48 * FIXED_DT) / GRAVITY_MPS2).toBeGreaterThan(0.45);
  });

  it('applies lower grip and higher rolling drag on TRO surfaceCode grass strips vs asphalt (M9.30)', () => {
    const spec = buildCarPhysicsSpec(createTestEntry());

    const makeSurfaceIndex = (surfaceCode: number) => {
      const segments: SyntheticSegmentSpec[] = [];
      for (let cellIdx = -1; cellIdx < 12; cellIdx += 1) {
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
            polygons: [
              {
                listIndex: 2,
                vertices: [0, 1, 2, 3],
                colors: [{ r: 100, g: 120, b: 100 }],
                surfaceCode,
              },
            ],
          },
          subMesh1: { localVertices: [], polygons: [] },
        });
      }
      return new CollisionIndex(buildCollisionMesh(parseTro(buildSyntheticTro({ uvEntries: [], segments }))));
    };

    const measureSurfaceBehavior = (surfaceCode: number) => {
      const sim = new VehicleSimulation(spec, makeSurfaceIndex(surfaceCode), {
        initialPosition: { x: 0, y: spec.comHeightMeters, z: 0 },
      });
      for (let i = 0; i < 600; i += 1) {
        sim.stepFixed({ throttle: 1, brake: 0, handbrake: 0, steer: 0 }, FIXED_DT);
        if (sim.getSnapshot().speedKph >= 90) break;
      }
      const coastStartSpeed = sim.getSnapshot().speedMps;
      for (let i = 0; i < 360; i += 1) {
        sim.stepFixed({ throttle: 0, brake: 0, handbrake: 0, steer: 0 }, FIXED_DT);
      }
      const coastEndSpeed = sim.getSnapshot().speedMps;
      const coastDropMps = coastStartSpeed - coastEndSpeed;

      // Measure peak lateral G under steering on the same surface
      const turnSim = new VehicleSimulation(spec, makeSurfaceIndex(surfaceCode), {
        initialPosition: { x: 0, y: spec.comHeightMeters, z: 0 },
      });
      for (let i = 0; i < 600; i += 1) {
        turnSim.stepFixed({ throttle: 1, brake: 0, handbrake: 0, steer: 0 }, FIXED_DT);
        if (turnSim.getSnapshot().speedKph >= 80) break;
      }
      let peakLatG = 0;
      for (let i = 0; i < 90; i += 1) {
        turnSim.stepFixed({ throttle: 0.3, brake: 0, handbrake: 0, steer: 0.7 }, FIXED_DT);
        const snap = turnSim.getSnapshot();
        const latG = (snap.speedMps * Math.abs(snap.angularVelocity.y)) / GRAVITY_MPS2;
        if (latG > peakLatG) peakLatG = latG;
      }

      return {
        detectedSurface: sim.getSnapshot().wheels[0].surfaceType,
        coastDropMps,
        peakLatG,
      };
    };

    const asphalt = measureSurfaceBehavior(TRO_SURFACE_ASPHALT);
    const grass = measureSurfaceBehavior(TRO_SURFACE_GRASS);

    expect(asphalt.detectedSurface).toBe('asphalt');
    expect(grass.detectedSurface).toBe('grass');
    expect(grass.coastDropMps).toBeGreaterThan(asphalt.coastDropMps * 1.15);
    expect(grass.peakLatG).toBeLessThan(asphalt.peakLatG * 0.75);
  });

  it('never leaves the car stuck sideways after a hard oblique wall slam (M9.31)', () => {
    const spec = buildCarPhysicsSpec(createTestEntry());
    const sim = new VehicleSimulation(spec, createWalledFlatTrackIndex(), {
      initialPosition: { x: -30, y: spec.comHeightMeters + 0.02, z: -100 },
      initialYawRad: 0.5,
    });
    let maxTilt = 0;
    for (let i = 0; i < 900; i += 1) {
      sim.stepFixed({ throttle: 1, brake: 0, handbrake: 0, steer: i < 200 ? 0.6 : 0 }, FIXED_DT);
      const up = quatRotateVec3(sim.getPose().orientation, { x: 0, y: 1, z: 0 });
      maxTilt = Math.max(maxTilt, Math.acos(Math.min(1, Math.max(-1, up.y))));
    }
    const snap = sim.getSnapshot();
    const up = quatRotateVec3(snap.pose.orientation, { x: 0, y: 1, z: 0 });
    expect(snap.wallCollisionCount).toBeGreaterThan(0);
    expect(maxTilt).toBeLessThan(1.0);
    expect(up.y).toBeGreaterThan(0.95);
    expect(snap.wheels.filter((w) => w.grounded).length).toBeGreaterThanOrEqual(3);
  });

  it('smoothly self-rights a car tipped beyond 70 degrees roll onto all 4 wheels (M9.31)', () => {
    const spec = buildCarPhysicsSpec(createTestEntry());
    const sim = new VehicleSimulation(spec, createWalledFlatTrackIndex(), {
      initialPosition: { x: 0, y: spec.comHeightMeters + 0.4, z: 0 },
      initialRollRad: 1.35,
    });
    let maxStepYSpeed = 0;
    let upAt1s = -1;
    for (let i = 0; i < 480; i += 1) {
      sim.stepFixed({ throttle: 0, brake: 0, handbrake: 0, steer: 0 }, FIXED_DT);
      maxStepYSpeed = Math.max(maxStepYSpeed, Math.abs(sim.getSnapshot().linearVelocity.y));
      if (i === 239) {
        upAt1s = quatRotateVec3(sim.getPose().orientation, { x: 0, y: 1, z: 0 }).y;
      }
    }
    const snap = sim.getSnapshot();
    const up = quatRotateVec3(snap.pose.orientation, { x: 0, y: 1, z: 0 });
    expect(upAt1s).toBeGreaterThan(0.9);
    expect(up.y).toBeGreaterThan(0.98);
    expect(snap.wheels.every((w) => w.grounded)).toBe(true);
    expect(maxStepYSpeed).toBeLessThan(6);
  });

  it('tracks planted on asphalt: low body slip while steering and fast yaw settling on release (M9.31)', () => {
    const spec = buildCarPhysicsSpec(createTestEntry());
    const sim = new VehicleSimulation(spec, createWalledFlatTrackIndex(), {
      initialPosition: { x: 0, y: spec.comHeightMeters + 0.02, z: 60 },
    });
    for (let i = 0; i < 1500 && sim.getSnapshot().speedKph < 80; i += 1) {
      sim.stepFixed({ throttle: 1, brake: 0, handbrake: 0, steer: 0 }, FIXED_DT);
    }
    let maxSlip = 0;
    for (let i = 0; i < 90; i += 1) {
      sim.stepFixed({ throttle: 0.3, brake: 0, handbrake: 0, steer: 0.25 }, FIXED_DT);
      const s = sim.getSnapshot();
      const right = quatRotateVec3(s.pose.orientation, VEC3_RIGHT);
      maxSlip = Math.max(
        maxSlip,
        Math.abs(Math.atan2(vec3Dot(s.linearVelocity, right), Math.max(4, s.forwardSpeedMps))),
      );
    }
    expect(maxSlip).toBeLessThan(0.14);
    for (let i = 0; i < 120; i += 1) {
      sim.stepFixed({ throttle: 0.3, brake: 0, handbrake: 0, steer: 0 }, FIXED_DT);
    }
    expect(Math.abs(sim.getSnapshot().angularVelocity.y)).toBeLessThan(0.08);
  });

  it('turns in crisply with W + A on both RWD and FWD layouts without plowing (M9.32)', () => {
    const baseSpec = buildCarPhysicsSpec(createTestEntry());
    const index = createFlatAsphaltCollisionIndex(4000, 4000);
    const layouts = [
      { name: 'RWD', split: 0 },
      { name: 'FWD', split: 1 },
    ] as const;
    for (const layout of layouts) {
      const spec = { ...baseSpec, drivetrain: { ...baseSpec.drivetrain, frontTorqueSplit: layout.split } };
      for (const targetKph of [60, 100, 140]) {
        const input = new InputManager({ initialContext: 'race' });
        const adapter = new DriveControlAdapter({ inputManager: input, gamepadProvider: () => [] });
        const sim = new VehicleSimulation(spec, index, {
          initialPosition: { x: 0, y: spec.comHeightMeters, z: 0 },
        });
        input.handleKeyEvent({ type: 'keydown', code: 'KeyW', repeat: false });
        for (let i = 0; i < 2400 && sim.getSnapshot().speedKph < targetKph; i += 1) {
          sim.stepFixed(adapter.step(FIXED_DT, sim.getSnapshot().speedMps).controls, FIXED_DT);
        }
        input.handleKeyEvent({ type: 'keydown', code: 'KeyA', repeat: false });
        let peakYaw = 0;
        let peakSlip = 0;
        const fwd0 = quatRotateVec3(sim.getPose().orientation, VEC3_FORWARD);
        for (let i = 0; i < 180; i += 1) {
          const s0 = sim.getSnapshot();
          sim.stepFixed(adapter.step(FIXED_DT, s0.speedMps).controls, FIXED_DT);
          const s = sim.getSnapshot();
          const right = quatRotateVec3(s.pose.orientation, VEC3_RIGHT);
          peakYaw = Math.max(peakYaw, s.angularVelocity.y);
          peakSlip = Math.max(
            peakSlip,
            Math.abs(Math.atan2(vec3Dot(s.linearVelocity, right), Math.max(4, s.forwardSpeedMps))),
          );
        }
        const fwd1 = quatRotateVec3(sim.getPose().orientation, VEC3_FORWARD);
        const heading = Math.acos(Math.min(1, Math.max(-1, fwd0.x * fwd1.x + fwd0.z * fwd1.z)));
        expect(peakYaw).toBeGreaterThan(0.25);
        expect(heading).toBeGreaterThan(0.35);
        expect(peakSlip).toBeLessThan(0.3);
      }
    }
  });
});