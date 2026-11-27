import type { InputManager } from '../core/input';
import type { CarModel } from '../formats/car';
import {
  type Mat4,
  type Vec3,
  cdoBoundingBoxToAabbMeters,
  mat4LookAt,
  mat4Multiply,
  mat4Perspective,
} from './math';

export interface OrbitCameraPreset {
  readonly name: string;
  readonly yaw: number;
  readonly pitch: number;
  readonly distanceScale: number;
}

/**
 * Built-in showroom camera presets aligned with GT2's right-handed `+X right, +Y up, -Z forward` system.
 */
export const CAMERA_VIEW_PRESETS: readonly OrbitCameraPreset[] = Object.freeze([
  { name: 'front-right', yaw: Math.PI * 0.78, pitch: 0.24, distanceScale: 1.0 },
  { name: 'front-left', yaw: -Math.PI * 0.78, pitch: 0.24, distanceScale: 1.0 },
  { name: 'side-profile', yaw: Math.PI * 0.5, pitch: 0.14, distanceScale: 1.05 },
  { name: 'rear-three-quarter', yaw: Math.PI * 0.22, pitch: 0.24, distanceScale: 1.0 },
  { name: 'front-head-on', yaw: Math.PI, pitch: 0.15, distanceScale: 1.08 },
  { name: 'high-overview', yaw: Math.PI * 0.78, pitch: 0.72, distanceScale: 1.15 },
]);

export interface OrbitCameraOptions {
  readonly target?: Vec3;
  readonly yaw?: number;
  readonly pitch?: number;
  readonly distance?: number;
  readonly minDistance?: number;
  readonly maxDistance?: number;
  readonly fovYRad?: number;
  readonly aspect?: number;
  readonly near?: number;
  readonly far?: number;
  readonly yawSpeedRadPerSec?: number;
  readonly pitchSpeedRadPerSec?: number;
  readonly zoomSpeedPerSec?: number;
}

export interface OrbitCameraState {
  readonly target: Vec3;
  readonly yaw: number;
  readonly pitch: number;
  readonly distance: number;
  readonly fovYRad: number;
  readonly aspect: number;
  readonly near: number;
  readonly far: number;
  readonly presetIndex: number;
}

const MIN_PITCH_RAD = -Math.PI * 0.5 + 0.05;
const MAX_PITCH_RAD = Math.PI * 0.5 - 0.05;
const DEFAULT_FOV_Y_RAD = (45 * Math.PI) / 180;
const DEFAULT_ASPECT = 4 / 3;
const DEFAULT_NEAR = 0.05;
const DEFAULT_FAR = 200;
const DEFAULT_YAW_SPEED = 1.8;
const DEFAULT_PITCH_SPEED = 1.4;
const DEFAULT_ZOOM_SPEED = 1.6;
const DEFAULT_MIN_DISTANCE = 0.5;
const DEFAULT_MAX_DISTANCE = 50;

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function wrapAngle(rad: number): number {
  const twoPi = Math.PI * 2;
  let wrapped = (rad + Math.PI) % twoPi;
  if (wrapped < 0) {
    wrapped += twoPi;
  }
  return wrapped - Math.PI;
}

/**
 * Pure orbital camera decoupled from DOM/WebGL and integrated with `InputManager`
 * (`viewer` context: simultaneous WSAD + Arrow keys by `KeyboardEvent.code`, `+`/`-` zoom,
 * edge-triggered `C` view preset cycling) plus mouse/wheel/touch helpers (`M7.3`).
 */
export class OrbitCamera {
  private target: Vec3;
  private yaw: number;
  private pitch: number;
  private distance: number;
  private minDistance: number;
  private maxDistance: number;
  private fovYRad: number;
  private aspect: number;
  private near: number;
  private far: number;
  private presetIndex = 0;

  private fittedBaseDistance: number;
  private defaultTarget: Vec3;
  private defaultYaw: number;
  private defaultPitch: number;
  private defaultDistance: number;

  private readonly yawSpeedRadPerSec: number;
  private readonly pitchSpeedRadPerSec: number;
  private readonly zoomSpeedPerSec: number;
  private prevCameraNextActive = false;

  public constructor(options: OrbitCameraOptions = {}) {
    const initialPreset = CAMERA_VIEW_PRESETS[0]!;
    this.target = options.target ?? [0, 0.5, 0];
    this.yaw = wrapAngle(options.yaw ?? initialPreset.yaw);
    this.pitch = clamp(options.pitch ?? initialPreset.pitch, MIN_PITCH_RAD, MAX_PITCH_RAD);
    this.minDistance = options.minDistance ?? DEFAULT_MIN_DISTANCE;
    this.maxDistance = Math.max(this.minDistance, options.maxDistance ?? DEFAULT_MAX_DISTANCE);
    this.distance = clamp(options.distance ?? 4.5, this.minDistance, this.maxDistance);
    this.fovYRad = options.fovYRad ?? DEFAULT_FOV_Y_RAD;
    this.aspect = options.aspect ?? DEFAULT_ASPECT;
    this.near = options.near ?? DEFAULT_NEAR;
    this.far = options.far ?? DEFAULT_FAR;
    this.yawSpeedRadPerSec = options.yawSpeedRadPerSec ?? DEFAULT_YAW_SPEED;
    this.pitchSpeedRadPerSec = options.pitchSpeedRadPerSec ?? DEFAULT_PITCH_SPEED;
    this.zoomSpeedPerSec = options.zoomSpeedPerSec ?? DEFAULT_ZOOM_SPEED;

    this.fittedBaseDistance = this.distance;
    this.defaultTarget = this.target;
    this.defaultYaw = this.yaw;
    this.defaultPitch = this.pitch;
    this.defaultDistance = this.distance;
  }

  public setAspect(aspect: number): void {
    if (Number.isFinite(aspect) && aspect > 0) {
      this.aspect = aspect;
    }
  }

  public setTarget(target: Vec3): void {
    this.target = [target[0], target[1], target[2]];
  }

  /**
   * Automatically centers and frames an axis-aligned bounding box (`min`, `max` in meters),
   * storing the fitted pose as the `reset()` baseline.
   */
  public fitToBounds(min: Vec3, max: Vec3, paddingScale = 1.25): void {
    const cx = (min[0] + max[0]) * 0.5;
    const cy = (min[1] + max[1]) * 0.5;
    const cz = (min[2] + max[2]) * 0.5;
    const dx = Math.max(0, max[0] - min[0]);
    const dy = Math.max(0, max[1] - min[1]);
    const dz = Math.max(0, max[2] - min[2]);

    const radius = Math.max(0.25, 0.5 * Math.hypot(dx, dy, dz));
    const halfFovY = this.fovYRad * 0.5;
    const tanHalfFovY = Math.tan(halfFovY);
    const tanHalfFovX = tanHalfFovY * Math.max(0.1, this.aspect);
    const limitingSin = Math.min(
      Math.sin(halfFovY),
      Math.sin(Math.atan(tanHalfFovX)),
    );

    const safeDistance = Math.max(0.5, (radius / Math.max(0.1, limitingSin)) * paddingScale);

    this.minDistance = Math.max(0.2, radius * 0.65);
    this.maxDistance = Math.max(this.minDistance * 4, radius * 16);
    this.near = Math.max(0.02, radius * 0.02);
    this.far = Math.max(this.maxDistance * 4, 100);

    const preset = CAMERA_VIEW_PRESETS[this.presetIndex] ?? CAMERA_VIEW_PRESETS[0]!;
    this.target = [cx, cy, cz];
    this.fittedBaseDistance = safeDistance;
    this.yaw = wrapAngle(preset.yaw);
    this.pitch = clamp(preset.pitch, MIN_PITCH_RAD, MAX_PITCH_RAD);
    this.distance = clamp(safeDistance * preset.distanceScale, this.minDistance, this.maxDistance);

    this.defaultTarget = this.target;
    this.defaultYaw = this.yaw;
    this.defaultPitch = this.pitch;
    this.defaultDistance = this.distance;
  }

  /**
   * Convenience helper to fit the camera to a `CarModel`'s LOD bounding box.
   */
  public fitToCarModel(carModel: CarModel, lodIndex = 0, paddingScale = 1.25): void {
    const lod = carModel.lods[lodIndex];
    if (lod === undefined) {
      throw new RangeError(`LOD ${String(lodIndex)} out of bounds for OrbitCamera.fitToCarModel.`);
    }
    const aabb = cdoBoundingBoxToAabbMeters(lod.boundingBox, lod.scale);
    this.fitToBounds(aabb.min, aabb.max, paddingScale);
  }

  public applyPreset(index: number): void {
    const count = CAMERA_VIEW_PRESETS.length;
    const normalized = ((index % count) + count) % count;
    const preset = CAMERA_VIEW_PRESETS[normalized]!;
    this.presetIndex = normalized;
    this.yaw = wrapAngle(preset.yaw);
    this.pitch = clamp(preset.pitch, MIN_PITCH_RAD, MAX_PITCH_RAD);
    this.distance = clamp(
      this.fittedBaseDistance * preset.distanceScale,
      this.minDistance,
      this.maxDistance,
    );
  }

  public nextPreset(): number {
    this.applyPreset(this.presetIndex + 1);
    return this.presetIndex;
  }

  public reset(): void {
    this.target = this.defaultTarget;
    this.yaw = this.defaultYaw;
    this.pitch = this.defaultPitch;
    this.distance = this.defaultDistance;
    this.presetIndex = 0;
  }

  public orbitBy(deltaYawRad: number, deltaPitchRad: number): void {
    if (Number.isFinite(deltaYawRad)) {
      this.yaw = wrapAngle(this.yaw + deltaYawRad);
    }
    if (Number.isFinite(deltaPitchRad)) {
      this.pitch = clamp(this.pitch + deltaPitchRad, MIN_PITCH_RAD, MAX_PITCH_RAD);
    }
  }

  /**
   * Pointer/touch drag orbit helper scaled relative to viewport height.
   */
  public orbitByPixels(deltaX: number, deltaY: number, viewportHeight: number, sensitivity = Math.PI): void {
    const height = Math.max(1, viewportHeight);
    const scale = sensitivity / height;
    this.orbitBy(-deltaX * scale, deltaY * scale);
  }

  public zoomByFactor(factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0) {
      return;
    }
    this.distance = clamp(this.distance * factor, this.minDistance, this.maxDistance);
  }

  /**
   * Mouse wheel zoom helper (`deltaY < 0` zooms in, `deltaY > 0` zooms out).
   */
  public zoomByWheel(deltaY: number, stepFactor = 0.0015): void {
    if (!Number.isFinite(deltaY) || deltaY === 0) {
      return;
    }
    const factor = Math.exp(deltaY * stepFactor);
    this.zoomByFactor(factor);
  }

  /**
   * Updates orbit angles, zoom, and `C` view-preset switching from `InputManager` (`viewer` context).
   * Opposing keys cancel cleanly and non-`viewer` contexts do not move the orbit camera.
   */
  public updateFromInput(input: InputManager, dtSeconds: number): void {
    if (input.getContext() !== 'viewer') {
      this.prevCameraNextActive = false;
      return;
    }

    const dt = Number.isFinite(dtSeconds) && dtSeconds > 0 ? dtSeconds : 0;
    const axes = input.getAxes();

    if (dt > 0) {
      if (axes.moveX !== 0 || axes.moveY !== 0) {
        this.orbitBy(
          axes.moveX * this.yawSpeedRadPerSec * dt,
          axes.moveY * this.pitchSpeedRadPerSec * dt,
        );
      }
      if (axes.zoom !== 0) {
        this.zoomByFactor(Math.exp(-axes.zoom * this.zoomSpeedPerSec * dt));
      }
    }

    const cameraNextActive = input.isActionActive('cameraNext');
    if (cameraNextActive && !this.prevCameraNextActive) {
      this.nextPreset();
    }
    this.prevCameraNextActive = cameraNextActive;
  }

  public getEyePosition(): Vec3 {
    const cosPitch = Math.cos(this.pitch);
    const sinPitch = Math.sin(this.pitch);
    const sinYaw = Math.sin(this.yaw);
    const cosYaw = Math.cos(this.yaw);

    return [
      this.target[0] + this.distance * cosPitch * sinYaw,
      this.target[1] + this.distance * sinPitch,
      this.target[2] + this.distance * cosPitch * cosYaw,
    ];
  }

  public getViewMatrix(): Mat4 {
    return mat4LookAt(this.getEyePosition(), this.target, [0, 1, 0]);
  }

  public getProjectionMatrix(): Mat4 {
    return mat4Perspective(this.fovYRad, this.aspect, this.near, this.far);
  }

  public getViewProjectionMatrix(): Mat4 {
    return mat4Multiply(this.getProjectionMatrix(), this.getViewMatrix());
  }

  public getState(): OrbitCameraState {
    return {
      target: this.target,
      yaw: this.yaw,
      pitch: this.pitch,
      distance: this.distance,
      fovYRad: this.fovYRad,
      aspect: this.aspect,
      near: this.near,
      far: this.far,
      presetIndex: this.presetIndex,
    };
  }
}
