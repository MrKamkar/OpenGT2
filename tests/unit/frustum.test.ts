import { describe, expect, it } from 'vitest';
import {
  extractFrustumPlanes,
  isAabbInFrustum,
  isTrackBoxInFrustum,
  mat4LookAt,
  mat4Multiply,
  mat4Perspective,
} from '../../src/renderer';

function makeCameraViewProj(
  eye: readonly [number, number, number] = [0, 0, 0],
  target: readonly [number, number, number] = [0, 0, -1],
  near = 1,
  far = 100,
) {
  const proj = mat4Perspective((60 * Math.PI) / 180, 1, near, far);
  const view = mat4LookAt(eye, target, [0, 1, 0]);
  return mat4Multiply(proj, view);
}

describe('Frustum culling math (M8.7)', () => {
  it('extracts 6 unit-length inward planes from viewProj', () => {
    const vp = makeCameraViewProj();
    const planes = extractFrustumPlanes(vp);
    expect(planes).toHaveLength(6);
    for (const [a, b, c] of planes) {
      expect(Math.hypot(a, b, c)).toBeCloseTo(1, 5);
    }
  });

  it('accepts boxes inside, straddling, or enclosing the frustum and rejects outside boxes on all 6 sides', () => {
    const vp = makeCameraViewProj([0, 0, 0], [0, 0, -1], 1, 100);
    const planes = extractFrustumPlanes(vp);

    // Strictly inside frustum at z = -10.
    expect(isAabbInFrustum(planes, [-1, -1, -12], [1, 1, -8])).toBe(true);
    expect(
      isTrackBoxInFrustum(planes, { min: { x: -1, y: -1, z: -12 }, max: { x: 1, y: 1, z: -8 } }),
    ).toBe(true);

    // Straddling right frustum plane at z = -10 (half-width at 60 deg fov, aspect 1 is ~5.77).
    expect(isAabbInFrustum(planes, [5, -1, -11], [10, 1, -9])).toBe(true);

    // Enclosing the entire frustum.
    expect(isAabbInFrustum(planes, [-500, -500, -500], [500, 500, 500])).toBe(true);

    // Behind camera (near = 1, so z > -1 is outside near plane).
    expect(isAabbInFrustum(planes, [-1, -1, 2], [1, 1, 5])).toBe(false);

    // Beyond far plane (far = 100).
    expect(isAabbInFrustum(planes, [-1, -1, -120], [1, 1, -105])).toBe(false);

    // Strictly outside left, right, top, bottom planes at z = -10.
    expect(isAabbInFrustum(planes, [-20, -1, -11], [-10, 1, -9])).toBe(false);
    expect(isAabbInFrustum(planes, [10, -1, -11], [20, 1, -9])).toBe(false);
    expect(isAabbInFrustum(planes, [-1, 10, -11], [1, 20, -9])).toBe(false);
    expect(isAabbInFrustum(planes, [-1, -20, -11], [1, -10, -9])).toBe(false);
  });
});
