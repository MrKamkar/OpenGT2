import { CDO_FIXED_POINT_SCALE, type CdoBoundingBox } from '../formats/car';

/** @evidence E2 — Fixed-point coordinate scale: 4096 raw units = 1 meter. */
export const PS1_FIXED_POINT_SCALE = CDO_FIXED_POINT_SCALE;

export type Vec3 = readonly [number, number, number];
export type Mat4 = Float32Array;

export interface Aabb3 {
  readonly min: Vec3;
  readonly max: Vec3;
}

/**
 * Converts a PS1 fixed-point coordinate (`1/4096 m`) into meters.
 *
 * @evidence E2
 */
export function fixedPointToMeters(rawUnits: number): number {
  return rawUnits / PS1_FIXED_POINT_SCALE;
}

/**
 * Converts a CDO `int16` bounding box (`1/4096 m`) into a meter-space `Aabb3`.
 *
 * @evidence E3
 */
export function cdoBoundingBoxToAabbMeters(bbox: CdoBoundingBox): Aabb3 {
  return {
    min: [
      fixedPointToMeters(bbox.low.x),
      fixedPointToMeters(bbox.low.y),
      fixedPointToMeters(bbox.low.z),
    ],
    max: [
      fixedPointToMeters(bbox.high.x),
      fixedPointToMeters(bbox.high.y),
      fixedPointToMeters(bbox.high.z),
    ],
  };
}

export function vec3Add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function vec3Sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function vec3Scale(v: Vec3, scalar: number): Vec3 {
  return [v[0] * scalar, v[1] * scalar, v[2] * scalar];
}

export function vec3Dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function vec3Cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function vec3Length(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

export function vec3Normalize(v: Vec3): Vec3 {
  const len = vec3Length(v);
  if (len <= 1e-12 || !Number.isFinite(len)) {
    return [0, 0, 0];
  }
  return [v[0] / len, v[1] / len, v[2] / len];
}

/**
 * Returns a column-major 4×4 identity matrix (`Float32Array(16)`).
 */
export function mat4Identity(): Mat4 {
  const out = new Float32Array(16);
  out[0] = 1;
  out[5] = 1;
  out[10] = 1;
  out[15] = 1;
  return out;
}

/**
 * Multiplies two column-major 4×4 matrices (`out = a * b`).
 */
export function mat4Multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col += 1) {
    const b0 = b[col * 4] ?? 0;
    const b1 = b[col * 4 + 1] ?? 0;
    const b2 = b[col * 4 + 2] ?? 0;
    const b3 = b[col * 4 + 3] ?? 0;
    for (let row = 0; row < 4; row += 1) {
      out[col * 4 + row] =
        (a[row] ?? 0) * b0 +
        (a[4 + row] ?? 0) * b1 +
        (a[8 + row] ?? 0) * b2 +
        (a[12 + row] ?? 0) * b3;
    }
  }
  return out;
}

/**
 * Builds a right-handed WebGL perspective projection matrix (NDC `z` in `[-1, 1]`).
 */
export function mat4Perspective(
  fovYRad: number,
  aspect: number,
  near: number,
  far: number,
): Mat4 {
  if (!(fovYRad > 0 && fovYRad < Math.PI)) {
    throw new RangeError(`fovYRad must be in (0, PI), got ${String(fovYRad)}`);
  }
  if (!(aspect > 0) || !Number.isFinite(aspect)) {
    throw new RangeError(`aspect must be positive and finite, got ${String(aspect)}`);
  }
  if (!(near > 0 && far > near)) {
    throw new RangeError(`Invalid near/far clip planes: near=${String(near)}, far=${String(far)}`);
  }

  const f = 1 / Math.tan(fovYRad * 0.5);
  const nf = 1 / (near - far);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) * nf;
  out[11] = -1;
  out[14] = 2 * far * near * nf;
  return out;
}

/**
 * Builds a right-handed column-major look-at view matrix (`+X` right, `+Y` up, `-Z` forward).
 */
export function mat4LookAt(eye: Vec3, target: Vec3, up: Vec3 = [0, 1, 0]): Mat4 {
  const zAxis = vec3Normalize(vec3Sub(eye, target));
  const rawX = vec3Cross(up, zAxis);
  const xAxis = vec3Length(rawX) > 1e-8 ? vec3Normalize(rawX) : ([1, 0, 0] as const);
  const yAxis = vec3Normalize(vec3Cross(zAxis, xAxis));

  const out = new Float32Array(16);
  out[0] = xAxis[0];
  out[1] = yAxis[0];
  out[2] = zAxis[0];
  out[3] = 0;

  out[4] = xAxis[1];
  out[5] = yAxis[1];
  out[6] = zAxis[1];
  out[7] = 0;

  out[8] = xAxis[2];
  out[9] = yAxis[2];
  out[10] = zAxis[2];
  out[11] = 0;

  out[12] = -vec3Dot(xAxis, eye);
  out[13] = -vec3Dot(yAxis, eye);
  out[14] = -vec3Dot(zAxis, eye);
  out[15] = 1;
  return out;
}

/**
 * Transforms a 3D point `(x, y, z, 1)` by a column-major 4×4 matrix returning `[x, y, z, w]`.
 */
export function mat4TransformPoint(
  mat: Mat4,
  point: Vec3,
): readonly [number, number, number, number] {
  const [x, y, z] = point;
  return [
    (mat[0] ?? 0) * x + (mat[4] ?? 0) * y + (mat[8] ?? 0) * z + (mat[12] ?? 0),
    (mat[1] ?? 0) * x + (mat[5] ?? 0) * y + (mat[9] ?? 0) * z + (mat[13] ?? 0),
    (mat[2] ?? 0) * x + (mat[6] ?? 0) * y + (mat[10] ?? 0) * z + (mat[14] ?? 0),
    (mat[3] ?? 0) * x + (mat[7] ?? 0) * y + (mat[11] ?? 0) * z + (mat[15] ?? 0),
  ];
}
