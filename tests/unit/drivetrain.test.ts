import { describe, expect, it } from 'vitest';
import type { CarCatalogEntry } from '../../src/formats/gtdb';
import {
  type BuildCarPhysicsSpecOptions,
  buildCarPhysicsSpec,
} from '../../src/physics/carSpec';
import {
  AUTO_REVERSE_HOLD_SECONDS,
  AUTO_SHIFT_COOLDOWN_SECONDS,
  createDrivetrainState,
  getGearRatio,
  resolveDrivetrainPedals,
  sampleEngineTorqueNm,
  stepDrivetrain,
} from '../../src/physics/drivetrain';
import { FIXED_DT } from '../../src/physics/fixedStep';
import type { WheelSlotTuple } from '../../src/physics/types';

function createTestSpec(options: BuildCarPhysicsSpecOptions = {}) {
  const entry: CarCatalogEntry = {
    carId: 42,
    carIdHex: '0x0000002a',
    name: { displayName: 'Drivetrain Test', firstPart: 'Drivetrain', secondPart: 'Test', isFallback: false },
    carData: {
      carId: 42,
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
      year: 98,
      unk_0x42: 0,
      newPrice: 20000,
    },
    dimensions: {
      carId: 42,
      unk_0x04: 0,
      length: 4300,
      height: 1300,
      unk_0x0c: 0,
      weightKg: 1250,
      rmWeightMultiplier: 50,
      unk_0x11: 0,
      unk_0x12: 0,
    },
    engine: {
      carId: 42,
      engineTypeNameIndex: 0,
      engineTypeName2Index: 0,
      unk_0x08: 0,
      unk_0x0a: 0,
      bandAcceleration: [1500, 2100, 2600, 2800, 2700, 2400, 2000],
      engineCc: 2500,
      ps: 250,
      maxPowerRpmRaw: 680,
      torqueKgmRaw: 280,
      torqueRpmStringIndex: 0,
      baseUnits: [1, 1, 1, 1, 1],
      bandRpms: [10, 20, 35, 50, 60, 70, 75],
      bandPointCount: 7,
    },
    engineSummary: null,
    gearboxes: [
      {
        carId: 42,
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
  return buildCarPhysicsSpec(entry, options);
}

describe('Drivetrain model (M9.5)', () => {
  it('interpolates torque curve and idles stably with zero throttle', () => {
    const spec = createTestSpec();
    expect(sampleEngineTorqueNm(spec, 5000)).toBeCloseTo(2800 * 0.01 * 9.80665, 3);
    expect(sampleEngineTorqueNm(spec, 0)).toBe(0);

    const state = createDrivetrainState(spec, 'auto');
    const stoppedWheels: WheelSlotTuple<number> = [0, 0, 0, 0];

    for (let i = 0; i < 240; i += 1) {
      stepDrivetrain(
        state,
        spec,
        { throttle: 0, brake: 0, handbrake: 0, steer: 0 },
        stoppedWheels,
        0,
        FIXED_DT,
      );
    }

    expect(state.engineRpm).toBeGreaterThanOrEqual(spec.engine.idleRpm * 0.85);
    expect(state.engineRpm).toBeLessThanOrEqual(spec.engine.idleRpm * 1.15);
    expect(state.wheelDriveTorquesNm).toEqual([0, 0, 0, 0]);
  });

  it('upshifts cleanly with cooldown and hysteresis without rapid gear hunting', () => {
    const spec = createTestSpec();
    const state = createDrivetrainState(spec, 'auto');
    let speed = 5; // m/s
    const shiftHistory: { step: number; gear: number }[] = [];
    let prevGear = state.gear;

    for (let i = 0; i < 600; i += 1) {
      // Simulate wheel omega consistent with vehicle speed
      const omega = speed / spec.wheels[2].radiusMeters;
      const wheelOmegas: WheelSlotTuple<number> = [omega, omega, omega, omega];
      stepDrivetrain(
        state,
        spec,
        { throttle: 1, brake: 0, handbrake: 0, steer: 0 },
        wheelOmegas,
        speed,
        FIXED_DT,
      );
      if (state.gear !== prevGear) {
        shiftHistory.push({ step: i, gear: state.gear });
        prevGear = state.gear;
      }
      // Smooth acceleration
      speed += 8.0 * FIXED_DT;
    }

    expect(state.gear).toBeGreaterThanOrEqual(3);
    // Verify monotonic upshifts with no hunting and cooldown respected
    for (let i = 1; i < shiftHistory.length; i += 1) {
      expect(shiftHistory[i]!.gear).toBeGreaterThan(shiftHistory[i - 1]!.gear);
      const dtBetween = (shiftHistory[i]!.step - shiftHistory[i - 1]!.step) * FIXED_DT;
      expect(dtBetween).toBeGreaterThanOrEqual(AUTO_SHIFT_COOLDOWN_SECONDS - 1e-6);
    }
  });

  it('engages reverse in auto mode after holding brake near standstill, routes S to reverse throttle and W to brake, and returns to 1st cleanly', () => {
    const spec = createTestSpec();
    const state = createDrivetrainState(spec, 'auto');

    // Moving forward at 10 m/s and braking must NOT engage reverse
    const fastOmega = 10 / spec.wheels[2].radiusMeters;
    for (let i = 0; i < 30; i += 1) {
      stepDrivetrain(
        state,
        spec,
        { throttle: 0, brake: 1, handbrake: 0, steer: 0 },
        [fastOmega, fastOmega, fastOmega, fastOmega],
        10,
        FIXED_DT,
      );
      expect(state.gear).toBe(1);
    }

    // Brief brake pulse (< 0.15 s) at standstill stays in 1st gear
    for (let i = 0; i < 12; i += 1) {
      stepDrivetrain(
        state,
        spec,
        { throttle: 0, brake: 1, handbrake: 0, steer: 0 },
        [0, 0, 0, 0],
        0.1,
        FIXED_DT,
      );
    }
    expect(state.gear).toBe(1);

    // Holding brake past AUTO_REVERSE_HOLD_SECONDS at standstill shifts to Reverse (-1),
    // clears service brake, and outputs negative reverse wheel torque
    const holdSteps = Math.ceil(AUTO_REVERSE_HOLD_SECONDS / FIXED_DT) + 4;
    for (let i = 0; i < holdSteps; i += 1) {
      stepDrivetrain(
        state,
        spec,
        { throttle: 0, brake: 1, handbrake: 0, steer: 0 },
        [0, 0, 0, 0],
        0.1,
        FIXED_DT,
      );
    }
    expect(state.gear).toBe(-1);
    expect(state.effectiveBrake).toBe(0);
    expect(getGearRatio(spec, -1)).toBeLessThan(0);
    expect(state.wheelDriveTorquesNm[2]).toBeLessThan(0);
    expect(resolveDrivetrainPedals('auto', -1, 0, 1)).toEqual({
      engineThrottle: 1,
      serviceBrake: 0,
    });

    // While reversing at -5 m/s, pressing W (throttle=1) applies service brake and stays in R until ~0 m/s
    const revOmega = -5 / spec.wheels[2].radiusMeters;
    for (let i = 0; i < 35; i += 1) {
      stepDrivetrain(
        state,
        spec,
        { throttle: 1, brake: 0, handbrake: 0, steer: 0 },
        [revOmega, revOmega, revOmega, revOmega],
        -5,
        FIXED_DT,
      );
      expect(state.gear).toBe(-1);
      expect(state.effectiveBrake).toBe(1);
      expect(state.wheelDriveTorquesNm).toEqual([0, 0, 0, 0]);
    }

    // Once speed drops near 0 (-0.1 m/s) with W held, shifts back to 1st and drives forward
    stepDrivetrain(
      state,
      spec,
      { throttle: 0.6, brake: 0, handbrake: 0, steer: 0 },
      [0, 0, 0, 0],
      -0.1,
      FIXED_DT,
    );
    expect(state.gear).toBe(1);
    expect(state.effectiveBrake).toBe(0);
    expect(state.wheelDriveTorquesNm[2]).toBeGreaterThan(0);

    // Manual mode must never auto-shift into or out of Reverse via brake/throttle holds
    const manualState = createDrivetrainState(spec, 'manual');
    for (let i = 0; i < 40; i += 1) {
      stepDrivetrain(
        manualState,
        spec,
        { throttle: 0, brake: 1, handbrake: 0, steer: 0 },
        [0, 0, 0, 0],
        0,
        FIXED_DT,
      );
    }
    expect(manualState.gear).toBe(1);
    expect(manualState.effectiveBrake).toBe(1);
  });

  it('respects manual shifting bounds and caps RPM at rev limiter', () => {
    const spec = createTestSpec();
    const state = createDrivetrainState(spec, 'manual');

    // Downshift 1 -> N -> R -> clamped at R
    stepDrivetrain(
      state,
      spec,
      { throttle: 0, brake: 0, handbrake: 0, steer: 0, shiftDown: true },
      [0, 0, 0, 0],
      0,
      FIXED_DT,
    );
    expect(state.gear).toBe(0);

    stepDrivetrain(
      state,
      spec,
      { throttle: 0, brake: 0, handbrake: 0, steer: 0, shiftDown: true },
      [0, 0, 0, 0],
      0,
      FIXED_DT,
    );
    expect(state.gear).toBe(-1);

    stepDrivetrain(
      state,
      spec,
      { throttle: 0, brake: 0, handbrake: 0, steer: 0, shiftDown: true },
      [0, 0, 0, 0],
      0,
      FIXED_DT,
    );
    expect(state.gear).toBe(-1);

    // Neutral full-throttle hits rev limiter and stays bounded near redline
    stepDrivetrain(
      state,
      spec,
      { throttle: 0, brake: 0, handbrake: 0, steer: 0, shiftUp: true },
      [0, 0, 0, 0],
      0,
      FIXED_DT,
    );
    expect(state.gear).toBe(0);
    for (let i = 0; i < 360; i += 1) {
      stepDrivetrain(
        state,
        spec,
        { throttle: 1, brake: 0, handbrake: 0, steer: 0 },
        [0, 0, 0, 0],
        0,
        FIXED_DT,
      );
    }
    expect(state.engineRpm).toBeLessThanOrEqual(spec.engine.redlineRpm + 250);
    expect(state.revLimiterActive || state.engineRpm >= spec.engine.redlineRpm - 200).toBe(true);
  });

  it('routes torque accurately for FF, FR, MR, 4WD and transfers LSD torque to slower wheel', () => {
    const layouts = ['FF', 'FR', 'MR', '4WD'] as const;
    for (const layout of layouts) {
      const spec = createTestSpec({ driveLayout: layout, differentialKind: 'open' });
      const state = createDrivetrainState(spec, 'manual');
      state.engineRpm = 3500;
      stepDrivetrain(
        state,
        spec,
        { throttle: 1, brake: 0, handbrake: 0, steer: 0 },
        [10, 10, 10, 10],
        3,
        FIXED_DT,
      );
      const [fl, fr, rl, rr] = state.wheelDriveTorquesNm;
      if (layout === 'FF') {
        expect(fl).toBeGreaterThan(0);
        expect(fr).toBeGreaterThan(0);
        expect(rl).toBe(0);
        expect(rr).toBe(0);
      } else if (layout === 'FR' || layout === 'MR') {
        expect(fl).toBe(0);
        expect(fr).toBe(0);
        expect(rl).toBeGreaterThan(0);
        expect(rr).toBeGreaterThan(0);
      } else {
        expect(fl).toBeGreaterThan(0);
        expect(fr).toBeGreaterThan(0);
        expect(rl).toBeGreaterThan(0);
        expect(rr).toBeGreaterThan(0);
      }
    }

    // LSD test: rear-left spinning faster than rear-right -> rear-right gets higher torque
    const lsdSpec = createTestSpec({
      driveLayout: 'FR',
      differentialKind: 'lsd',
      lsdLockingFactor: 0.5,
    });
    const lsdState = createDrivetrainState(lsdSpec, 'manual');
    lsdState.engineRpm = 4000;
    stepDrivetrain(
      lsdState,
      lsdSpec,
      { throttle: 1, brake: 0, handbrake: 0, steer: 0 },
      [0, 0, 40, 10],
      4,
      FIXED_DT,
    );
    expect(lsdState.wheelDriveTorquesNm[3]).toBeGreaterThan(lsdState.wheelDriveTorquesNm[2]);
  });

  it('blocks automatic upshifts during low-speed wheelspin and shifts only once road speed matches RPM', () => {
    const spec = createTestSpec();
    const state = createDrivetrainState(spec, 'auto');

    // Pin driven wheels at redline-equivalent spin while chassis road speed is only 5 m/s (18 km/h)
    const wheelSpinOmega =
      ((spec.engine.redlineRpm * Math.PI) / 30) /
      (spec.drivetrain.gearRatios[0]! * spec.drivetrain.finalDriveRatio);

    for (let i = 0; i < 120; i += 1) {
      stepDrivetrain(
        state,
        spec,
        { throttle: 1, brake: 0, handbrake: 0, steer: 0 },
        [5 / spec.wheels[0].radiusMeters, 5 / spec.wheels[1].radiusMeters, wheelSpinOmega, wheelSpinOmega],
        5.0,
        FIXED_DT,
        1.8, // severe wheelspin slip ratio
      );
    }
    expect(state.gear).toBe(1);

    // Once traction hooks up (slipRatio = 0.08) and chassis speed matches ~95% of 1st-gear redline, upshift fires
    const hookedSpeedMps =
      ((spec.engine.redlineRpm * 0.95 * Math.PI) / 30) /
      (spec.drivetrain.gearRatios[0]! * spec.drivetrain.finalDriveRatio) *
      spec.wheels[2].radiusMeters;
    const hookedOmega = hookedSpeedMps / spec.wheels[2].radiusMeters;

    for (let i = 0; i < 40; i += 1) {
      stepDrivetrain(
        state,
        spec,
        { throttle: 1, brake: 0, handbrake: 0, steer: 0 },
        [hookedOmega, hookedOmega, hookedOmega, hookedOmega],
        hookedSpeedMps,
        FIXED_DT,
        0.08,
      );
    }
    expect(state.gear).toBe(2);
  });
});
