import { describe, expect, it } from 'vitest';
import { VEC3_UP, type VehiclePose, quatFromAxisAngle } from '../../src/physics';
import {
  CHASE_CAMERA_PRESETS,
  ChaseCamera,
  mat4TransformPoint,
} from '../../src/renderer';

function makePose(x: number, y: number, z: number, yawRad = 0): VehiclePose {
  return {
    position: { x, y, z },
    orientation: quatFromAxisAngle(VEC3_UP, yawRad),
  };
}

describe('ChaseCamera (M9.8)', () => {
  it('snaps directly behind the vehicle -Z forward nose for identity and rotated yaws', () => {
    const cam = new ChaseCamera({ aspect: 16 / 9 });
    const std = CHASE_CAMERA_PRESETS.standard;

    cam.snapToPose(makePose(10, 1, -20, 0));
    const s0 = cam.getState();
    expect(s0.initialized).toBe(true);
    expect(s0.position[0]).toBeCloseTo(10, 5);
    expect(s0.position[1]).toBeCloseTo(1 + std.heightMeters, 5);
    expect(s0.position[2]).toBeCloseTo(-20 + std.distanceMeters, 5);
    expect(s0.target[0]).toBeCloseTo(10, 5);
    expect(s0.target[1]).toBeCloseTo(1 + std.lookHeightMeters, 5);
    expect(s0.target[2]).toBeCloseTo(-20 - std.lookAheadMeters, 5);

    // Rotated +90 deg around +Y: car's -Z forward now points along -X, so camera trails at +X
    cam.snapToPose(makePose(0, 0, 0, Math.PI * 0.5));
    const s90 = cam.getState();
    expect(s90.position[0]).toBeCloseTo(std.distanceMeters, 4);
    expect(s90.position[2]).toBeCloseTo(0, 4);
    expect(s90.target[0]).toBeCloseTo(-std.lookAheadMeters, 4);
  });

  it('converges smoothly via framerate-consistent exponential damping without overshoot or NaN', () => {
    const pose0 = makePose(0, 0, 0, 0);
    const pose1 = makePose(0, 0, -20, 0);

    const camSingle = new ChaseCamera();
    camSingle.snapToPose(pose0);
    camSingle.update(pose1, 0.05);

    const camSub = new ChaseCamera();
    camSub.snapToPose(pose0);
    camSub.update(pose1, 0.025);
    camSub.update(pose1, 0.025);

    // Framerate-independent exponential damping matches across step subdivision
    expect(camSingle.getPosition()[2]).toBeCloseTo(camSub.getPosition()[2], 6);

    // Monotonically approaches ideal trailing position without overshooting z < -20 + distance
    const idealZ = -20 + CHASE_CAMERA_PRESETS.standard.distanceMeters;
    expect(camSingle.getPosition()[2]).toBeLessThan(CHASE_CAMERA_PRESETS.standard.distanceMeters);
    expect(camSingle.getPosition()[2]).toBeGreaterThan(idealZ);

    for (let i = 0; i < 120; i += 1) {
      camSingle.update(pose1, 0.05);
    }
    expect(camSingle.getPosition()[2]).toBeCloseTo(idealZ, 4);

    // Zero / negative / non-finite dt never produces NaN
    camSingle.update(pose1, 0);
    camSingle.update(pose1, -0.5);
    camSingle.update(pose1, Number.NaN);
    for (const v of camSingle.getPosition()) {
      expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('cycles through trailing-only presets (standard -> close -> far -> standard)', () => {
    const cam = new ChaseCamera();
    expect(cam.getPresetId()).toBe('standard');

    expect(cam.cyclePreset()).toBe('close');
    cam.snapToPose(makePose(0, 0, 0));
    const closePos = cam.getPosition();

    expect(cam.cyclePreset()).toBe('far');
    cam.snapToPose(makePose(0, 0, 0));
    const farPos = cam.getPosition();

    expect(closePos[2]).toBeLessThan(farPos[2]);
    expect(closePos[1]).toBeLessThan(farPos[1]);

    expect(cam.cyclePreset()).toBe('standard');
  });

  it('produces valid right-handed view-projection matrices keeping the vehicle ahead of the camera', () => {
    const cam = new ChaseCamera({ aspect: 16 / 9 });
    cam.snapToPose(makePose(5, 0.5, -10, 0.25));

    const viewProj = cam.getViewProjectionMatrix();
    expect(viewProj).toHaveLength(16);
    for (let i = 0; i < 16; i += 1) {
      expect(Number.isFinite(viewProj[i])).toBe(true);
    }

    const clip = mat4TransformPoint(viewProj, [5, 0.5, -10]);
    expect(clip[3]).toBeGreaterThan(0);
    const ndcX = clip[0] / clip[3];
    const ndcY = clip[1] / clip[3];
    const ndcZ = clip[2] / clip[3];
    expect(Math.abs(ndcX)).toBeLessThan(0.5);
    expect(Math.abs(ndcY)).toBeLessThan(0.5);
    expect(ndcZ).toBeGreaterThan(-1);
    expect(ndcZ).toBeLessThan(1);
  });
});
