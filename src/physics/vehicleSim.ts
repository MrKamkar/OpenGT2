import { type CarPhysicsSpec } from './carSpec';
import { type CollisionIndex } from './collisionIndex';
import {
  type DrivetrainState,
  computeReflectedWheelInertiaKgM2,
  createDrivetrainState,
  stepDrivetrain,
} from './drivetrain';
import {
  FIXED_DT,
  FixedTimestepLoop,
  MAX_FRAME_DT,
  interpolateVehiclePose,
} from './fixedStep';
import {
  VEC3_FORWARD,
  VEC3_RIGHT,
  VEC3_UP,
  clamp,
  isFiniteQuat,
  isFiniteVec3,
  quatFromAxisAngle,
  quatMultiply,
  quatRotateVec3,
  vec3Add,
  vec3Cross,
  vec3Dot,
  vec3Length,
  vec3Normalize,
  vec3Scale,
  vec3Sub,
} from './math';
import {
  type RigidBodyParams,
  type RigidBodyState,
  applyAerodynamicForces,
  applyGravityForce,
  applyWorldForceAtPoint,
  applyWorldTorque,
  createRigidBodyParamsFromSpec,
  createRigidBodyState,
  getWorldPointVelocity,
  integrateRigidBody,
} from './rigidBody';
import {
  type WheelSuspensionState,
  castSuspensionRays,
  createInitialSuspensionStates,
  solveSuspension,
} from './suspension';
import {
  type PhysicsQuat,
  type PhysicsSurfaceType,
  type PhysicsVec3,
  type TransmissionMode,
  type VehicleControls,
  type VehiclePose,
  type WheelSlotTuple,
} from './types';
import { computeTyreForces, stepWheelSpin } from './tyres';

/** Stationary brake-hold horizontal speed threshold (m/s) preventing creep on flat/banked ground. */
export const BRAKE_HOLD_SPEED_THRESHOLD_MPS = 0.18;

/** Exponential damping rate (1/s) applied when brakes are held stationary. */
export const BRAKE_HOLD_DAMPING_RATE = 25.0;

/** Minimum longitudinal contact-patch speed (m/s) above which ABS modulates footbrake pressure. */
const ABS_MIN_SPEED_MPS = 2.5;
/** Target straight-line braking slip ratio (`-slipRatio`) where per-wheel ABS begins releasing footbrake torque. */
const ABS_STRAIGHT_TARGET_SLIP_RATIO = 0.14;
/** Target front braking slip ratio under full steering so lateral cornering grip stays high during trail-braking. */
const ABS_CORNER_FRONT_TARGET_SLIP_RATIO = 0.065;
/** Excess braking slip band over which ABS linearly ramps torque down to `ABS_MIN_TORQUE_SCALE`. */
const ABS_RELEASE_BAND = 0.10;
/** Minimum footbrake torque fraction retained when ABS detects deep lockup. */
const ABS_MIN_TORQUE_SCALE = 0.04;
/** Peak grip torque cap multiplier preventing explicit Euler braking overshoot past Pacejka peak. */
const ABS_GRIP_TORQUE_CAP_MULTIPLIER = 1.08;
/** Minimum inner-to-outer normal-force ratio floor for Cornering Brake Control (CBC) over kerbs/unloading. */
const CBC_OUTER_FRONT_MIN_FLOOR_RATIO = 0.55;

/** Nominal chassis underbody/sill clearance above the tyre-bottom road plane at static ride height (m). */
export const CHASSIS_UNDERBODY_REST_CLEARANCE_METERS = 0.072;

/** Minimum clearance (m) enforced between chassis underbody sample points and road ground triangles. */
export const CHASSIS_UNDERBODY_MIN_CLEARANCE_METERS = 0.005;

/** Vertical void-fall threshold (m) before emergency on-track pose recovery triggers. */
export const VOID_FALL_RESET_DEPTH_METERS = 5.0;

/** Tilt angle (rad, ~26 deg) beyond which progressive anti-rollover stabilization begins. */
export const ANTI_ROLLOVER_START_TILT_RAD = 0.52;
/** Tilt angle (rad, ~40 deg) beyond which the smooth self-righting recovery rate takes over. */
export const SELF_RIGHT_START_TILT_RAD = 0.78;
/** Roll/pitch angular speed (rad/s) above which wall impacts are gently damped. */
export const WALL_TILT_DAMP_THRESHOLD_RAD_S = 2.8;
/** Exponential tilt-rate damping (1/s) applied above the wall threshold. */
export const WALL_TILT_DAMP_RATE = 8.0;

/**
 * Progressive anti-rollover stabilization and smooth self-righting (velocity-level).
 * Leaves normal suspension body roll (< ~26 deg) untouched, resists tilt growth between
 * ~26 and ~40 deg, and rotates the chassis back onto its wheels beyond ~40 deg.
 * Returns the corrected world angular velocity (yaw component is preserved).
 */
export function stabilizeChassisTilt(
  orientation: PhysicsQuat,
  angularVelocity: PhysicsVec3,
  groundedCount: number,
  dt: number,
): PhysicsVec3 {
  const up = quatRotateVec3(orientation, VEC3_UP);
  const tilt = Math.acos(clamp(up.y, -1, 1));
  if (tilt <= ANTI_ROLLOVER_START_TILT_RAD) {
    return angularVelocity;
  }
  // Axis that rotates the chassis up-vector toward world up (horizontal, |axis| = sin(tilt)).
  let axis = vec3Cross(up, VEC3_UP);
  if (vec3Length(axis) < 1e-4) {
    axis = quatRotateVec3(orientation, VEC3_FORWARD);
    axis = { x: axis.x, y: 0, z: axis.z };
  }
  axis = vec3Normalize(axis, VEC3_FORWARD);
  const wAxis = vec3Dot(angularVelocity, axis);

  const soft = clamp(
    (tilt - ANTI_ROLLOVER_START_TILT_RAD) / (SELF_RIGHT_START_TILT_RAD - ANTI_ROLLOVER_START_TILT_RAD),
    0,
    1,
  );
  let nextWAxis = wAxis;
  // Anti-rollover: damp spin that grows the tilt and add a restoring acceleration.
  if (wAxis < 0) {
    nextWAxis += -wAxis * (1 - Math.exp(-8 * soft * dt));
  }
  nextWAxis += 14 * soft * soft * dt;

  // Self-right: blend toward a righting rate (0.5-1.0 s from fully on its side).
  const righting = clamp((tilt - SELF_RIGHT_START_TILT_RAD) / 0.2, 0, 1);
  if (righting > 0) {
    const strength = groundedCount <= 1 ? 1 : 0.6;
    const target = Math.min(3.2, 1.2 + 2.0 * tilt);
    nextWAxis += (target - nextWAxis) * (1 - Math.exp(-9 * righting * strength * dt));
  }
  return vec3Add(angularVelocity, vec3Scale(axis, nextWAxis - wAxis));
}

export interface WheelSimulationSnapshot {
  readonly grounded: boolean;
  readonly compression: number;
  readonly suspensionDeltaMeters: number;
  readonly normalForce: number;
  readonly surfaceType: PhysicsSurfaceType;
  readonly angularSpeedRadS: number;
  readonly spinAngleRad: number;
  readonly slipRatio: number;
  readonly slipAngleRad: number;
  readonly longitudinalForceN: number;
  readonly lateralForceN: number;
  readonly steerAngleRad: number;
  readonly wheelCenterWorld: PhysicsVec3;
}

export interface VehicleSimulationSnapshot {
  readonly stepCount: number;
  readonly simTime: number;
  readonly pose: VehiclePose;
  readonly linearVelocity: PhysicsVec3;
  readonly angularVelocity: PhysicsVec3;
  readonly speedMps: number;
  readonly speedKph: number;
  readonly forwardSpeedMps: number;
  readonly gear: number;
  readonly engineRpm: number;
  readonly engineTorqueNm: number;
  readonly revLimiterActive: boolean;
  readonly absEnabled: boolean;
  readonly wallCollisionCount: number;
  readonly wheels: WheelSlotTuple<WheelSimulationSnapshot>;
}

export interface VehicleSimulationOptions {
  readonly initialPosition?: PhysicsVec3;
  readonly initialYawRad?: number;
  /** Optional initial roll (rad) about the chassis forward axis; used to test self-righting. */
  readonly initialRollRad?: number;
  readonly transmissionMode?: TransmissionMode;
  readonly absEnabled?: boolean;
  readonly fixedDt?: number;
  readonly maxFrameDt?: number;
}

/**
 * Complete deterministic 3D vehicle simulation uniting M9.1–M9.6:
 * fixed 120 Hz stepping, spatial collision queries, rigid-body dynamics,
 * 4-wheel suspension, drivetrain, and Pacejka tyre forces.
 */
export class VehicleSimulation {
  private readonly spec: CarPhysicsSpec;
  private readonly collisionIndex: CollisionIndex;
  private readonly rbParams: RigidBodyParams;
  private readonly loop: FixedTimestepLoop;

  private body: RigidBodyState;
  private prevPose: VehiclePose;
  private lastValidOnTrackPose: VehiclePose;
  private suspension: WheelSlotTuple<WheelSuspensionState>;
  private drivetrain: DrivetrainState;

  private wheelAngularSpeeds: [number, number, number, number] = [0, 0, 0, 0];
  private wheelSpinAngles: [number, number, number, number] = [0, 0, 0, 0];
  private wheelSlipRatios: [number, number, number, number] = [0, 0, 0, 0];
  private wheelSlipAngles: [number, number, number, number] = [0, 0, 0, 0];
  private wheelLongForces: [number, number, number, number] = [0, 0, 0, 0];
  private wheelLatForces: [number, number, number, number] = [0, 0, 0, 0];
  private currentSteerAngleRad = 0;
  private absEnabled: boolean;
  private wallCollisionCount = 0;

  constructor(
    spec: CarPhysicsSpec,
    collisionIndex: CollisionIndex,
    options: VehicleSimulationOptions = {},
  ) {
    this.spec = spec;
    this.collisionIndex = collisionIndex;
    this.rbParams = createRigidBodyParamsFromSpec(spec);
    this.loop = new FixedTimestepLoop({
      fixedDt: options.fixedDt ?? FIXED_DT,
      maxFrameDt: options.maxFrameDt ?? MAX_FRAME_DT,
    });

    const startPos = options.initialPosition ?? { x: 0, y: spec.comHeightMeters, z: 0 };
    const startQuat = quatMultiply(
      quatFromAxisAngle(VEC3_UP, options.initialYawRad ?? 0),
      quatFromAxisAngle(VEC3_FORWARD, options.initialRollRad ?? 0),
    );
    this.body = createRigidBodyState(startPos, startQuat);
    this.prevPose = {
      position: { ...this.body.position },
      orientation: { ...this.body.orientation },
    };
    this.lastValidOnTrackPose = {
      position: { ...this.body.position },
      orientation: { ...this.body.orientation },
    };
    this.suspension = createInitialSuspensionStates(spec);
    this.drivetrain = createDrivetrainState(spec, options.transmissionMode ?? 'auto');
    this.absEnabled = options.absEnabled ?? true;
  }

  getSpec(): CarPhysicsSpec {
    return this.spec;
  }

  getPose(): VehiclePose {
    return {
      position: { ...this.body.position },
      orientation: { ...this.body.orientation },
    };
  }

  getInterpolatedPose(alpha: number): VehiclePose {
    return interpolateVehiclePose(this.prevPose, this.getPose(), alpha);
  }

  setTransmissionMode(mode: TransmissionMode): void {
    this.drivetrain.transmissionMode = mode;
  }

  setAbsEnabled(enabled: boolean): void {
    this.absEnabled = enabled;
  }

  isAbsEnabled(): boolean {
    return this.absEnabled;
  }

  /**
   * Resets chassis pose, velocities, wheel spins, suspension history, and drivetrain state.
   */
  reset(position: PhysicsVec3, yawRad = 0): void {
    const orientation: PhysicsQuat = quatFromAxisAngle(VEC3_UP, yawRad);
    this.body = createRigidBodyState(position, orientation);
    this.prevPose = {
      position: { ...this.body.position },
      orientation: { ...this.body.orientation },
    };
    this.lastValidOnTrackPose = {
      position: { ...this.body.position },
      orientation: { ...this.body.orientation },
    };
    this.suspension = createInitialSuspensionStates(this.spec);
    this.drivetrain = createDrivetrainState(this.spec, this.drivetrain.transmissionMode);
    this.wheelAngularSpeeds = [0, 0, 0, 0];
    this.wheelSpinAngles = [0, 0, 0, 0];
    this.wheelSlipRatios = [0, 0, 0, 0];
    this.wheelSlipAngles = [0, 0, 0, 0];
    this.wheelLongForces = [0, 0, 0, 0];
    this.wheelLatForces = [0, 0, 0, 0];
    this.currentSteerAngleRad = 0;
    this.wallCollisionCount = 0;
    this.loop.reset();
  }

  /**
   * Advances simulation using the fixed-timestep accumulator (`120 Hz`) and returns
   * the latest render interpolation pose and step metadata.
   */
  update(frameDtSeconds: number, controls: VehicleControls): {
    readonly stepsExecuted: number;
    readonly alpha: number;
    readonly simTime: number;
    readonly interpolatedPose: VehiclePose;
  } {
    const stepResult = this.loop.advance(frameDtSeconds, (dt) => {
      this.stepFixed(controls, dt);
    });

    return {
      stepsExecuted: stepResult.stepsExecuted,
      alpha: stepResult.alpha,
      simTime: stepResult.simTime,
      interpolatedPose: this.getInterpolatedPose(stepResult.alpha),
    };
  }

  /**
   * Executes a single deterministic physics substep of duration `dt` seconds.
   */
  stepFixed(controls: VehicleControls, dt: number = this.loop.fixedDt): void {
    if (!Number.isFinite(dt) || dt <= 0) {
      return;
    }

    const safePoseBefore: VehiclePose = {
      position: { ...this.body.position },
      orientation: { ...this.body.orientation },
    };
    this.prevPose = safePoseBefore;

    const throttle = clamp(controls.throttle, 0, 1);
    const brake = clamp(controls.brake, 0, 1);
    const handbrake = clamp(controls.handbrake, 0, 1);
    const steer = clamp(controls.steer, -1, 1);

    // 1. Raycast & solve suspension
    const hits = castSuspensionRays(this.body, this.spec, this.collisionIndex);
    this.suspension = solveSuspension(this.body, this.spec, hits, this.suspension, dt);

    // 2. Compute chassis velocities & shape steering (slip-aware peak grip + GT Sport countersteer assist)
    const chassisForward = quatRotateVec3(this.body.orientation, VEC3_FORWARD);
    const chassisRight = quatRotateVec3(this.body.orientation, VEC3_RIGHT);
    const forwardSpeedMps = vec3Dot(this.body.linearVelocity, chassisForward);
    const rightSpeedMps = vec3Dot(this.body.linearVelocity, chassisRight);
    const preStepYawRate = this.body.angularVelocity.y;
    const frontAxleZ =
      ((this.spec.wheels[0]?.localPosition.z ?? -1.3) +
        (this.spec.wheels[1]?.localPosition.z ?? -1.3)) *
      0.5;
    const frontRightSpeedMps = rightSpeedMps + preStepYawRate * frontAxleZ;
    const refForwardMps = Math.max(4.0, Math.abs(forwardSpeedMps));
    const preStepBodySlipRad = Math.atan2(rightSpeedMps, refForwardMps);
    const betaFrontRad = Math.atan2(frontRightSpeedMps, refForwardMps);

    const rawSteerAngleRad = steer * this.spec.maxSteerAngleRad;
    let shapedSteerAngleRad = rawSteerAngleRad;

    if (forwardSpeedMps > 6.0 && handbrake < 0.1) {
      const steerMag = Math.abs(steer);
      const isCountersteeringIntoSlide =
        Math.abs(preStepBodySlipRad) > 0.10 && steer * preStepBodySlipRad < -0.02;

      if (steerMag > 0.05 && !isCountersteeringIntoSlide) {
        const peakFrontSlipRad = clamp(0.195 - (forwardSpeedMps - 14) * 0.0014, 0.145, 0.2);
        // Scale by 1.8 so speed-sensitive keyboard steering (0.32..1.0) still hits peak grip at full lock.
        const desiredSlipRad =
          Math.sign(steer) * peakFrontSlipRad * Math.min(1, steerMag * 1.8);
        let optimalSteerRad = desiredSlipRad - betaFrontRad;
        if (Math.abs(preStepBodySlipRad) <= 0.13) {
          optimalSteerRad =
            steer > 0 ? Math.max(0.02, optimalSteerRad) : Math.min(-0.02, optimalSteerRad);
        }
        const blend = clamp((forwardSpeedMps - 6.0) / 8.0, 0, 1);
        shapedSteerAngleRad = rawSteerAngleRad * (1 - blend) + optimalSteerRad * blend;
      }

      if (forwardSpeedMps > 8.0) {
        const isAssistingRecovery = steerMag <= 0.05 || steer * preStepBodySlipRad < -0.02;
        const csaThresholdRad = isAssistingRecovery ? 0.12 : 0.22;
        if (Math.abs(preStepBodySlipRad) > csaThresholdRad) {
          const csaFactor = clamp((Math.abs(preStepBodySlipRad) - csaThresholdRad) / 0.32, 0, 1);
          const alignSteer = -preStepBodySlipRad;
          const csaWeight = isAssistingRecovery ? 0.75 * csaFactor : 0.45 * csaFactor;
          shapedSteerAngleRad = shapedSteerAngleRad * (1 - csaWeight) + alignSteer * csaWeight;
        }
      }

      shapedSteerAngleRad = clamp(
        shapedSteerAngleRad,
        -this.spec.maxSteerAngleRad,
        this.spec.maxSteerAngleRad,
      );
    }

    const steerAngleRad = shapedSteerAngleRad;
    this.currentSteerAngleRad = steerAngleRad;

    const frontSplit = this.spec.drivetrain.frontTorqueSplit;
    const rearSplit = 1 - frontSplit;
    const frontSlipAvg = (this.wheelSlipRatios[0] + this.wheelSlipRatios[1]) * 0.5;
    const rearSlipAvg = (this.wheelSlipRatios[2] + this.wheelSlipRatios[3]) * 0.5;
    const drivenSlipRatio = frontSlipAvg * frontSplit + rearSlipAvg * rearSplit;

    stepDrivetrain(
      this.drivetrain,
      this.spec,
      {
        throttle,
        brake,
        handbrake,
        steer,
        ...(controls.shiftUp !== undefined ? { shiftUp: controls.shiftUp } : {}),
        ...(controls.shiftDown !== undefined ? { shiftDown: controls.shiftDown } : {}),
      },
      [
        this.wheelAngularSpeeds[0],
        this.wheelAngularSpeeds[1],
        this.wheelAngularSpeeds[2],
        this.wheelAngularSpeeds[3],
      ],
      forwardSpeedMps,
      dt,
      drivenSlipRatio,
    );

    const effectiveBrake = this.drivetrain.effectiveBrake;
    const effectiveThrottle =
      this.drivetrain.transmissionMode === 'auto' && this.drivetrain.gear === -1
        ? brake
        : throttle;

    const reflectedInertia = computeReflectedWheelInertiaKgM2(
      this.spec,
      this.drivetrain.gear,
      this.drivetrain.clutchEngagement,
    );

    // 3. Per-wheel tyre forces and spin integration
    const cosSteer = Math.cos(steerAngleRad);
    const sinSteer = Math.sin(steerAngleRad);
    // Positive steer (+Y CCW) turns local forward (0,0,-1) toward (-sin, 0, -cos)
    const steeredForwardLocal: PhysicsVec3 = { x: -sinSteer, y: 0, z: -cosSteer };
    const steeredRightLocal: PhysicsVec3 = { x: cosSteer, y: 0, z: -sinSteer };

    // Cornering Brake Control (CBC) & steering-aware ABS scalars (only active when absEnabled === true)
    const steerDemand = clamp((Math.abs(steer) - 0.05) / 0.55, 0, 1);
    const outerFrontIdx = steer > 0 ? 1 : 0;
    const innerFrontIdx = 1 - outerFrontIdx;
    const outerFrontFz = this.suspension[outerFrontIdx]?.normalForce ?? 0;
    const innerFrontFz = this.suspension[innerFrontIdx]?.normalForce ?? 0;
    const rawCbcRatio =
      outerFrontFz > 1
        ? clamp(innerFrontFz / outerFrontFz, CBC_OUTER_FRONT_MIN_FLOOR_RATIO, 1.0)
        : 1.0;
    const outerFrontCbcScale = 1 - steerDemand * 0.85 * (1 - rawCbcRatio);
    const frontCornerPressureScale = 1 - steerDemand * 0.28;

    let groundedCount = 0;
    for (let i = 0; i < 4; i += 1) {
      const wheelSpec = this.spec.wheels[i]!;
      const susp = this.suspension[i]!;
      const driveTorque = this.drivetrain.wheelDriveTorquesNm[i] ?? 0;

      const rawFootBrakeTorque =
        wheelSpec.axle === 'front'
          ? effectiveBrake * this.spec.brakes.maxFrontWheelTorqueNm
          : effectiveBrake * this.spec.brakes.maxRearWheelTorqueNm;
      const handbrakeTorque =
        wheelSpec.axle === 'rear' ? handbrake * this.spec.brakes.handbrakeRearWheelTorqueNm : 0;
      const isRearHandbrakeActive = wheelSpec.axle === 'rear' && handbrake >= 0.1;

      const localFwd = wheelSpec.steerable ? steeredForwardLocal : VEC3_FORWARD;
      const localRight = wheelSpec.steerable ? steeredRightLocal : VEC3_RIGHT;
      const worldWheelFwd = quatRotateVec3(this.body.orientation, localFwd);
      const worldWheelRight = quatRotateVec3(this.body.orientation, localRight);

      const isDrivenWheel = wheelSpec.axle === 'front' ? frontSplit > 0 : rearSplit > 0;
      const isWheelSpinning = Math.abs(this.wheelSlipRatios[i] ?? 0) > 0.55;
      const effectiveWheelInertia =
        wheelSpec.inertiaKgM2 + (isDrivenWheel && isWheelSpinning ? reflectedInertia : 0);

      if (!susp.grounded || susp.normalForce <= 0) {
        this.wheelSlipRatios[i] = 0;
        this.wheelSlipAngles[i] = 0;
        this.wheelLongForces[i] = 0;
        this.wheelLatForces[i] = 0;

        const nextOmega = stepWheelSpin(
          this.wheelAngularSpeeds[i] ?? 0,
          driveTorque,
          Math.max(rawFootBrakeTorque, handbrakeTorque),
          0,
          wheelSpec.radiusMeters,
          effectiveWheelInertia,
          0,
          dt,
        );
        this.wheelAngularSpeeds[i] = nextOmega;
        this.wheelSpinAngles[i] = ((this.wheelSpinAngles[i] ?? 0) + nextOmega * dt) % (Math.PI * 2);
        continue;
      }

      groundedCount += 1;

      const normal = susp.contactNormal;
      const contactForward = vec3Normalize(
        vec3Sub(worldWheelFwd, vec3Scale(normal, vec3Dot(worldWheelFwd, normal))),
        worldWheelFwd,
      );
      const contactRight = vec3Normalize(
        vec3Cross(contactForward, normal),
        worldWheelRight,
      );

      const patchVel = getWorldPointVelocity(this.body, susp.contactPoint);
      const patchForwardSpeed = vec3Dot(patchVel, contactForward);
      const patchRightSpeed = vec3Dot(patchVel, contactRight);

      // During cornering, keep unbraked non-driven free-rolling wheels synchronous with contact patch
      // speed to prevent high-load explicit Euler longitudinal slip chatter from starving lateral grip.
      const isFreeRollingCorner =
        !isDrivenWheel &&
        rawFootBrakeTorque === 0 &&
        handbrakeTorque === 0 &&
        wheelSpec.radiusMeters > 0.05 &&
        (Math.abs(steer) > 0.02 || Math.abs(patchRightSpeed) > 0.4);
      if (isFreeRollingCorner) {
        this.wheelAngularSpeeds[i] = patchForwardSpeed / wheelSpec.radiusMeters;
      }

      const compound = this.spec.tyres[wheelSpec.axle];
      const tyreOut = computeTyreForces({
        normalForceN: susp.normalForce,
        wheelAngularSpeedRadS: this.wheelAngularSpeeds[i] ?? 0,
        wheelRadiusMeters: wheelSpec.radiusMeters,
        patchForwardSpeedMps: patchForwardSpeed,
        patchRightSpeedMps: patchRightSpeed,
        compound,
        surfaceType: susp.surfaceType,
        axle: wheelSpec.axle,
        handbrakeActive: wheelSpec.axle === 'rear' && handbrake > 0.25,
      });

      this.wheelSlipRatios[i] = tyreOut.slipRatio;
      this.wheelSlipAngles[i] = tyreOut.slipAngleRad;
      this.wheelLongForces[i] = tyreOut.longitudinalForceN;
      this.wheelLatForces[i] = tyreOut.lateralForceN;

      const worldTyreForce = vec3Add(
        vec3Scale(contactForward, tyreOut.longitudinalForceN),
        vec3Scale(contactRight, tyreOut.lateralForceN),
      );
      applyWorldForceAtPoint(this.body, worldTyreForce, susp.contactPoint);

      // When ABS is On, modulate per-wheel footbrake torque with steering-aware slip targets and floored CBC;
      // when ABS is Off, apply raw unmodulated footbrake torque. Rear handbrake stays strictly unmodulated.
      let effectiveFootBrakeTorque = rawFootBrakeTorque;
      if (
        this.absEnabled &&
        rawFootBrakeTorque > 0 &&
        !isRearHandbrakeActive &&
        Math.abs(patchForwardSpeed) > ABS_MIN_SPEED_MPS
      ) {
        const isFront = wheelSpec.axle === 'front';
        const isOuterFront = isFront && steerDemand > 0 && i === outerFrontIdx;
        const targetSlip = isFront
          ? ABS_STRAIGHT_TARGET_SLIP_RATIO +
            (ABS_CORNER_FRONT_TARGET_SLIP_RATIO - ABS_STRAIGHT_TARGET_SLIP_RATIO) * steerDemand
          : ABS_STRAIGHT_TARGET_SLIP_RATIO;

        if (isFront && steerDemand > 0) {
          effectiveFootBrakeTorque *= frontCornerPressureScale * (isOuterFront ? outerFrontCbcScale : 1);
        }

        const brakingSlip = Math.max(0, -tyreOut.slipRatio * Math.sign(patchForwardSpeed));
        if (brakingSlip > targetSlip) {
          const absScale = clamp(
            1 - (brakingSlip - targetSlip) / ABS_RELEASE_BAND,
            ABS_MIN_TORQUE_SCALE,
            1,
          );
          effectiveFootBrakeTorque *= absScale;
        }

        const capMult = isFront
          ? ABS_GRIP_TORQUE_CAP_MULTIPLIER *
            frontCornerPressureScale *
            (isOuterFront ? outerFrontCbcScale : 1)
          : ABS_GRIP_TORQUE_CAP_MULTIPLIER;
        const gripTorqueCap = susp.normalForce * tyreOut.effectiveMu * wheelSpec.radiusMeters * capMult;
        effectiveFootBrakeTorque = Math.min(effectiveFootBrakeTorque, gripTorqueCap);
      }
      const appliedBrakeTorque = Math.max(effectiveFootBrakeTorque, handbrakeTorque);

      const nextOmega = isFreeRollingCorner
        ? patchForwardSpeed / wheelSpec.radiusMeters
        : stepWheelSpin(
            this.wheelAngularSpeeds[i] ?? 0,
            driveTorque,
            appliedBrakeTorque,
            tyreOut.longitudinalForceN,
            wheelSpec.radiusMeters,
            effectiveWheelInertia,
            patchForwardSpeed,
            dt,
          );
      this.wheelAngularSpeeds[i] = nextOmega;
      this.wheelSpinAngles[i] = ((this.wheelSpinAngles[i] ?? 0) + nextOmega * dt) % (Math.PI * 2);
    }

    // 4. Gravity, aerodynamics, oversteer/zero-steer yaw stability damping, and rigid-body integration
    applyGravityForce(this.body, this.rbParams);
    applyAerodynamicForces(this.body, this.rbParams);
    if (groundedCount >= 2 && handbrake < 0.1 && forwardSpeedMps > 3.0) {
      const yawRate = this.body.angularVelocity.y;
      if (Math.abs(yawRate) > 1e-4) {
        const frontSlipAbs =
          (Math.abs(this.wheelSlipAngles[0]) + Math.abs(this.wheelSlipAngles[1])) * 0.5;
        const rearSlipAbs =
          (Math.abs(this.wheelSlipAngles[2]) + Math.abs(this.wheelSlipAngles[3])) * 0.5;
        const absBodySlip = Math.abs(preStepBodySlipRad);

        const zeroSteer = Math.abs(steer) <= 0.05;
        const counterSteer =
          (steer > 0.05 && yawRate < -0.05) || (steer < -0.05 && yawRate > 0.05);
        const oversteerExcess = Math.max(0, rearSlipAbs - frontSlipAbs - 0.06);

        let gain = 0;
        if (zeroSteer) {
          gain = 3.4;
        } else if (counterSteer) {
          gain = 3.0;
        } else if (absBodySlip > 0.28 || (oversteerExcess > 0 && absBodySlip > 0.22)) {
          const slipOver = Math.max(0, absBodySlip - 0.28) * 5.0;
          gain = clamp(oversteerExcess * 8.0 + slipOver, 0, 2.4);
        }

        if (gain > 0) {
          const speedFactor = clamp(forwardSpeedMps / 25, 0.35, 1.4);
          const maxAccel = 6.0 * this.spec.inertiaLocal.y;
          const yawStabilityTorque = clamp(
            -yawRate * gain * speedFactor * this.spec.inertiaLocal.y,
            -maxAccel,
            maxAccel,
          );
          applyWorldTorque(this.body, { x: 0, y: yawStabilityTorque, z: 0 });
        }
      }
    }
    integrateRigidBody(this.body, this.rbParams, dt);

    // 5. Stationary brake-hold damping to eliminate low-speed numerical creep
    if (
      groundedCount >= 2 &&
      effectiveThrottle < 0.05 &&
      (effectiveBrake > 0.1 || handbrake > 0.1) &&
      Math.hypot(this.body.linearVelocity.x, this.body.linearVelocity.z) <
        BRAKE_HOLD_SPEED_THRESHOLD_MPS
    ) {
      const holdDamp = Math.exp(-BRAKE_HOLD_DAMPING_RATE * dt);
      this.body.linearVelocity = {
        x: this.body.linearVelocity.x * holdDamp,
        y: this.body.linearVelocity.y,
        z: this.body.linearVelocity.z * holdDamp,
      };
      this.body.angularVelocity = {
        x: this.body.angularVelocity.x * holdDamp,
        y: this.body.angularVelocity.y * holdDamp,
        z: this.body.angularVelocity.z * holdDamp,
      };
    }

    // 6. Horizontal chassis wall barrier collision resolution (with swept prevPosition CCD)
    const wallRes = this.collisionIndex.resolveChassisWallCollisions({
      position: this.body.position,
      prevPosition: safePoseBefore.position,
      orientation: this.body.orientation,
      linearVelocity: this.body.linearVelocity,
      angularVelocity: this.body.angularVelocity,
      halfExtents: this.spec.halfExtents,
      massKg: this.rbParams.massKg,
      inertiaY: this.spec.inertiaLocal.y,
    });

    if (wallRes.collided) {
      this.wallCollisionCount += 1;
      this.body.position = vec3Add(this.body.position, wallRes.positionCorrection);
      this.body.linearVelocity = vec3Add(
        this.body.linearVelocity,
        wallRes.linearVelocityDelta,
      );
      this.body.angularVelocity = vec3Add(
        this.body.angularVelocity,
        wallRes.angularVelocityDelta,
      );
      // Wall impacts keep natural suspension recoil; only extreme roll/pitch spin is gently damped.
      const w = this.body.angularVelocity;
      const tiltRate = Math.hypot(w.x, w.z);
      if (tiltRate > WALL_TILT_DAMP_THRESHOLD_RAD_S) {
        const damp = Math.exp(-WALL_TILT_DAMP_RATE * dt);
        const target = WALL_TILT_DAMP_THRESHOLD_RAD_S / tiltRate;
        const k = Math.max(target, damp);
        this.body.angularVelocity = { x: w.x * k, y: w.y, z: w.z * k };
      }
    }

    // 6a. Anti-rollover stabilization and smooth self-righting
    this.body.angularVelocity = stabilizeChassisTilt(
      this.body.orientation,
      this.body.angularVelocity,
      groundedCount,
      dt,
    );

    // 6b. Solid chassis underbody & sill ground clearance against actual 3D ground triangles
    const underbodyRight = quatRotateVec3(this.body.orientation, VEC3_RIGHT);
    const underbodyFwd = quatRotateVec3(this.body.orientation, VEC3_FORWARD);
    const underbodyUp = quatRotateVec3(this.body.orientation, VEC3_UP);
    const sampleHalfW = this.spec.halfExtents.x * 0.82;
    const sampleHalfL = this.spec.halfExtents.z * 0.78;
    const sampleLocalY =
      -this.spec.comHeightMeters + CHASSIS_UNDERBODY_REST_CLEARANCE_METERS;
    const underbodyPoints: readonly PhysicsVec3[] = [
      vec3Add(this.body.position, vec3Scale(underbodyUp, sampleLocalY)),
      vec3Add(
        this.body.position,
        vec3Add(
          vec3Scale(underbodyUp, sampleLocalY),
          vec3Add(vec3Scale(underbodyRight, -sampleHalfW), vec3Scale(underbodyFwd, sampleHalfL)),
        ),
      ),
      vec3Add(
        this.body.position,
        vec3Add(
          vec3Scale(underbodyUp, sampleLocalY),
          vec3Add(vec3Scale(underbodyRight, sampleHalfW), vec3Scale(underbodyFwd, sampleHalfL)),
        ),
      ),
      vec3Add(
        this.body.position,
        vec3Add(
          vec3Scale(underbodyUp, sampleLocalY),
          vec3Add(vec3Scale(underbodyRight, -sampleHalfW), vec3Scale(underbodyFwd, -sampleHalfL)),
        ),
      ),
      vec3Add(
        this.body.position,
        vec3Add(
          vec3Scale(underbodyUp, sampleLocalY),
          vec3Add(vec3Scale(underbodyRight, sampleHalfW), vec3Scale(underbodyFwd, -sampleHalfL)),
        ),
      ),
    ];

    let maxUnderbodyPen = 0;
    let deepestUnderbodyNormal: PhysicsVec3 = VEC3_UP;
    for (const pt of underbodyPoints) {
      const gHit = this.collisionIndex.raycastWheelDown(
        { x: pt.x, y: pt.y + 0.85, z: pt.z },
        { x: 0, y: -1, z: 0 },
        1.6,
      );
      if (gHit === null || gHit.normal.y < 0.5) {
        continue;
      }
      const pen = gHit.point.y + CHASSIS_UNDERBODY_MIN_CLEARANCE_METERS - pt.y;
      if (pen > maxUnderbodyPen) {
        maxUnderbodyPen = pen;
        deepestUnderbodyNormal = gHit.normal;
      }
    }

    if (maxUnderbodyPen > 0) {
      this.body.position = {
        ...this.body.position,
        y: this.body.position.y + Math.min(maxUnderbodyPen, 0.35),
      };
      // Project out only velocity directed INTO the sloped road normal so downhill driving is never launched upward.
      const vIntoGround = vec3Dot(this.body.linearVelocity, deepestUnderbodyNormal);
      if (vIntoGround < 0) {
        this.body.linearVelocity = vec3Add(
          this.body.linearVelocity,
          vec3Scale(deepestUnderbodyNormal, -vIntoGround),
        );
      }
      this.body.angularVelocity = {
        x: this.body.angularVelocity.x * 0.9,
        y: this.body.angularVelocity.y,
        z: this.body.angularVelocity.z * 0.9,
      };
    }

    // Hard void-fall safety reset: only triggers on genuine fall-through (> 5 m below track), never on normal impacts.
    if (groundedCount === 0) {
      const deepBelowLastValid =
        this.body.position.y < this.lastValidOnTrackPose.position.y - VOID_FALL_RESET_DEPTH_METERS;
      const deepBelowMesh =
        this.body.position.y < this.collisionIndex.mesh.bounds.min.y - VOID_FALL_RESET_DEPTH_METERS;
      if (deepBelowLastValid || deepBelowMesh) {
        const safetyHit = this.collisionIndex.raycastWheelDown(
          { x: this.body.position.x, y: this.body.position.y + 4, z: this.body.position.z },
          { x: 0, y: -1, z: 0 },
          20,
        );
        if (safetyHit === null) {
          const escDx = this.body.position.x - this.lastValidOnTrackPose.position.x;
          const escDz = this.body.position.z - this.lastValidOnTrackPose.position.z;
          const escLen = Math.hypot(escDx, escDz);
          this.body.position = { ...this.lastValidOnTrackPose.position };
          if (escLen > 1e-4) {
            const ux = escDx / escLen;
            const uz = escDz / escLen;
            const vOut = this.body.linearVelocity.x * ux + this.body.linearVelocity.z * uz;
            if (vOut > 0) {
              this.body.linearVelocity = {
                x: (this.body.linearVelocity.x - ux * vOut) * 0.5,
                y: this.body.linearVelocity.y * 0.5,
                z: (this.body.linearVelocity.z - uz * vOut) * 0.5,
              };
            } else {
              this.body.linearVelocity = vec3Scale(this.body.linearVelocity, 0.5);
            }
          } else {
            this.body.linearVelocity = vec3Scale(this.body.linearVelocity, 0.5);
          }
          this.body.angularVelocity = vec3Scale(this.body.angularVelocity, 0.5);
          this.wallCollisionCount += 1;
        }
      }
    } else if (groundedCount >= 3 && !wallRes.collided && maxUnderbodyPen <= 0) {
      this.lastValidOnTrackPose = {
        position: { ...this.body.position },
        orientation: { ...this.body.orientation },
      };
    }

    // 7. Finite-state safety guard
    if (
      !isFiniteVec3(this.body.position) ||
      !isFiniteQuat(this.body.orientation) ||
      !isFiniteVec3(this.body.linearVelocity) ||
      !isFiniteVec3(this.body.angularVelocity)
    ) {
      this.body = createRigidBodyState(safePoseBefore.position, safePoseBefore.orientation);
    }
  }

  getSnapshot(): VehicleSimulationSnapshot {
    const chassisForward = quatRotateVec3(this.body.orientation, VEC3_FORWARD);
    const speedMps = vec3Length(this.body.linearVelocity);
    const forwardSpeedMps = vec3Dot(this.body.linearVelocity, chassisForward);

    const makeWheelSnap = (idx: 0 | 1 | 2 | 3): WheelSimulationSnapshot => {
      const susp = this.suspension[idx];
      const wheelSpec = this.spec.wheels[idx];
      const staticComp = this.spec.suspension[wheelSpec.axle].staticCompressionMeters;
      return {
        grounded: susp.grounded,
        compression: susp.compression,
        suspensionDeltaMeters: susp.grounded
          ? susp.compression - staticComp
          : -(this.spec.suspension[wheelSpec.axle].maxTravelMeters - staticComp),
        normalForce: susp.normalForce,
        surfaceType: susp.surfaceType,
        angularSpeedRadS: this.wheelAngularSpeeds[idx],
        spinAngleRad: this.wheelSpinAngles[idx],
        slipRatio: this.wheelSlipRatios[idx],
        slipAngleRad: this.wheelSlipAngles[idx],
        longitudinalForceN: this.wheelLongForces[idx],
        lateralForceN: this.wheelLatForces[idx],
        steerAngleRad: wheelSpec.steerable ? this.currentSteerAngleRad : 0,
        wheelCenterWorld: susp.wheelCenterWorld,
      };
    };

    return {
      stepCount: this.loop.currentStepCount,
      simTime: this.loop.simTime,
      pose: this.getPose(),
      linearVelocity: { ...this.body.linearVelocity },
      angularVelocity: { ...this.body.angularVelocity },
      speedMps,
      speedKph: speedMps * 3.6,
      forwardSpeedMps,
      gear: this.drivetrain.gear,
      engineRpm: this.drivetrain.engineRpm,
      engineTorqueNm: this.drivetrain.engineTorqueNm,
      revLimiterActive: this.drivetrain.revLimiterActive,
      absEnabled: this.absEnabled,
      wallCollisionCount: this.wallCollisionCount,
      wheels: [
        makeWheelSnap(0),
        makeWheelSnap(1),
        makeWheelSnap(2),
        makeWheelSnap(3),
      ],
    };
  }
}
