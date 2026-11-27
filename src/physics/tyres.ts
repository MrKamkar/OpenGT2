import { SURFACE_GRIP_MULTIPLIERS, type TyreCompoundPreset } from './carSpec';
import { clamp } from './math';
import type { PhysicsSurfaceType } from './types';

/** Regularization floor (m/s) for slip ratio and slip angle denominators near 0 km/h. */
export const TYRE_SLIP_MIN_SPEED_MPS = 1.0;

/** Upper clamp on dimensionless longitudinal slip ratio magnitude. */
export const TYRE_MAX_SLIP_RATIO = 2.0;

/** Contact patch speed threshold (m/s) below which low-speed viscous damping stabilizes parked cars. */
export const TYRE_LOW_SPEED_DAMP_THRESHOLD_MPS = 0.6;

/** Viscous damping coefficient at near-zero contact patch speed to prevent stationary jitter. */
export const TYRE_LOW_SPEED_VISCOUS_GAIN = 2.5;

/** Reference vertical wheel load (N) for tyre load sensitivity scaling. */
export const TYRE_LOAD_SENSITIVITY_REF_N = 4000;

/** Tyre friction sensitivity slope per reference load increment. */
export const TYRE_LOAD_SENSITIVITY_SLOPE = 0.08;

/** Minimum tyre load sensitivity multiplier under heavy vertical loads. */
export const TYRE_MIN_LOAD_SENSITIVITY = 0.75;

/** Hard clamp on wheel angular velocity (rad/s) to bound numerical spin integration. */
export const TYRE_MAX_SPIN_RAD_S = 400;

/** Multiplier strengthening lateral cornering stiffness (`B`) without altering longitudinal acceleration. */
export const TYRE_LATERAL_PACEJKA_B_SCALE = 1.28;

/** Scale factor applied to rear lateral tyre grip while the handbrake is pulled for clean drift initiation. */
export const TYRE_HANDBRAKE_LATERAL_GRIP_SCALE = 0.25;

export interface TyreForceInput {
  readonly normalForceN: number;
  readonly wheelAngularSpeedRadS: number;
  readonly wheelRadiusMeters: number;
  readonly patchForwardSpeedMps: number;
  readonly patchRightSpeedMps: number;
  readonly compound: TyreCompoundPreset;
  readonly surfaceType: PhysicsSurfaceType;
  readonly axle?: 'front' | 'rear';
  readonly handbrakeActive?: boolean;
}

export interface TyreForceOutput {
  readonly longitudinalForceN: number;
  readonly lateralForceN: number;
  readonly slipRatio: number;
  readonly slipAngleRad: number;
  readonly effectiveMu: number;
}

function pacejkaMagicFormula(x: number, b: number, c: number, e: number): number {
  const bx = b * x;
  const inner = bx - e * (bx - Math.atan(bx));
  return Math.sin(c * Math.atan(inner));
}

/**
 * Resolves effective compound × surface friction coefficient including load sensitivity.
 */
export function computeEffectiveTyreMu(
  compound: TyreCompoundPreset,
  surfaceType: PhysicsSurfaceType,
  normalForceN: number,
): number {
  if (normalForceN <= 0) {
    return 0;
  }

  let baseMu: number;
  if (compound.type === 7 && (surfaceType === 'gravel' || surfaceType === 'grass')) {
    // Dirt compound retains superior off-road grip on loose surfaces
    baseMu = compound.peakMuOffroad * (surfaceType === 'gravel' ? 1.0 : 0.85);
  } else {
    baseMu = compound.peakMuAsphalt * SURFACE_GRIP_MULTIPLIERS[surfaceType];
  }

  const loadDelta = (normalForceN - TYRE_LOAD_SENSITIVITY_REF_N) / TYRE_LOAD_SENSITIVITY_REF_N;
  const loadSensitivity = clamp(
    1 - TYRE_LOAD_SENSITIVITY_SLOPE * loadDelta,
    TYRE_MIN_LOAD_SENSITIVITY,
    1.12,
  );
  return Math.max(0.05, baseMu * loadSensitivity);
}

/**
 * Computes longitudinal (`+wheelForward`) and lateral (`+wheelRight`) tyre contact forces
 * using a simplified Pacejka Magic Formula, combined-slip friction circle clamping, and
 * low-speed slip regularization.
 */
export function computeTyreForces(input: TyreForceInput): TyreForceOutput {
  const fz = input.normalForceN;
  if (!Number.isFinite(fz) || fz <= 0) {
    return {
      longitudinalForceN: 0,
      lateralForceN: 0,
      slipRatio: 0,
      slipAngleRad: 0,
      effectiveMu: 0,
    };
  }

  const effectiveMu = computeEffectiveTyreMu(input.compound, input.surfaceType, fz);
  const peakForce = effectiveMu * fz;

  const wheelSurfaceSpeed = input.wheelAngularSpeedRadS * input.wheelRadiusMeters;
  const vRef = Math.max(Math.abs(input.patchForwardSpeedMps), TYRE_SLIP_MIN_SPEED_MPS);

  const slipRatio = clamp(
    (wheelSurfaceSpeed - input.patchForwardSpeedMps) / vRef,
    -TYRE_MAX_SLIP_RATIO,
    TYRE_MAX_SLIP_RATIO,
  );
  const slipAngleRad = Math.atan2(input.patchRightSpeedMps, vRef);

  const fxDrive =
    peakForce *
    pacejkaMagicFormula(
      slipRatio,
      input.compound.pacejkaB,
      input.compound.pacejkaC,
      input.compound.pacejkaE,
    );

  // Positive patchRightSpeedMps means sliding right -> lateral force acts left (-wheelRight)
  // Shape front vs. rear lateral curves for crisp grip turn-in and a progressive high-slip drift plateau.
  let lateralB = input.compound.pacejkaB * TYRE_LATERAL_PACEJKA_B_SCALE;
  let lateralC = Math.min(1.28, input.compound.pacejkaC);
  let lateralE = Math.min(0.45, input.compound.pacejkaE);
  if (input.axle === 'front') {
    lateralB = input.compound.pacejkaB * 1.32;
    lateralC = Math.min(1.32, input.compound.pacejkaC);
    lateralE = Math.min(0.20, input.compound.pacejkaE);
  } else if (input.axle === 'rear') {
    lateralB = input.compound.pacejkaB * 1.62;
    lateralC = Math.min(1.38, input.compound.pacejkaC);
    lateralE = -0.05;
  }

  let fyLat =
    -peakForce *
    pacejkaMagicFormula(slipAngleRad, lateralB, lateralC, lateralE);
  if (input.axle === 'rear' && input.handbrakeActive === true) {
    fyLat *= TYRE_HANDBRAKE_LATERAL_GRIP_SCALE;
  }

  // Rolling resistance opposes forward motion smoothly near 0 speed
  const rrFade = clamp(Math.abs(input.patchForwardSpeedMps) / 0.3, 0, 1);
  const rollingResistanceN =
    -Math.sign(input.patchForwardSpeedMps) *
    input.compound.rollingResistance *
    fz *
    rrFade;

  const fxRaw = fxDrive + rollingResistanceN;

  // Low-speed viscous lateral stabilization prevents stationary chatter on flat/sloped surfaces
  const patchSpeed = Math.hypot(input.patchForwardSpeedMps, input.patchRightSpeedMps);
  if (patchSpeed < TYRE_LOW_SPEED_DAMP_THRESHOLD_MPS) {
    const lowSpeedWeight = 1 - patchSpeed / TYRE_LOW_SPEED_DAMP_THRESHOLD_MPS;
    const viscousFy =
      (-TYRE_LOW_SPEED_VISCOUS_GAIN * fz * input.patchRightSpeedMps) /
      TYRE_SLIP_MIN_SPEED_MPS;
    fyLat = fyLat * (1 - lowSpeedWeight) + viscousFy * lowSpeedWeight;
  }

  // Combined-slip traction circle clamp: hypot(Fx, Fy) <= mu * Fz
  let fx = fxRaw;
  let fy = fyLat;
  const totalMag = Math.hypot(fx, fy);
  if (totalMag > peakForce && totalMag > 1e-6) {
    const scale = peakForce / totalMag;
    fx *= scale;
    fy *= scale;
  }

  return {
    longitudinalForceN: fx,
    lateralForceN: fy,
    slipRatio,
    slipAngleRad,
    effectiveMu,
  };
}

/**
 * Integrates wheel rotational speed by `dt` under drive torque, tyre reaction torque,
 * and clamping brake torque so braking brings a wheel cleanly to `0 rad/s` without reversal.
 */
export function stepWheelSpin(
  wheelOmegaRadS: number,
  driveTorqueNm: number,
  brakeTorqueNm: number,
  tyreLongitudinalForceN: number,
  wheelRadiusMeters: number,
  wheelInertiaKgM2: number,
  patchForwardSpeedMps: number,
  dt: number,
): number {
  if (!Number.isFinite(dt) || dt <= 0) {
    return wheelOmegaRadS;
  }

  const inertia = Math.max(0.05, wheelInertiaKgM2);
  const roadReactionTorque = tyreLongitudinalForceN * wheelRadiusMeters;
  const netTorqueNoBrake = driveTorqueNm - roadReactionTorque;

  let nextOmega = clamp(
    wheelOmegaRadS + (netTorqueNoBrake / inertia) * dt,
    -TYRE_MAX_SPIN_RAD_S,
    TYRE_MAX_SPIN_RAD_S,
  );

  if (brakeTorqueNm > 0) {
    const maxBrakeDelta = (brakeTorqueNm / inertia) * dt;
    if (Math.abs(nextOmega) <= maxBrakeDelta) {
      nextOmega = 0;
    } else {
      nextOmega -= Math.sign(nextOmega) * maxBrakeDelta;
    }

    if (Math.abs(driveTorqueNm) < 1e-4 && Math.abs(patchForwardSpeedMps) < 0.15) {
      nextOmega = 0;
    }
  }

  return Number.isFinite(nextOmega) ? nextOmega : 0;
}
