import { type AxleSuspensionSpec, type CarPhysicsSpec, GRAVITY_MPS2, type WheelPhysicsSpec } from './carSpec';
import type { CollisionIndex, WheelRaycastHit } from './collisionIndex';
import {
  VEC3_UP,
  VEC3_ZERO,
  clamp,
  quatRotateVec3,
  vec3Add,
  vec3Dot,
  vec3Scale,
} from './math';
import { type RigidBodyState, applyWorldForceAtPoint, getWorldPointVelocity } from './rigidBody';
import type { PhysicsSurfaceType, PhysicsVec3, WheelSlotTuple } from './types';

/** Progressive bump-stop stiffness multiplier applied as suspension nears `maxTravelMeters`. */
export const BUMP_STOP_STIFFNESS_MULTIPLIER = 4.0;

/** Final fraction of suspension travel where progressive quadratic bump stops engage. */
export const BUMP_STOP_ENGAGE_FRACTION = 0.15;

/** Upper clamp on per-wheel suspension normal force as a multiple of static corner weight. */
export const MAX_SUSPENSION_FORCE_WEIGHT_MULTIPLIER = 4.0;

/** Clamp on suspension compression/rebound velocity (m/s) to prevent numerical impulse spikes. */
export const MAX_SUSPENSION_VELOCITY_MPS = 8.0;

/** Upward offset (m) lifting wheel raycast origins inside the upper chassis so deep compression never misses ground. */
export const WHEEL_RAYCAST_ORIGIN_LIFT_METERS = 0.55;

export interface WheelSuspensionState {
  readonly grounded: boolean;
  readonly compression: number;
  readonly compressionVelocity: number;
  readonly normalForce: number;
  readonly springForce: number;
  readonly damperForce: number;
  readonly antiRollForce: number;
  readonly contactPoint: PhysicsVec3;
  readonly contactNormal: PhysicsVec3;
  readonly surfaceType: PhysicsSurfaceType;
  readonly rayDistance: number;
  readonly wheelCenterWorld: PhysicsVec3;
  readonly mountWorld: PhysicsVec3;
}

export function createInitialSuspensionStates(
  spec: CarPhysicsSpec,
): WheelSlotTuple<WheelSuspensionState> {
  const makeState = (wheel: WheelPhysicsSpec): WheelSuspensionState => ({
    grounded: false,
    compression: 0,
    compressionVelocity: 0,
    normalForce: 0,
    springForce: 0,
    damperForce: 0,
    antiRollForce: 0,
    contactPoint: VEC3_ZERO,
    contactNormal: VEC3_UP,
    surfaceType: 'asphalt',
    rayDistance: spec.suspension[wheel.axle].maxTravelMeters + wheel.radiusMeters,
    wheelCenterWorld: VEC3_ZERO,
    mountWorld: VEC3_ZERO,
  });

  return [
    makeState(spec.wheels[0]),
    makeState(spec.wheels[1]),
    makeState(spec.wheels[2]),
    makeState(spec.wheels[3]),
  ];
}

export function getWheelMountLocal(spec: CarPhysicsSpec, wheel: WheelPhysicsSpec): PhysicsVec3 {
  const axleSpec = spec.suspension[wheel.axle];
  return {
    x: wheel.localPosition.x,
    y:
      wheel.localPosition.y -
      spec.comHeightMeters +
      (axleSpec.maxTravelMeters - axleSpec.staticCompressionMeters),
    z: wheel.localPosition.z,
  };
}

/**
 * Casts 4 downward suspension rays from chassis wheel mounts along `-chassisUp` against `CollisionIndex`.
 */
export function castSuspensionRays(
  body: RigidBodyState,
  spec: CarPhysicsSpec,
  collisionIndex: CollisionIndex,
): WheelSlotTuple<WheelRaycastHit | null> {
  const chassisUp = quatRotateVec3(body.orientation, VEC3_UP);
  const downDir = vec3Scale(chassisUp, -1);

  const castOne = (wheel: WheelPhysicsSpec): WheelRaycastHit | null => {
    const axleSpec = spec.suspension[wheel.axle];
    const mountLocal = getWheelMountLocal(spec, wheel);
    const mountWorld = vec3Add(body.position, quatRotateVec3(body.orientation, mountLocal));
    const rayOrigin = vec3Add(mountWorld, vec3Scale(chassisUp, WHEEL_RAYCAST_ORIGIN_LIFT_METERS));
    const maxDistance =
      WHEEL_RAYCAST_ORIGIN_LIFT_METERS + axleSpec.maxTravelMeters + wheel.radiusMeters;
    const hit = collisionIndex.raycastWheelDown(rayOrigin, downDir, maxDistance);
    if (hit === null || hit.normal.y < 0.5) {
      return null;
    }
    return {
      ...hit,
      distance: hit.distance - WHEEL_RAYCAST_ORIGIN_LIFT_METERS,
    };
  };

  return [
    castOne(spec.wheels[0]),
    castOne(spec.wheels[1]),
    castOne(spec.wheels[2]),
    castOne(spec.wheels[3]),
  ];
}

interface RawWheelSuspensionEval {
  readonly grounded: boolean;
  readonly compression: number;
  readonly compressionVelocity: number;
  readonly springForce: number;
  readonly damperForce: number;
  readonly bumpStopForce: number;
  readonly contactPoint: PhysicsVec3;
  readonly contactNormal: PhysicsVec3;
  readonly surfaceType: PhysicsSurfaceType;
  readonly rayDistance: number;
  readonly wheelCenterWorld: PhysicsVec3;
  readonly mountWorld: PhysicsVec3;
}

function evaluateWheelSuspension(
  body: RigidBodyState,
  spec: CarPhysicsSpec,
  wheel: WheelPhysicsSpec,
  axleSpec: AxleSuspensionSpec,
  hit: WheelRaycastHit | null,
  prev: WheelSuspensionState,
  chassisUp: PhysicsVec3,
  downDir: PhysicsVec3,
  dt: number,
): RawWheelSuspensionEval {
  const mountLocal = getWheelMountLocal(spec, wheel);
  const mountWorld = vec3Add(body.position, quatRotateVec3(body.orientation, mountLocal));
  const maxRayDist = axleSpec.maxTravelMeters + wheel.radiusMeters;

  if (hit === null || hit.distance > maxRayDist) {
    const fullExtCenter = vec3Add(mountWorld, vec3Scale(downDir, axleSpec.maxTravelMeters));
    return {
      grounded: false,
      compression: 0,
      compressionVelocity: 0,
      springForce: 0,
      damperForce: 0,
      bumpStopForce: 0,
      contactPoint: vec3Add(fullExtCenter, vec3Scale(downDir, wheel.radiusMeters)),
      contactNormal: chassisUp,
      surfaceType: 'asphalt',
      rayDistance: maxRayDist,
      wheelCenterWorld: fullExtCenter,
      mountWorld,
    };
  }

  const rawCompression = maxRayDist - hit.distance;
  const compression = clamp(rawCompression, 0, axleSpec.maxTravelMeters);

  // Compute chassis contact velocity along hit normal so discrete .tro seam steps cannot inject spikes.
  const mountVel = getWorldPointVelocity(body, hit.point);
  const mountCompVel = -vec3Dot(mountVel, hit.normal);

  let compressionVelocity: number;
  if (prev.grounded && dt > 0) {
    const rawDeriv = (compression - prev.compression) / dt;
    const clampedDeriv = clamp(rawDeriv, mountCompVel - 2.0, mountCompVel + 2.0);
    compressionVelocity = 0.55 * mountCompVel + 0.45 * clampedDeriv;
  } else {
    // Smooth touchdown velocity from world contact velocity along hit normal
    compressionVelocity = Math.max(0, mountCompVel);
  }
  compressionVelocity = clamp(
    compressionVelocity,
    -MAX_SUSPENSION_VELOCITY_MPS,
    MAX_SUSPENSION_VELOCITY_MPS,
  );

  const springForce = axleSpec.stiffnessNPerM * compression;
  const damperCoeff =
    compressionVelocity >= 0 ? axleSpec.bumpDampingNPerMps : axleSpec.reboundDampingNPerMps;
  const damperForce = damperCoeff * compressionVelocity;

  const bumpZone = Math.max(0.01, axleSpec.maxTravelMeters * BUMP_STOP_ENGAGE_FRACTION);
  const progressiveExcess = Math.max(0, rawCompression - (axleSpec.maxTravelMeters - bumpZone));
  const normalizedExcess = progressiveExcess / bumpZone;
  const bumpStopSpring =
    progressiveExcess *
    normalizedExcess *
    axleSpec.stiffnessNPerM *
    BUMP_STOP_STIFFNESS_MULTIPLIER *
    0.65;
  const bumpStopDamp =
    compressionVelocity > 0 && progressiveExcess > 0
      ? axleSpec.bumpDampingNPerMps *
        0.75 *
        clamp(normalizedExcess, 0, 1.5) *
        compressionVelocity
      : 0;
  const bumpStopForce = bumpStopSpring + bumpStopDamp;

  const extensionDist = axleSpec.maxTravelMeters - compression;
  const wheelCenterWorld = vec3Add(mountWorld, vec3Scale(downDir, extensionDist));

  return {
    grounded: true,
    compression,
    compressionVelocity,
    springForce,
    damperForce,
    bumpStopForce,
    contactPoint: hit.point,
    contactNormal: hit.normal,
    surfaceType: hit.surfaceType,
    rayDistance: hit.distance,
    wheelCenterWorld,
    mountWorld,
  };
}

/**
 * Computes per-wheel spring-damper forces, progressive bump stops, and axle anti-roll bar load
 * transfer (`Fz >= 0`, zero pulling force when airborne), and applies resulting forces to `body`.
 */
export function solveSuspension(
  body: RigidBodyState,
  spec: CarPhysicsSpec,
  hits: WheelSlotTuple<WheelRaycastHit | null>,
  prevStates: WheelSlotTuple<WheelSuspensionState>,
  dt: number,
): WheelSlotTuple<WheelSuspensionState> {
  const chassisUp = quatRotateVec3(body.orientation, VEC3_UP);
  const downDir = vec3Scale(chassisUp, -1);

  const rawEvals: [
    RawWheelSuspensionEval,
    RawWheelSuspensionEval,
    RawWheelSuspensionEval,
    RawWheelSuspensionEval,
  ] = [
    evaluateWheelSuspension(
      body,
      spec,
      spec.wheels[0],
      spec.suspension.front,
      hits[0],
      prevStates[0],
      chassisUp,
      downDir,
      dt,
    ),
    evaluateWheelSuspension(
      body,
      spec,
      spec.wheels[1],
      spec.suspension.front,
      hits[1],
      prevStates[1],
      chassisUp,
      downDir,
      dt,
    ),
    evaluateWheelSuspension(
      body,
      spec,
      spec.wheels[2],
      spec.suspension.rear,
      hits[2],
      prevStates[2],
      chassisUp,
      downDir,
      dt,
    ),
    evaluateWheelSuspension(
      body,
      spec,
      spec.wheels[3],
      spec.suspension.rear,
      hits[3],
      prevStates[3],
      chassisUp,
      downDir,
      dt,
    ),
  ];

  // Axle anti-roll bar transfer only when both wheels on the axle are grounded
  const frontArb =
    rawEvals[0].grounded && rawEvals[1].grounded
      ? (rawEvals[0].compression - rawEvals[1].compression) *
        spec.suspension.front.antiRollStiffnessNPerM
      : 0;
  const rearArb =
    rawEvals[2].grounded && rawEvals[3].grounded
      ? (rawEvals[2].compression - rawEvals[3].compression) *
        spec.suspension.rear.antiRollStiffnessNPerM
      : 0;

  const arbForces: readonly [number, number, number, number] = [
    frontArb,
    -frontArb,
    rearArb,
    -rearArb,
  ];

  const maxWheelForce =
    (spec.massKg * GRAVITY_MPS2 * 0.25) * MAX_SUSPENSION_FORCE_WEIGHT_MULTIPLIER;

  const finalizeWheel = (idx: 0 | 1 | 2 | 3): WheelSuspensionState => {
    const raw = rawEvals[idx];
    const arb = arbForces[idx];
    if (!raw.grounded) {
      return {
        grounded: false,
        compression: 0,
        compressionVelocity: 0,
        normalForce: 0,
        springForce: 0,
        damperForce: 0,
        antiRollForce: 0,
        contactPoint: raw.contactPoint,
        contactNormal: raw.contactNormal,
        surfaceType: raw.surfaceType,
        rayDistance: raw.rayDistance,
        wheelCenterWorld: raw.wheelCenterWorld,
        mountWorld: raw.mountWorld,
      };
    }

    const totalForce = raw.springForce + raw.damperForce + raw.bumpStopForce + arb;
    const normalForce = clamp(totalForce, 0, maxWheelForce);

    if (normalForce > 0) {
      applyWorldForceAtPoint(
        body,
        vec3Scale(raw.contactNormal, normalForce),
        raw.contactPoint,
      );
    }

    return {
      grounded: true,
      compression: raw.compression,
      compressionVelocity: raw.compressionVelocity,
      normalForce,
      springForce: raw.springForce,
      damperForce: raw.damperForce,
      antiRollForce: arb,
      contactPoint: raw.contactPoint,
      contactNormal: raw.contactNormal,
      surfaceType: raw.surfaceType,
      rayDistance: raw.rayDistance,
      wheelCenterWorld: raw.wheelCenterWorld,
      mountWorld: raw.mountWorld,
    };
  };

  return [
    finalizeWheel(0),
    finalizeWheel(1),
    finalizeWheel(2),
    finalizeWheel(3),
  ];
}
