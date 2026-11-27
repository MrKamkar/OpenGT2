import { type PhysicsVec3, type VehiclePose, quatRotateVec3, VEC3_FORWARD } from '../physics';
import {
  type Mat4,
  type Vec3,
  mat4LookAt,
  mat4Multiply,
  mat4Perspective,
} from './math';

export type ChaseCameraPresetId = 'standard' | 'close' | 'far';

export interface ChaseCameraPreset {
  readonly id: ChaseCameraPresetId;
  readonly label: string;
  readonly distanceMeters: number;
  readonly heightMeters: number;
  readonly lookAheadMeters: number;
  readonly lookHeightMeters: number;
  readonly fovYRad: number;
  readonly positionStiffness: number;
  readonly targetStiffness: number;
}

/**
 * Trailing chase-camera presets cycled via `C` (`M9.8`).
 * Hood/cockpit presets are intentionally omitted because CDO models provide no verified camera mount point.
 */
export const CHASE_CAMERA_PRESETS: Readonly<Record<ChaseCameraPresetId, ChaseCameraPreset>> = {
  standard: {
    id: 'standard',
    label: 'Chase Standard',
    distanceMeters: 5.8,
    heightMeters: 2.15,
    lookAheadMeters: 2.5,
    lookHeightMeters: 0.95,
    fovYRad: (55 * Math.PI) / 180,
    positionStiffness: 10.0,
    targetStiffness: 14.0,
  },
  close: {
    id: 'close',
    label: 'Chase Close',
    distanceMeters: 4.4,
    heightMeters: 1.65,
    lookAheadMeters: 2.8,
    lookHeightMeters: 0.85,
    fovYRad: (58 * Math.PI) / 180,
    positionStiffness: 12.0,
    targetStiffness: 16.0,
  },
  far: {
    id: 'far',
    label: 'Chase Far',
    distanceMeters: 7.6,
    heightMeters: 2.85,
    lookAheadMeters: 2.2,
    lookHeightMeters: 1.05,
    fovYRad: (52 * Math.PI) / 180,
    positionStiffness: 8.5,
    targetStiffness: 12.0,
  },
};

export const CHASE_CAMERA_PRESET_ORDER: readonly ChaseCameraPresetId[] = [
  'standard',
  'close',
  'far',
];

export const DEFAULT_CHASE_CAMERA_ASPECT = 4 / 3;
export const DEFAULT_CHASE_CAMERA_NEAR = 0.25;
export const DEFAULT_CHASE_CAMERA_FAR = 4000;
const MAX_CHASE_DT_SECONDS = 0.25;

export interface ChaseCameraOptions {
  readonly preset?: ChaseCameraPresetId;
  readonly aspect?: number;
  readonly near?: number;
  readonly far?: number;
}

export interface ChaseCameraState {
  readonly presetId: ChaseCameraPresetId;
  readonly position: Vec3;
  readonly target: Vec3;
  readonly fovYRad: number;
  readonly aspect: number;
  readonly near: number;
  readonly far: number;
  readonly initialized: boolean;
}

function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
}

function isFinitePose(pose: VehiclePose): boolean {
  return (
    Number.isFinite(pose.position.x) &&
    Number.isFinite(pose.position.y) &&
    Number.isFinite(pose.position.z) &&
    Number.isFinite(pose.orientation.x) &&
    Number.isFinite(pose.orientation.y) &&
    Number.isFinite(pose.orientation.z) &&
    Number.isFinite(pose.orientation.w)
  );
}

/**
 * Pure TypeScript damped chase camera following an interpolated `VehiclePose` behind
 * the vehicle's `-Z` forward vector (`M9.8`).
 */
export class ChaseCamera {
  private presetId: ChaseCameraPresetId;
  private aspect: number;
  private readonly near: number;
  private readonly far: number;

  private position: Vec3 = [0, 2.15, 5.8];
  private target: Vec3 = [0, 0.95, -2.5];
  private lastHorizontalForward: Vec3 = [0, 0, -1];
  private initialized = false;

  public constructor(options: ChaseCameraOptions = {}) {
    this.presetId = options.preset ?? 'standard';
    this.aspect =
      options.aspect !== undefined && Number.isFinite(options.aspect) && options.aspect > 0
        ? options.aspect
        : DEFAULT_CHASE_CAMERA_ASPECT;
    this.near =
      options.near !== undefined && Number.isFinite(options.near) && options.near > 0
        ? options.near
        : DEFAULT_CHASE_CAMERA_NEAR;
    this.far =
      options.far !== undefined && Number.isFinite(options.far) && options.far > this.near
        ? options.far
        : DEFAULT_CHASE_CAMERA_FAR;
  }

  public getPreset(): ChaseCameraPreset {
    return CHASE_CAMERA_PRESETS[this.presetId];
  }

  public getPresetId(): ChaseCameraPresetId {
    return this.presetId;
  }

  public setPreset(id: ChaseCameraPresetId): void {
    this.presetId = id;
  }

  public cyclePreset(): ChaseCameraPresetId {
    const currentIdx = CHASE_CAMERA_PRESET_ORDER.indexOf(this.presetId);
    const nextIdx = currentIdx >= 0 ? (currentIdx + 1) % CHASE_CAMERA_PRESET_ORDER.length : 0;
    this.presetId = CHASE_CAMERA_PRESET_ORDER[nextIdx] ?? 'standard';
    return this.presetId;
  }

  public setAspect(aspect: number): void {
    if (Number.isFinite(aspect) && aspect > 0) {
      this.aspect = aspect;
    }
  }

  private extractHorizontalForward(pose: VehiclePose): Vec3 {
    const worldForward = quatRotateVec3(pose.orientation, VEC3_FORWARD);
    const horizLen = Math.hypot(worldForward.x, worldForward.z);
    if (Number.isFinite(horizLen) && horizLen > 1e-4) {
      const fwd: Vec3 = [worldForward.x / horizLen, 0, worldForward.z / horizLen];
      this.lastHorizontalForward = fwd;
      return fwd;
    }
    return this.lastHorizontalForward;
  }

  private computeIdealVectors(pose: VehiclePose): { readonly eye: Vec3; readonly target: Vec3 } {
    const preset = this.getPreset();
    const fwd = this.extractHorizontalForward(pose);

    const eye: Vec3 = [
      pose.position.x - fwd[0] * preset.distanceMeters,
      pose.position.y + preset.heightMeters,
      pose.position.z - fwd[2] * preset.distanceMeters,
    ];
    const target: Vec3 = [
      pose.position.x + fwd[0] * preset.lookAheadMeters,
      pose.position.y + preset.lookHeightMeters,
      pose.position.z + fwd[2] * preset.lookAheadMeters,
    ];
    return { eye, target };
  }

  /**
   * Immediately snaps eye and look-at target to the ideal trailing pose (used on spawn and reset).
   */
  public snapToPose(pose: VehiclePose): void {
    if (!isFinitePose(pose)) {
      return;
    }
    const ideal = this.computeIdealVectors(pose);
    this.position = ideal.eye;
    this.target = ideal.target;
    this.initialized = true;
  }

  /**
   * Smoothly damps camera position and look-at target toward the trailing pose for `dtSeconds`.
   */
  public update(pose: VehiclePose, dtSeconds: number, velocity?: PhysicsVec3): void {
    void velocity;
    if (!isFinitePose(pose)) {
      return;
    }
    if (!this.initialized) {
      this.snapToPose(pose);
      return;
    }

    const safeDt =
      Number.isFinite(dtSeconds) && dtSeconds > 0
        ? Math.min(dtSeconds, MAX_CHASE_DT_SECONDS)
        : 0;
    if (safeDt === 0) {
      return;
    }

    const preset = this.getPreset();
    const ideal = this.computeIdealVectors(pose);

    const posAlpha = 1 - Math.exp(-preset.positionStiffness * safeDt);
    const targetAlpha = 1 - Math.exp(-preset.targetStiffness * safeDt);

    this.position = lerpVec3(this.position, ideal.eye, posAlpha);
    this.target = lerpVec3(this.target, ideal.target, targetAlpha);
  }

  public getPosition(): Vec3 {
    return [...this.position];
  }

  public getTarget(): Vec3 {
    return [...this.target];
  }

  public getViewMatrix(): Mat4 {
    return mat4LookAt(this.position, this.target, [0, 1, 0]);
  }

  public getProjectionMatrix(): Mat4 {
    return mat4Perspective(this.getPreset().fovYRad, this.aspect, this.near, this.far);
  }

  public getViewProjectionMatrix(): Mat4 {
    return mat4Multiply(this.getProjectionMatrix(), this.getViewMatrix());
  }

  public getState(): ChaseCameraState {
    return {
      presetId: this.presetId,
      position: [...this.position],
      target: [...this.target],
      fovYRad: this.getPreset().fovYRad,
      aspect: this.aspect,
      near: this.near,
      far: this.far,
      initialized: this.initialized,
    };
  }
}
