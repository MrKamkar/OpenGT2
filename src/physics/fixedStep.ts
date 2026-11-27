import { clamp, quatSlerp, vec3Lerp } from './math';
import type { FixedStepResult, VehiclePose } from './types';

/** Physics simulation tick frequency (120 Hz, ROADMAP M9.1). */
export const FIXED_STEP_HZ = 120;

/** Fixed simulation timestep in seconds (`1 / 120 s = 0.008333... s`). */
export const FIXED_DT = 1 / FIXED_STEP_HZ;

/** Maximum accepted render frame delta in seconds (`0.1 s`) to prevent spiral of death. */
export const MAX_FRAME_DT = 0.1;

/** Maximum fixed physics substeps permitted within a single `advance()` call. */
export const MAX_SUBSTEPS_PER_FRAME = 12;

export interface FixedTimestepLoopOptions {
  readonly fixedDt?: number;
  readonly maxFrameDt?: number;
  readonly maxSubsteps?: number;
}

/**
 * Deterministic fixed-timestep accumulator decoupling physics stepping (`120 Hz`)
 * from variable render frame rates (`30 Hz`, `60 Hz`, `144 Hz`, etc.).
 */
export class FixedTimestepLoop {
  readonly fixedDt: number;
  readonly maxFrameDt: number;
  readonly maxSubsteps: number;

  private accumulator = 0;
  private stepCount = 0;

  constructor(options: FixedTimestepLoopOptions = {}) {
    const fixedDt = options.fixedDt ?? FIXED_DT;
    const maxFrameDt = options.maxFrameDt ?? MAX_FRAME_DT;
    const maxSubsteps = options.maxSubsteps ?? MAX_SUBSTEPS_PER_FRAME;

    if (!Number.isFinite(fixedDt) || fixedDt <= 0) {
      throw new RangeError(`fixedDt must be a positive finite number, got ${String(fixedDt)}.`);
    }
    if (!Number.isFinite(maxFrameDt) || maxFrameDt <= 0) {
      throw new RangeError(`maxFrameDt must be a positive finite number, got ${String(maxFrameDt)}.`);
    }
    if (!Number.isInteger(maxSubsteps) || maxSubsteps < 1) {
      throw new RangeError(`maxSubsteps must be an integer >= 1, got ${String(maxSubsteps)}.`);
    }

    this.fixedDt = fixedDt;
    this.maxFrameDt = maxFrameDt;
    this.maxSubsteps = maxSubsteps;
  }

  get currentStepCount(): number {
    return this.stepCount;
  }

  get simTime(): number {
    return this.stepCount * this.fixedDt;
  }

  get pendingAccumulator(): number {
    return this.accumulator;
  }

  get alpha(): number {
    return clamp(this.accumulator / this.fixedDt, 0, 1);
  }

  /**
   * Resets accumulator and step counters cleanly (e.g., on race restart).
   */
  reset(): void {
    this.accumulator = 0;
    this.stepCount = 0;
  }

  /**
   * Advances the accumulator by `frameDtSeconds` (clamped to `[0, maxFrameDt]`) and executes
   * integer `fixedDt` steps via `onStep(fixedDt, stepIndex)`.
   */
  advance(
    frameDtSeconds: number,
    onStep: (dt: number, stepIndex: number) => void,
  ): FixedStepResult {
    const clampedFrameDt =
      Number.isFinite(frameDtSeconds) && frameDtSeconds > 0
        ? Math.min(frameDtSeconds, this.maxFrameDt)
        : 0;

    this.accumulator += clampedFrameDt;

    let stepsExecuted = 0;
    while (this.accumulator >= this.fixedDt && stepsExecuted < this.maxSubsteps) {
      const currentStep = this.stepCount;
      onStep(this.fixedDt, currentStep);
      this.stepCount += 1;
      this.accumulator -= this.fixedDt;
      stepsExecuted += 1;
    }

    // Clamp excess residual accumulator if substep cap was reached to avoid backlog spiral.
    if (stepsExecuted >= this.maxSubsteps && this.accumulator >= this.fixedDt) {
      this.accumulator = this.fixedDt * 0.999999;
    }

    return {
      stepsExecuted,
      alpha: this.alpha,
      clampedFrameDt,
      simTime: this.simTime,
      stepCount: this.stepCount,
    };
  }
}

/**
 * Interpolates between previous and current physics poses for smooth rendering at any FPS.
 */
export function interpolateVehiclePose(
  previous: VehiclePose,
  current: VehiclePose,
  alpha: number,
): VehiclePose {
  const t = clamp(alpha, 0, 1);
  return {
    position: vec3Lerp(previous.position, current.position, t),
    orientation: quatSlerp(previous.orientation, current.orientation, t),
  };
}

/**
 * Runs a deterministic replay of `stepFn` over an arbitrary render frame-delta schedule
 * using `FixedTimestepLoop`, returning final state, total steps executed, and render alpha.
 */
export function runDeterministicReplay<TState>(
  initialState: TState,
  frameDeltasSeconds: readonly number[],
  stepFn: (state: TState, dt: number, stepIndex: number) => TState,
  loopOptions: FixedTimestepLoopOptions = {},
): {
  readonly state: TState;
  readonly stepCount: number;
  readonly simTime: number;
  readonly alpha: number;
} {
  const loop = new FixedTimestepLoop(loopOptions);
  let state = initialState;

  for (const frameDt of frameDeltasSeconds) {
    loop.advance(frameDt, (dt, stepIndex) => {
      state = stepFn(state, dt, stepIndex);
    });
  }

  return {
    state,
    stepCount: loop.currentStepCount,
    simTime: loop.simTime,
    alpha: loop.alpha,
  };
}
