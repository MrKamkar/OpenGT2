import type { PhysicsQuat, PhysicsVec3 } from './types';

/** Minimum vector magnitude squared before treating direction/quaternion as degenerate. */
export const MATH_EPSILON_SQ = 1e-12;

/** Cosine threshold above which `quatSlerp` falls back to normalized linear interpolation. */
export const QUAT_SLERP_DOT_THRESHOLD = 0.9995;

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return value < min ? min : value > max ? max : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function vec3(x: number, y: number, z: number): PhysicsVec3 {
  return { x, y, z };
}

export const VEC3_ZERO: PhysicsVec3 = { x: 0, y: 0, z: 0 };
export const VEC3_UP: PhysicsVec3 = { x: 0, y: 1, z: 0 };
export const VEC3_FORWARD: PhysicsVec3 = { x: 0, y: 0, z: -1 };
export const VEC3_RIGHT: PhysicsVec3 = { x: 1, y: 0, z: 0 };

export function isFiniteVec3(v: PhysicsVec3): boolean {
  return Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

export function isFiniteQuat(q: PhysicsQuat): boolean {
  return Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z) && Number.isFinite(q.w);
}

export function vec3Add(a: PhysicsVec3, b: PhysicsVec3): PhysicsVec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function vec3Sub(a: PhysicsVec3, b: PhysicsVec3): PhysicsVec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function vec3Scale(v: PhysicsVec3, s: number): PhysicsVec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

export function vec3Dot(a: PhysicsVec3, b: PhysicsVec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function vec3Cross(a: PhysicsVec3, b: PhysicsVec3): PhysicsVec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

export function vec3LengthSq(v: PhysicsVec3): number {
  return v.x * v.x + v.y * v.y + v.z * v.z;
}

export function vec3Length(v: PhysicsVec3): number {
  return Math.hypot(v.x, v.y, v.z);
}

export function vec3Normalize(v: PhysicsVec3, fallback: PhysicsVec3 = VEC3_UP): PhysicsVec3 {
  const lenSq = vec3LengthSq(v);
  if (!Number.isFinite(lenSq) || lenSq <= MATH_EPSILON_SQ) {
    return fallback;
  }
  const invLen = 1 / Math.sqrt(lenSq);
  return { x: v.x * invLen, y: v.y * invLen, z: v.z * invLen };
}

export function vec3Lerp(a: PhysicsVec3, b: PhysicsVec3, t: number): PhysicsVec3 {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
  };
}

export function quatIdentity(): PhysicsQuat {
  return { x: 0, y: 0, z: 0, w: 1 };
}

export function quatFromAxisAngle(axis: PhysicsVec3, angleRad: number): PhysicsQuat {
  const normAxis = vec3Normalize(axis, VEC3_UP);
  const half = angleRad * 0.5;
  const s = Math.sin(half);
  return quatNormalize({
    x: normAxis.x * s,
    y: normAxis.y * s,
    z: normAxis.z * s,
    w: Math.cos(half),
  });
}

export function quatNormalize(q: PhysicsQuat): PhysicsQuat {
  const lenSq = q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w;
  if (!Number.isFinite(lenSq) || lenSq <= MATH_EPSILON_SQ) {
    return quatIdentity();
  }
  const invLen = 1 / Math.sqrt(lenSq);
  return {
    x: q.x * invLen,
    y: q.y * invLen,
    z: q.z * invLen,
    w: q.w * invLen,
  };
}

export function quatConjugate(q: PhysicsQuat): PhysicsQuat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

export function quatMultiply(a: PhysicsQuat, b: PhysicsQuat): PhysicsQuat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/**
 * Rotates a 3D vector `v` by unit quaternion `q`: `q * (v, 0) * conj(q)`.
 */
export function quatRotateVec3(q: PhysicsQuat, v: PhysicsVec3): PhysicsVec3 {
  const tx = 2 * (q.y * v.z - q.z * v.y);
  const ty = 2 * (q.z * v.x - q.x * v.z);
  const tz = 2 * (q.x * v.y - q.y * v.x);

  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
}

/**
 * Shortest-path spherical linear interpolation between two unit quaternions.
 */
export function quatSlerp(a: PhysicsQuat, b: PhysicsQuat, t: number): PhysicsQuat {
  const alpha = clamp(t, 0, 1);
  const qa = quatNormalize(a);
  let qb = quatNormalize(b);

  let dot = qa.x * qb.x + qa.y * qb.y + qa.z * qb.z + qa.w * qb.w;
  if (dot < 0) {
    qb = { x: -qb.x, y: -qb.y, z: -qb.z, w: -qb.w };
    dot = -dot;
  }

  if (dot > QUAT_SLERP_DOT_THRESHOLD) {
    return quatNormalize({
      x: lerp(qa.x, qb.x, alpha),
      y: lerp(qa.y, qb.y, alpha),
      z: lerp(qa.z, qb.z, alpha),
      w: lerp(qa.w, qb.w, alpha),
    });
  }

  const theta0 = Math.acos(clamp(dot, -1, 1));
  const sinTheta0 = Math.sin(theta0);
  if (sinTheta0 <= 1e-8) {
    return qa;
  }

  const theta = theta0 * alpha;
  const sinTheta = Math.sin(theta);
  const s0 = Math.cos(theta) - (dot * sinTheta) / sinTheta0;
  const s1 = sinTheta / sinTheta0;

  return quatNormalize({
    x: s0 * qa.x + s1 * qb.x,
    y: s0 * qa.y + s1 * qb.y,
    z: s0 * qa.z + s1 * qb.z,
    w: s0 * qa.w + s1 * qb.w,
  });
}
