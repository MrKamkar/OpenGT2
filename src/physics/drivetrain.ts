import type { CarPhysicsSpec } from './carSpec';
import { clamp, lerp } from './math';
import type { TransmissionMode, VehicleControls, WheelSlotTuple } from './types';

/** Cooldown duration (s) after an automatic gear shift to prevent rapid gear hunting. */
export const AUTO_SHIFT_COOLDOWN_SECONDS = 0.25;

/** Fraction of redline RPM at which automatic mode upshifts under throttle. */
export const AUTO_UPSHIFT_RPM_FRACTION = 0.94;

/** Baseline fraction of redline RPM at which automatic mode downshifts. */
export const AUTO_DOWNSHIFT_RPM_FRACTION = 0.45;

/** Minimum RPM separation between post-upshift RPM and downshift threshold to avoid gear hunting. */
export const AUTO_MIN_SHIFT_HYSTERESIS_RPM = 600;

/** Minimum throttle input required to trigger an automatic upshift. */
export const AUTO_UPSHIFT_MIN_THROTTLE = 0.2;

/** Maximum forward speed (m/s) below which automatic mode engages Reverse while braking. */
export const REVERSE_ENGAGE_MAX_SPEED_MPS = 0.5;

/** Minimum forward speed (m/s) above which automatic mode exits Reverse into 1st gear under throttle. */
export const REVERSE_EXIT_MIN_SPEED_MPS = -0.5;

/** RPM hysteresis band below `redlineRpm` before the rev limiter re-enables combustion torque. */
export const REV_LIMITER_HYSTERESIS_RPM = 150;

/** RPM span above `idleRpm` over which the launch clutch smoothly engages. */
export const CLUTCH_ENGAGE_RPM_BAND = 800;

/** Clutch coupling viscous stiffness (N·m / (rad/s)) between flywheel and transmission input shaft. */
export const CLUTCH_COUPLING_GAIN_NM_S_PER_RAD = 2.5;

/** Maximum throttle applied by the engine idle speed governor when pedal throttle is 0. */
export const IDLE_GOVERNOR_MAX_THROTTLE = 0.22;

/** Viscous damping coefficient (N·m·s/rad) used by the LSD differential torque transfer model. */
export const LSD_SPEED_DAMPING_NM_S_PER_RAD = 35;

/** Conversion factors between RPM and rad/s. */
export const RPM_TO_RAD_S = Math.PI / 30;
export const RAD_S_TO_RPM = 30 / Math.PI;

export interface DrivetrainState {
  gear: number; // -1 = Reverse, 0 = Neutral, 1..N = forward gears
  engineRpm: number;
  engineTorqueNm: number;
  clutchEngagement: number;
  clutchTorqueNm: number;
  revLimiterActive: boolean;
  shiftCooldown: number;
  transmissionMode: TransmissionMode;
  wheelDriveTorquesNm: WheelSlotTuple<number>;
}

export function createDrivetrainState(
  spec: CarPhysicsSpec,
  transmissionMode: TransmissionMode = 'auto',
): DrivetrainState {
  return {
    gear: 1,
    engineRpm: spec.engine.idleRpm,
    engineTorqueNm: 0,
    clutchEngagement: 0,
    clutchTorqueNm: 0,
    revLimiterActive: false,
    shiftCooldown: 0,
    transmissionMode,
    wheelDriveTorquesNm: [0, 0, 0, 0],
  };
}

/**
 * Evaluates wide-open-throttle engine torque (N·m) at `rpm` via piecewise-linear interpolation
 * over the sanitized `CarEngineData` torque curve.
 */
export function sampleEngineTorqueNm(spec: CarPhysicsSpec, rpm: number): number {
  const curve = spec.engine.torqueCurve;
  if (curve.length === 0 || !Number.isFinite(rpm) || rpm <= 0) {
    return 0;
  }

  const first = curve[0]!;
  if (rpm <= first.rpm) {
    const t = clamp(rpm / Math.max(1, first.rpm), 0, 1);
    return first.torqueNm * (0.5 + 0.5 * t);
  }

  const last = curve[curve.length - 1]!;
  if (rpm >= last.rpm) {
    const overFrac = clamp((rpm - last.rpm) / 1000, 0, 0.8);
    return last.torqueNm * (1 - overFrac);
  }

  for (let i = 1; i < curve.length; i += 1) {
    const a = curve[i - 1]!;
    const b = curve[i]!;
    if (rpm <= b.rpm) {
      const span = Math.max(1e-6, b.rpm - a.rpm);
      const t = (rpm - a.rpm) / span;
      return lerp(a.torqueNm, b.torqueNm, t);
    }
  }

  return last.torqueNm;
}

export function getGearRatio(spec: CarPhysicsSpec, gear: number): number {
  if (gear === -1) {
    return spec.drivetrain.reverseRatio;
  }
  if (gear <= 0) {
    return 0;
  }
  return spec.drivetrain.gearRatios[gear - 1] ?? 0;
}

function computeDrivenShaftOmega(
  spec: CarPhysicsSpec,
  wheelAngularSpeeds: WheelSlotTuple<number>,
  totalRatio: number,
): number {
  const frontSplit = spec.drivetrain.frontTorqueSplit;
  const rearSplit = 1 - frontSplit;
  const frontAvg = (wheelAngularSpeeds[0] + wheelAngularSpeeds[1]) * 0.5;
  const rearAvg = (wheelAngularSpeeds[2] + wheelAngularSpeeds[3]) * 0.5;
  const wheelOmega = frontAvg * frontSplit + rearAvg * rearSplit;
  return wheelOmega * totalRatio;
}

function distributeAxleTorque(
  axleTorqueNm: number,
  leftOmega: number,
  rightOmega: number,
  spec: CarPhysicsSpec,
): readonly [number, number] {
  if (Math.abs(axleTorqueNm) <= 1e-9 && spec.drivetrain.differentialKind === 'open') {
    return [0, 0];
  }

  const half = axleTorqueNm * 0.5;
  if (
    spec.drivetrain.differentialKind === 'open' ||
    spec.drivetrain.lsdLockingFactor <= 0
  ) {
    return [half, half];
  }

  const lock = spec.drivetrain.lsdLockingFactor;
  const maxTransfer =
    (spec.drivetrain.lsdPreloadNm + Math.abs(axleTorqueNm) * 0.5) * lock;
  const deltaOmega = leftOmega - rightOmega;
  const transfer = clamp(
    deltaOmega * LSD_SPEED_DAMPING_NM_S_PER_RAD * lock,
    -maxTransfer,
    maxTransfer,
  );

  // Slower wheel receives additional torque while faster wheel loses the same amount
  return [half - transfer, half + transfer];
}

/**
 * Advances engine RPM, rev limiter, clutch coupling, gearbox (automatic hysteresis+cooldown or manual),
 * and FF/FR/MR/4WD open/LSD wheel torque distribution by `dt` seconds.
 */
export function stepDrivetrain(
  state: DrivetrainState,
  spec: CarPhysicsSpec,
  controls: VehicleControls,
  wheelAngularSpeeds: WheelSlotTuple<number>,
  forwardSpeedMps: number,
  dt: number,
): void {
  if (!Number.isFinite(dt) || dt <= 0) {
    return;
  }

  const throttle = clamp(controls.throttle, 0, 1);
  const brake = clamp(controls.brake, 0, 1);
  const maxGear = spec.drivetrain.gearRatios.length;

  state.shiftCooldown = Math.max(0, state.shiftCooldown - dt);

  // 1. Gear selection
  if (state.transmissionMode === 'manual') {
    if (controls.shiftUp === true && state.gear < maxGear) {
      state.gear += 1;
      state.shiftCooldown = AUTO_SHIFT_COOLDOWN_SECONDS;
    } else if (controls.shiftDown === true && state.gear > -1) {
      state.gear -= 1;
      state.shiftCooldown = AUTO_SHIFT_COOLDOWN_SECONDS;
    }
  } else {
    // Automatic transmission with hysteresis and shift cooldown
    if (state.gear === 0) {
      state.gear = 1;
    } else if (state.gear === -1) {
      if (
        throttle > 0.1 &&
        forwardSpeedMps >= REVERSE_EXIT_MIN_SPEED_MPS &&
        state.shiftCooldown <= 0
      ) {
        state.gear = 1;
        state.shiftCooldown = AUTO_SHIFT_COOLDOWN_SECONDS;
      }
    } else {
      // Forward gear >= 1
      if (
        state.gear === 1 &&
        forwardSpeedMps <= REVERSE_ENGAGE_MAX_SPEED_MPS &&
        brake > 0.5 &&
        throttle < 0.05 &&
        state.shiftCooldown <= 0
      ) {
        state.gear = -1;
        state.shiftCooldown = AUTO_SHIFT_COOLDOWN_SECONDS;
      } else if (state.shiftCooldown <= 0) {
        const upshiftRpm = Math.max(
          spec.engine.idleRpm + 1000,
          spec.engine.redlineRpm * AUTO_UPSHIFT_RPM_FRACTION,
        );

        if (
          state.gear < maxGear &&
          state.engineRpm >= upshiftRpm &&
          throttle >= AUTO_UPSHIFT_MIN_THROTTLE
        ) {
          state.gear += 1;
          state.shiftCooldown = AUTO_SHIFT_COOLDOWN_SECONDS;
        } else if (state.gear > 1) {
          const currRatio = spec.drivetrain.gearRatios[state.gear - 1] ?? 1;
          const lowerRatio = spec.drivetrain.gearRatios[state.gear - 2] ?? currRatio;
          const postUpshiftRpm = upshiftRpm * (currRatio / Math.max(0.1, lowerRatio));
          const downshiftRpm = clamp(
            Math.min(
              spec.engine.redlineRpm * AUTO_DOWNSHIFT_RPM_FRACTION,
              postUpshiftRpm - AUTO_MIN_SHIFT_HYSTERESIS_RPM,
            ),
            spec.engine.idleRpm + 200,
            upshiftRpm - AUTO_MIN_SHIFT_HYSTERESIS_RPM,
          );

          if (state.engineRpm <= downshiftRpm) {
            state.gear -= 1;
            state.shiftCooldown = AUTO_SHIFT_COOLDOWN_SECONDS;
          }
        }
      }
    }
  }

  // 2. Rev limiter with hysteresis
  if (state.engineRpm >= spec.engine.redlineRpm) {
    state.revLimiterActive = true;
  } else if (state.engineRpm <= spec.engine.redlineRpm - REV_LIMITER_HYSTERESIS_RPM) {
    state.revLimiterActive = false;
  }

  // 3. Engine combustion + idle governor + engine braking
  const wotTorqueNm = sampleEngineTorqueNm(spec, state.engineRpm);
  let effectiveThrottle = throttle;
  if (throttle < IDLE_GOVERNOR_MAX_THROTTLE && state.engineRpm < spec.engine.idleRpm) {
    const idleErrorFrac = clamp(
      (spec.engine.idleRpm - state.engineRpm) / 300,
      0,
      1,
    );
    effectiveThrottle = Math.max(throttle, idleErrorFrac * IDLE_GOVERNOR_MAX_THROTTLE);
  }

  const combustionTorqueNm = state.revLimiterActive ? 0 : wotTorqueNm * effectiveThrottle;
  const offThrottleFactor = clamp(1 - throttle / 0.08, 0, 1);
  const rpmAboveIdleFrac = clamp(
    (state.engineRpm - spec.engine.idleRpm * 0.75) / 1500,
    0,
    1,
  );
  const engineBrakingNm =
    spec.engine.engineBrakingTorqueNm * offThrottleFactor * rpmAboveIdleFrac;
  const netEngineInternalTorqueNm = combustionTorqueNm - engineBrakingNm;
  state.engineTorqueNm = netEngineInternalTorqueNm;

  // 4. Clutch coupling
  const gearRatio = getGearRatio(spec, state.gear);
  const totalRatio = gearRatio * spec.drivetrain.finalDriveRatio;
  const shaftOmega = computeDrivenShaftOmega(spec, wheelAngularSpeeds, totalRatio);
  const engineOmega = state.engineRpm * RPM_TO_RAD_S;
  const lockThresholdRpm = spec.engine.idleRpm * 0.95;

  let clutchEngagement = 0;
  const holdingStillWithBrake =
    throttle < 0.05 && (brake > 0.05 || Math.abs(forwardSpeedMps) < 0.35);

  if (state.gear !== 0 && !holdingStillWithBrake) {
    const shaftRpm = shaftOmega * RAD_S_TO_RPM;
    if (shaftRpm >= lockThresholdRpm) {
      clutchEngagement = 1.0;
    } else {
      const rpmLift = clamp(
        (state.engineRpm - spec.engine.idleRpm * 0.9) / CLUTCH_ENGAGE_RPM_BAND,
        0,
        1,
      );
      clutchEngagement = clamp(throttle * 0.7 + rpmLift * 0.5, 0, 1);
    }
  }
  state.clutchEngagement = clutchEngagement;

  let clutchTorqueNm = 0;
  if (clutchEngagement > 0) {
    const slipOmega = engineOmega - shaftOmega;
    const ratioSq = Math.max(1, totalRatio * totalRatio);
    const safeDt = Math.max(dt, 1e-4);
    const minWheelInertia = Math.min(spec.wheels[0].inertiaKgM2, spec.wheels[2].inertiaKgM2);
    const maxStableGain =
      (0.35 * Math.max(0.2, minWheelInertia)) /
      (0.5 * ratioSq * Math.max(0.5, spec.drivetrain.drivetrainEfficiency) * safeDt);
    const effectiveClutchGain = Math.min(CLUTCH_COUPLING_GAIN_NM_S_PER_RAD, maxStableGain);

    if (clutchEngagement >= 0.95) {
      const rawClutchTorque = slipOmega * effectiveClutchGain;
      // Transmit full net engine torque once locked; drivetrainEfficiency handles mechanical losses
      const blendedTorque = netEngineInternalTorqueNm + rawClutchTorque;
      clutchTorqueNm = clamp(
        blendedTorque,
        -spec.drivetrain.clutchMaxTorqueNm,
        spec.drivetrain.clutchMaxTorqueNm,
      );
    } else {
      const rawClutchTorque = Math.max(0, slipOmega) * effectiveClutchGain * clutchEngagement;
      const blendedTorque = netEngineInternalTorqueNm * clutchEngagement + rawClutchTorque;
      clutchTorqueNm = clamp(
        blendedTorque,
        -spec.drivetrain.clutchMaxTorqueNm,
        spec.drivetrain.clutchMaxTorqueNm,
      );
    }
  }
  state.clutchTorqueNm = clutchTorqueNm;

  // 5. Flywheel integration
  const flywheelTorqueNm = netEngineInternalTorqueNm - clutchTorqueNm;
  let nextEngineOmega =
    engineOmega + (flywheelTorqueNm / spec.engine.flywheelInertiaKgM2) * dt;

  // Keep locked clutch smoothly coupled to wheel speed across the full lockup band
  const shaftRpm = shaftOmega * RAD_S_TO_RPM;
  if (clutchEngagement >= 0.95 && shaftRpm >= lockThresholdRpm) {
    nextEngineOmega = lerp(nextEngineOmega, shaftOmega, 0.35);
  }

  const minEngineOmega = spec.engine.idleRpm * 0.7 * RPM_TO_RAD_S;
  const maxEngineOmega = (spec.engine.redlineRpm + 250) * RPM_TO_RAD_S;
  state.engineRpm = clamp(
    nextEngineOmega * RAD_S_TO_RPM,
    minEngineOmega * RAD_S_TO_RPM,
    maxEngineOmega * RAD_S_TO_RPM,
  );

  // 6. Axle split & open/LSD differential
  if (state.gear === 0 || clutchEngagement <= 0) {
    state.wheelDriveTorquesNm = [0, 0, 0, 0];
    return;
  }

  const totalAxleTorqueNm =
    clutchTorqueNm * totalRatio * spec.drivetrain.drivetrainEfficiency;
  const frontSplit = spec.drivetrain.frontTorqueSplit;
  const rearSplit = 1 - frontSplit;

  let fl = 0;
  let fr = 0;
  let rl = 0;
  let rr = 0;

  if (frontSplit > 0) {
    const [leftT, rightT] = distributeAxleTorque(
      totalAxleTorqueNm * frontSplit,
      wheelAngularSpeeds[0],
      wheelAngularSpeeds[1],
      spec,
    );
    fl = leftT;
    fr = rightT;
  }

  if (rearSplit > 0) {
    const [leftT, rightT] = distributeAxleTorque(
      totalAxleTorqueNm * rearSplit,
      wheelAngularSpeeds[2],
      wheelAngularSpeeds[3],
      spec,
    );
    rl = leftT;
    rr = rightT;
  }

  state.wheelDriveTorquesNm = [fl, fr, rl, rr];
}
