/**
 * Pure TypeScript core types for the deterministic M9 vehicle physics engine.
 *
 * Coordinate frame convention (matching `CarModel` and `TrackModel`):
 * - Right-handed Cartesian space in SI meters (`+X` right, `+Y` up, `-Z` forward).
 * - Positive yaw around `+Y` turns left (CCW when viewed from above `+Y`).
 */

export interface PhysicsVec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface PhysicsQuat {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly w: number;
}

/**
 * Fixed wheel order matching `CDO` `0x20..0x3F` (`0 = FL`, `1 = FR`, `2 = RL`, `3 = RR`).
 */
export type WheelSlotIndex = 0 | 1 | 2 | 3;

export type WheelSlotTuple<T> = readonly [T, T, T, T];

export type PhysicsSurfaceType = 'asphalt' | 'kerb' | 'gravel' | 'grass' | 'wall' | 'ceiling';

export type DriveLayout = 'FF' | 'FR' | 'MR' | '4WD';

export type DifferentialKind = 'open' | 'lsd';

export type TransmissionMode = 'auto' | 'manual';

export interface VehiclePose {
  readonly position: PhysicsVec3;
  readonly orientation: PhysicsQuat;
}

export interface VehicleControls {
  /** Normalized throttle pedal input in `[0, 1]`. */
  readonly throttle: number;
  /** Normalized service brake pedal input in `[0, 1]`. */
  readonly brake: number;
  /** Normalized handbrake input in `[0, 1]`. */
  readonly handbrake: number;
  /** Normalized steering input in `[-1, 1]` where positive `+1` steers left (`+Y` CCW). */
  readonly steer: number;
  /** Rising-edge manual upshift trigger. */
  readonly shiftUp?: boolean;
  /** Rising-edge manual downshift trigger. */
  readonly shiftDown?: boolean;
}

export interface FixedStepResult {
  readonly stepsExecuted: number;
  readonly alpha: number;
  readonly clampedFrameDt: number;
  readonly simTime: number;
  readonly stepCount: number;
}
