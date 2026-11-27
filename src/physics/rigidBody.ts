import { AIR_DENSITY_KG_M3, GRAVITY_MPS2, type CarPhysicsSpec } from './carSpec';
import {
  VEC3_FORWARD,
  VEC3_UP,
  VEC3_ZERO,
  isFiniteQuat,
  isFiniteVec3,
  quatConjugate,
  quatIdentity,
  quatMultiply,
  quatNormalize,
  quatRotateVec3,
  vec3Add,
  vec3Cross,
  vec3Dot,
  vec3Length,
  vec3Scale,
  vec3Sub,
} from './math';
import type { PhysicsQuat, PhysicsVec3 } from './types';

/** Default linear velocity damping rate (1/s) representing parasitic air/mechanical losses. */
export const DEFAULT_LINEAR_DAMPING = 0.02;

/** Default angular velocity damping rate (1/s) stabilizing pitch/roll/yaw oscillation. */
export const DEFAULT_ANGULAR_DAMPING = 0.35;

/** Hard clamp on chassis angular speed (rad/s) to prevent numerical blow-up on severe impacts. */
export const MAX_CHASSIS_ANGULAR_SPEED_RAD_S = 15.0;

/** Hard clamp on chassis linear speed (m/s) as a non-explosive safety bound (~540 km/h). */
export const MAX_CHASSIS_LINEAR_SPEED_MPS = 150.0;

export interface RigidBodyState {
  position: PhysicsVec3;
  orientation: PhysicsQuat;
  linearVelocity: PhysicsVec3;
  angularVelocity: PhysicsVec3;
  forceAccum: PhysicsVec3;
  torqueAccum: PhysicsVec3;
}

export interface RigidBodyParams {
  readonly massKg: number;
  readonly invMass: number;
  readonly inertiaLocal: PhysicsVec3;
  readonly invInertiaLocal: PhysicsVec3;
  readonly linearDamping: number;
  readonly angularDamping: number;
  readonly dragAreaCdA: number;
  readonly downforceAreaClA: number;
}

export function createRigidBodyParamsFromSpec(
  spec: CarPhysicsSpec,
  overrides: { readonly linearDamping?: number; readonly angularDamping?: number } = {},
): RigidBodyParams {
  const massKg = Math.max(1, spec.massKg);
  return {
    massKg,
    invMass: 1 / massKg,
    inertiaLocal: spec.inertiaLocal,
    invInertiaLocal: {
      x: 1 / Math.max(1, spec.inertiaLocal.x),
      y: 1 / Math.max(1, spec.inertiaLocal.y),
      z: 1 / Math.max(1, spec.inertiaLocal.z),
    },
    linearDamping: overrides.linearDamping ?? DEFAULT_LINEAR_DAMPING,
    angularDamping: overrides.angularDamping ?? DEFAULT_ANGULAR_DAMPING,
    dragAreaCdA: spec.dragAreaCdA,
    downforceAreaClA: spec.downforceAreaClA,
  };
}

export function createRigidBodyState(
  position: PhysicsVec3 = VEC3_ZERO,
  orientation: PhysicsQuat = quatIdentity(),
): RigidBodyState {
  return {
    position: { ...position },
    orientation: quatNormalize(orientation),
    linearVelocity: { ...VEC3_ZERO },
    angularVelocity: { ...VEC3_ZERO },
    forceAccum: { ...VEC3_ZERO },
    torqueAccum: { ...VEC3_ZERO },
  };
}

export function cloneRigidBodyState(state: RigidBodyState): RigidBodyState {
  return {
    position: { ...state.position },
    orientation: { ...state.orientation },
    linearVelocity: { ...state.linearVelocity },
    angularVelocity: { ...state.angularVelocity },
    forceAccum: { ...state.forceAccum },
    torqueAccum: { ...state.torqueAccum },
  };
}

export function clearRigidBodyAccumulators(state: RigidBodyState): void {
  state.forceAccum = { ...VEC3_ZERO };
  state.torqueAccum = { ...VEC3_ZERO };
}

export function applyWorldForce(state: RigidBodyState, force: PhysicsVec3): void {
  if (!isFiniteVec3(force)) {
    return;
  }
  state.forceAccum = vec3Add(state.forceAccum, force);
}

export function applyWorldTorque(state: RigidBodyState, torque: PhysicsVec3): void {
  if (!isFiniteVec3(torque)) {
    return;
  }
  state.torqueAccum = vec3Add(state.torqueAccum, torque);
}

export function applyWorldForceAtPoint(
  state: RigidBodyState,
  force: PhysicsVec3,
  worldPoint: PhysicsVec3,
): void {
  if (!isFiniteVec3(force) || !isFiniteVec3(worldPoint)) {
    return;
  }
  const r = vec3Sub(worldPoint, state.position);
  state.forceAccum = vec3Add(state.forceAccum, force);
  state.torqueAccum = vec3Add(state.torqueAccum, vec3Cross(r, force));
}

export function getWorldPointVelocity(
  state: RigidBodyState,
  worldPoint: PhysicsVec3,
): PhysicsVec3 {
  const r = vec3Sub(worldPoint, state.position);
  return vec3Add(state.linearVelocity, vec3Cross(state.angularVelocity, r));
}

export function applyGravityForce(state: RigidBodyState, params: RigidBodyParams): void {
  applyWorldForce(state, { x: 0, y: -params.massKg * GRAVITY_MPS2, z: 0 });
}

/**
 * Applies quadratic aerodynamic drag opposing velocity and downforce along `-chassisUp`
 * proportional to forward airspeed squared.
 */
export function applyAerodynamicForces(state: RigidBodyState, params: RigidBodyParams): void {
  const speed = vec3Length(state.linearVelocity);
  if (speed <= 1e-4) {
    return;
  }

  // Quadratic drag: F_drag = -0.5 * rho * CdA * |v| * v
  const dragCoeff = -0.5 * AIR_DENSITY_KG_M3 * params.dragAreaCdA * speed;
  applyWorldForce(state, vec3Scale(state.linearVelocity, dragCoeff));

  // Aerodynamic downforce along -chassisUp driven by forward speed component
  if (params.downforceAreaClA > 0) {
    const forward = quatRotateVec3(state.orientation, VEC3_FORWARD);
    const up = quatRotateVec3(state.orientation, VEC3_UP);
    const forwardSpeed = Math.max(0, vec3Dot(state.linearVelocity, forward));
    const downforceMag = 0.5 * AIR_DENSITY_KG_M3 * params.downforceAreaClA * forwardSpeed * forwardSpeed;
    applyWorldForce(state, vec3Scale(up, -downforceMag));
  }
}

/**
 * Advances chassis linear & angular state by `dt` seconds using semi-implicit Euler integration,
 * transforming torque into the body's local inertia frame and renormalizing the orientation quaternion.
 */
export function integrateRigidBody(
  state: RigidBodyState,
  params: RigidBodyParams,
  dt: number,
): void {
  if (!Number.isFinite(dt) || dt <= 0) {
    return;
  }

  // 1. Linear velocity update
  const linAccel = vec3Scale(state.forceAccum, params.invMass);
  const nextLin = vec3Add(state.linearVelocity, vec3Scale(linAccel, dt));
  const linDamp = Math.exp(-params.linearDamping * dt);
  let dampedLin = vec3Scale(nextLin, linDamp);
  const linSpeed = vec3Length(dampedLin);
  if (linSpeed > MAX_CHASSIS_LINEAR_SPEED_MPS) {
    dampedLin = vec3Scale(dampedLin, MAX_CHASSIS_LINEAR_SPEED_MPS / linSpeed);
  }
  state.linearVelocity = isFiniteVec3(dampedLin) ? dampedLin : { ...VEC3_ZERO };

  // 2. Angular velocity update in chassis local inertia frame
  const qInv = quatConjugate(state.orientation);
  const localTorque = quatRotateVec3(qInv, state.torqueAccum);
  const localAngVel = quatRotateVec3(qInv, state.angularVelocity);

  const nextLocalAngVel: PhysicsVec3 = {
    x: localAngVel.x + localTorque.x * params.invInertiaLocal.x * dt,
    y: localAngVel.y + localTorque.y * params.invInertiaLocal.y * dt,
    z: localAngVel.z + localTorque.z * params.invInertiaLocal.z * dt,
  };
  const angDamp = Math.exp(-params.angularDamping * dt);
  let worldAngVel = quatRotateVec3(state.orientation, vec3Scale(nextLocalAngVel, angDamp));
  const angSpeed = vec3Length(worldAngVel);
  if (angSpeed > MAX_CHASSIS_ANGULAR_SPEED_RAD_S) {
    worldAngVel = vec3Scale(worldAngVel, MAX_CHASSIS_ANGULAR_SPEED_RAD_S / angSpeed);
  }
  state.angularVelocity = isFiniteVec3(worldAngVel) ? worldAngVel : { ...VEC3_ZERO };

  // 3. Position integration using updated velocity (semi-implicit Euler)
  const nextPos = vec3Add(state.position, vec3Scale(state.linearVelocity, dt));
  if (isFiniteVec3(nextPos)) {
    state.position = nextPos;
  }

  // 4. Quaternion orientation integration: dq/dt = 0.5 * (omega_world, 0) * q
  const omegaQuat: PhysicsQuat = {
    x: state.angularVelocity.x,
    y: state.angularVelocity.y,
    z: state.angularVelocity.z,
    w: 0,
  };
  const dq = quatMultiply(omegaQuat, state.orientation);
  const nextQuat = quatNormalize({
    x: state.orientation.x + 0.5 * dq.x * dt,
    y: state.orientation.y + 0.5 * dq.y * dt,
    z: state.orientation.z + 0.5 * dq.z * dt,
    w: state.orientation.w + 0.5 * dq.w * dt,
  });
  if (isFiniteQuat(nextQuat)) {
    state.orientation = nextQuat;
  }

  clearRigidBodyAccumulators(state);
}
