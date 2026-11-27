import type { TrackBoundingBox } from '../formats/track';
import type { Mat4, Vec3 } from './math';

/** Normalized plane equation `a*x + b*y + c*z + d = 0` facing inward toward the frustum interior. */
export type FrustumPlane = readonly [number, number, number, number];

/** Six frustum clipping planes in `[left, right, bottom, top, near, far]` order. */
export type FrustumPlanes = readonly [
  FrustumPlane,
  FrustumPlane,
  FrustumPlane,
  FrustumPlane,
  FrustumPlane,
  FrustumPlane,
];

function normalizePlane(a: number, b: number, c: number, d: number): FrustumPlane {
  const len = Math.hypot(a, b, c);
  if (len <= 1e-12 || !Number.isFinite(len)) {
    return [0, 0, 0, 0];
  }
  const inv = 1 / len;
  return [a * inv, b * inv, c * inv, d * inv];
}

/**
 * Extracts six normalized Gribb–Hartmann frustum planes from a column-major 4×4
 * view-projection matrix (`M8.7`).
 */
export function extractFrustumPlanes(viewProj: Mat4): FrustumPlanes {
  const m00 = viewProj[0] ?? 0;
  const m10 = viewProj[1] ?? 0;
  const m20 = viewProj[2] ?? 0;
  const m30 = viewProj[3] ?? 0;

  const m01 = viewProj[4] ?? 0;
  const m11 = viewProj[5] ?? 0;
  const m21 = viewProj[6] ?? 0;
  const m31 = viewProj[7] ?? 0;

  const m02 = viewProj[8] ?? 0;
  const m12 = viewProj[9] ?? 0;
  const m22 = viewProj[10] ?? 0;
  const m32 = viewProj[11] ?? 0;

  const m03 = viewProj[12] ?? 0;
  const m13 = viewProj[13] ?? 0;
  const m23 = viewProj[14] ?? 0;
  const m33 = viewProj[15] ?? 0;

  const left = normalizePlane(m30 + m00, m31 + m01, m32 + m02, m33 + m03);
  const right = normalizePlane(m30 - m00, m31 - m01, m32 - m02, m33 - m03);
  const bottom = normalizePlane(m30 + m10, m31 + m11, m32 + m12, m33 + m13);
  const top = normalizePlane(m30 - m10, m31 - m11, m32 - m12, m33 - m13);
  const near = normalizePlane(m30 + m20, m31 + m21, m32 + m22, m33 + m23);
  const far = normalizePlane(m30 - m20, m31 - m21, m32 - m22, m33 - m23);

  return [left, right, bottom, top, near, far];
}

function isBoxOutsidePlane(
  plane: FrustumPlane,
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): boolean {
  const [a, b, c, d] = plane;
  const px = a >= 0 ? maxX : minX;
  const py = b >= 0 ? maxY : minY;
  const pz = c >= 0 ? maxZ : minZ;
  return a * px + b * py + c * pz + d < 0;
}

/**
 * Tests whether an axis-aligned bounding box `[min, max]` intersects or lies inside
 * all six frustum planes using the fast positive-vertex test.
 */
export function isAabbInFrustum(planes: FrustumPlanes, min: Vec3, max: Vec3): boolean {
  const minX = min[0];
  const minY = min[1];
  const minZ = min[2];
  const maxX = max[0];
  const maxY = max[1];
  const maxZ = max[2];

  for (let i = 0; i < 6; i += 1) {
    if (isBoxOutsidePlane(planes[i]!, minX, minY, minZ, maxX, maxY, maxZ)) {
      return false;
    }
  }
  return true;
}

/**
 * Zero-allocation overload for `TrackBoundingBox` (`{ min: {x,y,z}, max: {x,y,z} }`).
 */
export function isTrackBoxInFrustum(planes: FrustumPlanes, box: TrackBoundingBox): boolean {
  const minX = box.min.x;
  const minY = box.min.y;
  const minZ = box.min.z;
  const maxX = box.max.x;
  const maxY = box.max.y;
  const maxZ = box.max.z;

  for (let i = 0; i < 6; i += 1) {
    if (isBoxOutsidePlane(planes[i]!, minX, minY, minZ, maxX, maxY, maxZ)) {
      return false;
    }
  }
  return true;
}
