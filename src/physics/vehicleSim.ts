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

/** Nominal chassis underbody/sill clearance above the tyre-bottom road plane at static ride height (m). */
export const CHASSIS_UNDERBODY_REST_CLEARANCE_METERS = 0.075;

/** Minimum clearance (m) enforced between chassis underbody sample points and road ground triangles. */
export const CHASSIS_UNDERBODY_MIN_CLEARANCE_METERS = 0.005;

/** Vertical void-fall threshold (m) before emergency on-track pose recovery triggers. */
export const VOID_FALL_RESET_DEPTH_METERS = 5.0;

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
  readonly wallCollisionCount: number;
  readonly wheels: WheelSlotTuple<WheelSimulationSnapshot>;
}

export interface VehicleSimulationOptions {
  readonly initialPosition?: PhysicsVec3;
  readonly initialYawRad?: number;
  readonly transmissionMode?: TransmissionMode;
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
    const startQuat = quatFromAxisAngle(VEC3_UP, options.initialYawRad ?? 0);
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
    const steerAngleRad = steer * this.spec.maxSteerAngleRad;
    this.currentSteerAngleRad = steerAngleRad;

    // 1. Raycast & solve suspension
    const hits = castSuspensionRays(this.body, this.spec, this.collisionIndex);
    this.suspension = solveSuspension(this.body, this.spec, hits, this.suspension, dt);

    // 2. Compute forward speed along chassis -Z and advance drivetrain
    const chassisForward = quatRotateVec3(this.body.orientation, VEC3_FORWARD);
    const forwardSpeedMps = vec3Dot(this.body.linearVelocity, chassisForward);
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

    let groundedCount = 0;
    for (let i = 0; i < 4; i += 1) {
      const wheelSpec = this.spec.wheels[i]!;
      const susp = this.suspension[i]!;
      const driveTorque = this.drivetrain.wheelDriveTorquesNm[i] ?? 0;

      const brakeTorque =
        wheelSpec.axle === 'front'
          ? brake * this.spec.brakes.maxFrontWheelTorqueNm
          : Math.max(
              brake * this.spec.brakes.maxRearWheelTorqueNm,
              handbrake * this.spec.brakes.handbrakeRearWheelTorqueNm,
            );

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
          brakeTorque,
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

      const compound = this.spec.tyres[wheelSpec.axle];
      const tyreOut = computeTyreForces({
        normalForceN: susp.normalForce,
        wheelAngularSpeedRadS: this.wheelAngularSpeeds[i] ?? 0,
        wheelRadiusMeters: wheelSpec.radiusMeters,
        patchForwardSpeedMps: patchForwardSpeed,
        patchRightSpeedMps: patchRightSpeed,
        compound,
        surfaceType: susp.surfaceType,
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

      const nextOmega = stepWheelSpin(
        this.wheelAngularSpeeds[i] ?? 0,
        driveTorque,
        brakeTorque,
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
        const chassisRight = quatRotateVec3(this.body.orientation, VEC3_RIGHT);
        const latSpeed = vec3Dot(this.body.linearVelocity, chassisRight);
        const bodySlipRad = Math.atan2(latSpeed, Math.max(Math.abs(forwardSpeedMps), 1.0));

        const zeroSteer = Math.abs(steer) <= 0.05;
        const counterSteer =
          (steer > 0.05 && yawRate < -0.05) || (steer < -0.05 && yawRate > 0.05);
        const oversteerExcess = Math.max(0, rearSlipAbs - frontSlipAbs - 0.06);

        let gain = 0;
        if (zeroSteer) {
          gain = 1.8;
        } else if (counterSteer) {
          gain = 2.4;
        } else if (oversteerExcess > 0 && Math.abs(bodySlipRad) > 0.12) {
          gain = clamp(oversteerExcess * 8.0, 0, 1.8);
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
      throttle < 0.05 &&
      (brake > 0.1 || handbrake > 0.1) &&
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
    }

    // 6b. Solid chassis underbody & corner ground clearance against actual 3D ground triangles
    const underbodyRight = quatRotateVec3(this.body.orientation, VEC3_RIGHT);
    const underbodyFwd = quatRotateVec3(this.body.orientation, VEC3_FORWARD);
    const underbodyUp = quatRotateVec3(this.body.orientation, VEC3_UP);
    const sampleHalfW = this.spec.halfExtents.x * 0.98;
    const sampleHalfL = this.spec.halfExtents.z * 0.98;
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
      }
    }

    if (maxUnderbodyPen > 0) {
      this.body.position = {
        ...this.body.position,
        y: this.body.position.y + Math.min(maxUnderbodyPen, 0.55),
      };
      if (this.body.linearVelocity.y < 0) {
        this.body.linearVelocity = {
          ...this.body.linearVelocity,
          y: 0,
        };
      }
      this.body.angularVelocity = {
        x: this.body.angularVelocity.x * 0.85,
        y: this.body.angularVelocity.y,
        z: this.body.angularVelocity.z * 0.85,
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
