import { describe, expect, it } from 'vitest';
import {
  FIXED_DT,
  FIXED_STEP_HZ,
  FixedTimestepLoop,
  MAX_FRAME_DT,
  interpolateVehiclePose,
  runDeterministicReplay,
} from '../../src/physics/fixedStep';
import { quatFromAxisAngle, quatIdentity, quatNormalize } from '../../src/physics/math';
import { DeterministicPrng } from '../../src/physics/prng';
import type { VehiclePose } from '../../src/physics/types';

describe('DeterministicPrng (M9.1)', () => {
  it('produces identical sequences for identical seeds and diverges for different seeds', () => {
    const a = new DeterministicPrng(123456);
    const b = new DeterministicPrng(123456);
    const c = new DeterministicPrng(654321);

    const seqA = Array.from({ length: 16 }, () => a.nextUint32());
    const seqB = Array.from({ length: 16 }, () => b.nextUint32());
    const seqC = Array.from({ length: 16 }, () => c.nextUint32());

    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
  });

  it('bounds nextFloat in [0, 1) and nextRange in [min, max), and supports clone()', () => {
    const rng = new DeterministicPrng(42);
    for (let i = 0; i < 200; i += 1) {
      const f = rng.nextFloat();
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(1);
      const r = rng.nextRange(-5, 12.5);
      expect(r).toBeGreaterThanOrEqual(-5);
      expect(r).toBeLessThan(12.5);
    }

    const clone = rng.clone();
    expect(clone.getState()).toEqual(rng.getState());
    for (let i = 0; i < 10; i += 1) {
      expect(clone.nextUint32()).toBe(rng.nextUint32());
    }
  });
});

describe('FixedTimestepLoop & pose interpolation (M9.1)', () => {
  it('uses 120 Hz fixed timestep and clamps non-finite, negative, and oversized frame deltas', () => {
    expect(FIXED_STEP_HZ).toBe(120);
    expect(FIXED_DT).toBeCloseTo(1 / 120, 12);

    const loop = new FixedTimestepLoop();
    const zeroResult = loop.advance(0, () => {});
    expect(zeroResult.stepsExecuted).toBe(0);
    expect(zeroResult.clampedFrameDt).toBe(0);

    const negResult = loop.advance(-0.5, () => {});
    expect(negResult.stepsExecuted).toBe(0);

    const nanResult = loop.advance(Number.NaN, () => {});
    expect(nanResult.stepsExecuted).toBe(0);

    // Oversized frame delta (1.5 s) must clamp to MAX_FRAME_DT (0.1 s = 12 steps at 120 Hz)
    const steps: number[] = [];
    const bigResult = loop.advance(1.5, (dt, idx) => {
      steps.push(idx);
      expect(dt).toBe(FIXED_DT);
    });
    expect(bigResult.clampedFrameDt).toBe(MAX_FRAME_DT);
    expect(bigResult.stepsExecuted).toBe(12);
    expect(steps).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('interpolates position linearly and orientation along shortest-path quaternion slerp', () => {
    const prev: VehiclePose = {
      position: { x: 0, y: 1, z: 0 },
      orientation: quatIdentity(),
    };
    const q90 = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2);
    // Flip sign to test antipodal shortest-path handling
    const currAntipodal: VehiclePose = {
      position: { x: 10, y: 3, z: -20 },
      orientation: { x: -q90.x, y: -q90.y, z: -q90.z, w: -q90.w },
    };

    const start = interpolateVehiclePose(prev, currAntipodal, 0);
    expect(start.position).toEqual(prev.position);
    expect(start.orientation.w).toBeCloseTo(1, 6);

    const mid = interpolateVehiclePose(prev, currAntipodal, 0.5);
    expect(mid.position.x).toBeCloseTo(5, 6);
    expect(mid.position.y).toBeCloseTo(2, 6);
    expect(mid.position.z).toBeCloseTo(-10, 6);

    const expectedMid = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 4);
    const dot =
      mid.orientation.x * expectedMid.x +
      mid.orientation.y * expectedMid.y +
      mid.orientation.z * expectedMid.z +
      mid.orientation.w * expectedMid.w;
    expect(Math.abs(dot)).toBeCloseTo(1, 6);
    expect(quatNormalize(mid.orientation)).toEqual(mid.orientation);
  });

  it('produces bit-identical final state across 30 Hz, 60 Hz, and 144 Hz frame schedules', () => {
    interface ToyState {
      readonly x: number;
      readonly v: number;
      readonly yaw: number;
      readonly rng: DeterministicPrng;
    }

    // Input schedule keyed strictly by fixed step index
    const stepFn = (state: ToyState, dt: number, stepIndex: number): ToyState => {
      const accel = stepIndex < 120 ? 6.5 : -4.25;
      const noise = (state.rng.nextFloat() - 0.5) * 0.01;
      const nextV = state.v + (accel + noise) * dt;
      const nextX = state.x + nextV * dt;
      const nextYaw = state.yaw + 0.3 * dt;
      return {
        x: nextX,
        v: nextV,
        yaw: nextYaw,
        rng: state.rng,
      };
    };

    const mkInitial = (): ToyState => ({
      x: 0,
      v: 0,
      yaw: 0,
      rng: new DeterministicPrng(98765),
    });

    // Exact 2.0 seconds in integer step multiples (240 fixed steps at 120 Hz):
    // 60 frames @ 1/30 s = 2.0 s (4 steps/frame)
    // 120 frames @ 1/60 s = 2.0 s (2 steps/frame)
    // 288 frames @ 1/144 s = 2.0 s (fractional accumulation summing to 240 steps)
    // Note: 1/144 in IEEE-754 has slight rounding below 2.0, so add a tiny epsilon or use 1/120*...;
    // let's construct exact 144 Hz frames where total = 240 * FIXED_DT + 1e-12 to ensure step 240 completes.
    const schedule30 = Array.from({ length: 60 }, () => 1 / 30);
    const schedule60 = Array.from({ length: 120 }, () => 1 / 60);
    const schedule144 = Array.from({ length: 288 }, (_, i) => (i === 287 ? 1 / 144 + 1e-9 : 1 / 144));

    const run30 = runDeterministicReplay(mkInitial(), schedule30, stepFn);
    const run60 = runDeterministicReplay(mkInitial(), schedule60, stepFn);
    const run144 = runDeterministicReplay(mkInitial(), schedule144, stepFn);

    expect(run30.stepCount).toBe(240);
    expect(run60.stepCount).toBe(240);
    expect(run144.stepCount).toBe(240);

    // Bit-exact IEEE-754 identity across all three frame rates
    expect(Object.is(run30.state.x, run60.state.x)).toBe(true);
    expect(Object.is(run30.state.x, run144.state.x)).toBe(true);
    expect(Object.is(run30.state.v, run60.state.v)).toBe(true);
    expect(Object.is(run30.state.v, run144.state.v)).toBe(true);
    expect(Object.is(run30.state.yaw, run60.state.yaw)).toBe(true);
    expect(Object.is(run30.state.yaw, run144.state.yaw)).toBe(true);
    expect(run30.state.rng.getState()).toEqual(run60.state.rng.getState());
    expect(run30.state.rng.getState()).toEqual(run144.state.rng.getState());
  });
});
