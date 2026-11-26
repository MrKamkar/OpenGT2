import { describe, expect, it } from 'vitest';
import { InputManager } from '../../src/core/input';
import { buildCarModel } from '../../src/formats/car';
import { parseCdo } from '../../src/formats/car/cdo';
import {
  CAMERA_VIEW_PRESETS,
  OrbitCamera,
  PS1_FIXED_POINT_SCALE,
  cdoBoundingBoxToAabbMeters,
  fixedPointToMeters,
  mat4LookAt,
  mat4Multiply,
  mat4Perspective,
  mat4TransformPoint,
} from '../../src/renderer';
import { buildSyntheticCdo } from '../fixtures/buildCdo';

describe('Renderer math & OrbitCamera (M7.3)', () => {
  it('converts fixed-point 1/4096 m coordinates and builds orthonormal right-handed lookAt/perspective matrices', () => {
    expect(PS1_FIXED_POINT_SCALE).toBe(4096);
    expect(fixedPointToMeters(4096)).toBe(1);
    expect(fixedPointToMeters(-2048)).toBe(-0.5);

    const view = mat4LookAt([0, 0, 5], [0, 0, 0], [0, 1, 0]);
    const originView = mat4TransformPoint(view, [0, 0, 0]);
    // Target lies along -Z in right-handed view space.
    expect(originView[0]).toBeCloseTo(0, 5);
    expect(originView[1]).toBeCloseTo(0, 5);
    expect(originView[2]).toBeCloseTo(-5, 5);
    expect(originView[3]).toBeCloseTo(1, 5);

    const proj = mat4Perspective(Math.PI / 3, 4 / 3, 0.1, 100);
    const vp = mat4Multiply(proj, view);
    const clip = mat4TransformPoint(vp, [0, 0, 0]);
    const ndcZ = clip[2] / clip[3];
    expect(ndcZ).toBeGreaterThan(-1);
    expect(ndcZ).toBeLessThan(1);
  });

  it('fits camera cleanly to model AABB bounds and restores fitted pose on reset()', () => {
    const camera = new OrbitCamera({ aspect: 16 / 9 });
    camera.fitToBounds([-1, 0, -2], [1, 1.4, 2]);
    const fitted = camera.getState();

    expect(fitted.target[0]).toBeCloseTo(0, 6);
    expect(fitted.target[1]).toBeCloseTo(0.7, 6);
    expect(fitted.target[2]).toBeCloseTo(0, 6);
    expect(fitted.distance).toBeGreaterThan(2);

    // Every corner of the fitted AABB projects inside the NDC frustum [-1, 1].
    const vp = camera.getViewProjectionMatrix();
    const corners: readonly (readonly [number, number, number])[] = [
      [-1, 0, -2],
      [1, 0, -2],
      [-1, 1.4, -2],
      [1, 1.4, -2],
      [-1, 0, 2],
      [1, 0, 2],
      [-1, 1.4, 2],
      [1, 1.4, 2],
    ];
    for (const corner of corners) {
      const clip = mat4TransformPoint(vp, corner);
      expect(clip[3]).toBeGreaterThan(0);
      expect(Math.abs(clip[0] / clip[3])).toBeLessThanOrEqual(1.0);
      expect(Math.abs(clip[1] / clip[3])).toBeLessThanOrEqual(1.0);
    }

    camera.orbitBy(0.7, 0.3);
    camera.zoomByFactor(0.75);
    camera.nextPreset();
    expect(camera.getState().yaw).not.toBeCloseTo(fitted.yaw, 4);

    camera.reset();
    expect(camera.getState()).toEqual(fitted);
  });

  it('fits directly to a CarModel LOD bounding box', () => {
    const sampleVerts: readonly (readonly [number, number, number, number])[] = [
      [-2048, 0, -4096, 0],
      [2048, 0, -4096, 0],
      [2048, 2048, 4096, 0],
      [-2048, 2048, 4096, 0],
    ];
    const sampleNorms: readonly (readonly [number, number, number])[] = [[0, 500, 0]];
    const cdo = parseCdo(
      buildSyntheticCdo({
        lods: [
          { vertices: sampleVerts, normals: sampleNorms, triangles: [], quads: [], uvTriangles: [], uvQuads: [] },
          { vertices: sampleVerts, normals: sampleNorms, triangles: [], quads: [], uvTriangles: [], uvQuads: [] },
          { vertices: sampleVerts, normals: sampleNorms, triangles: [], quads: [], uvTriangles: [], uvQuads: [] },
        ],
      }),
    );
    const carModel = buildCarModel(cdo);
    const aabb = cdoBoundingBoxToAabbMeters(carModel.lods[0]!.boundingBox);

    const camera = new OrbitCamera();
    camera.fitToCarModel(carModel, 0);
    expect(camera.getState().target).toEqual([
      (aabb.min[0] + aabb.max[0]) * 0.5,
      (aabb.min[1] + aabb.max[1]) * 0.5,
      (aabb.min[2] + aabb.max[2]) * 0.5,
    ]);
  });

  it('integrates with InputManager in viewer context (WSAD + arrows simultaneously, +/- zoom, edge-triggered C, releaseAll on blur)', () => {
    const input = new InputManager({ initialContext: 'viewer' });
    const camera = new OrbitCamera();
    camera.fitToBounds([-1, 0, -2], [1, 1.2, 2]);
    const initial = camera.getState();

    // Orbit right with KeyD, then verify ArrowRight produces identical movement.
    input.handleKeyEvent({ type: 'keydown', code: 'KeyD', repeat: false });
    camera.updateFromInput(input, 0.25);
    const afterKeyD = camera.getState().yaw;
    expect(afterKeyD).toBeGreaterThan(initial.yaw);
    input.handleKeyEvent({ type: 'keyup', code: 'KeyD', repeat: false });

    camera.reset();
    input.handleKeyEvent({ type: 'keydown', code: 'ArrowRight', repeat: false });
    camera.updateFromInput(input, 0.25);
    expect(camera.getState().yaw).toBeCloseTo(afterKeyD, 6);

    // Opposing ArrowLeft + ArrowRight cancels rotation completely.
    const beforeCancel = camera.getState().yaw;
    input.handleKeyEvent({ type: 'keydown', code: 'ArrowLeft', repeat: false });
    camera.updateFromInput(input, 0.25);
    expect(camera.getState().yaw).toBeCloseTo(beforeCancel, 6);
    input.releaseAll();

    // Pitch up via KeyW / ArrowUp and zoom via Equal / Minus.
    const beforePitch = camera.getState().pitch;
    input.handleKeyEvent({ type: 'keydown', code: 'KeyW', repeat: false });
    input.handleKeyEvent({ type: 'keydown', code: 'Equal', repeat: false });
    camera.updateFromInput(input, 0.25);
    expect(camera.getState().pitch).toBeGreaterThan(beforePitch);
    expect(camera.getState().distance).toBeLessThan(initial.distance);

    // Simulating window blur (releaseAll) immediately stops movement (no stuck keys).
    input.releaseAll();
    const frozen = camera.getState();
    camera.updateFromInput(input, 0.5);
    expect(camera.getState()).toEqual(frozen);

    // Edge-triggered C key cycles presets once per press even across multiple frames.
    input.handleKeyEvent({ type: 'keydown', code: 'KeyC', repeat: false });
    camera.updateFromInput(input, 0.016);
    expect(camera.getState().presetIndex).toBe(1);
    camera.updateFromInput(input, 0.016);
    expect(camera.getState().presetIndex).toBe(1);

    input.handleKeyEvent({ type: 'keyup', code: 'KeyC', repeat: false });
    camera.updateFromInput(input, 0.016);
    input.handleKeyEvent({ type: 'keydown', code: 'KeyC', repeat: false });
    camera.updateFromInput(input, 0.016);
    expect(camera.getState().presetIndex).toBe(2 % CAMERA_VIEW_PRESETS.length);

    // Non-viewer context does not orbit or cycle presets.
    input.releaseAll();
    input.setContext('race');
    input.handleKeyEvent({ type: 'keydown', code: 'KeyD', repeat: false });
    input.handleKeyEvent({ type: 'keydown', code: 'KeyC', repeat: false });
    const raceSnapshot = camera.getState();
    camera.updateFromInput(input, 0.25);
    expect(camera.getState()).toEqual(raceSnapshot);
  });

  it('supports pointer drag & wheel zoom while clamping pitch and distance', () => {
    const camera = new OrbitCamera({ minDistance: 1, maxDistance: 10, distance: 5 });

    camera.orbitByPixels(100, -5000, 400);
    expect(camera.getState().pitch).toBeLessThan(Math.PI / 2);

    camera.orbitByPixels(0, 10000, 400);
    expect(camera.getState().pitch).toBeGreaterThan(-Math.PI / 2);

    camera.zoomByWheel(-10000);
    expect(camera.getState().distance).toBe(1);

    camera.zoomByWheel(10000);
    expect(camera.getState().distance).toBe(10);
  });
});
