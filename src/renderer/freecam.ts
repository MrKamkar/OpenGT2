import type { InputManager } from '../core/input';
import {
  COLLISION_SURFACE_GROUND,
  type TrackModel,
  type TrackSegmentInfo,
  type Vec3 as TrackVec3,
} from '../formats/track';
import {
  type Mat4,
  type Vec3,
  mat4LookAt,
  mat4Multiply,
  mat4Perspective,
  vec3Add,
  vec3Cross,
  vec3Normalize,
} from './math';

export const DEFAULT_FREECAM_SPEED_MPS = 40;
export const DEFAULT_FREECAM_MIN_SPEED_MPS = 2;
export const DEFAULT_FREECAM_MAX_SPEED_MPS = 400;
export const DEFAULT_FREECAM_BOOST_MULTIPLIER = 3.0;
export const DEFAULT_FREECAM_FOV_Y_RAD = (55 * Math.PI) / 180;
export const DEFAULT_FREECAM_ASPECT = 4 / 3;
export const DEFAULT_FREECAM_NEAR = 0.25;
export const DEFAULT_FREECAM_FAR = 4000;
export const DEFAULT_FREECAM_START_HEIGHT_METERS = 4.0;
export const DEFAULT_FREECAM_START_PITCH_RAD = -0.12;

const MIN_PITCH_RAD = -Math.PI * 0.5 + 0.02;
const MAX_PITCH_RAD = Math.PI * 0.5 - 0.02;

export interface FreeCameraOptions {
  readonly position?: Vec3;
  readonly yaw?: number;
  readonly pitch?: number;
  readonly moveSpeedMps?: number;
  readonly minSpeedMps?: number;
  readonly maxSpeedMps?: number;
  readonly boostMultiplier?: number;
  readonly fovYRad?: number;
  readonly aspect?: number;
  readonly near?: number;
  readonly far?: number;
}

export interface FreeCameraState {
  readonly position: Vec3;
  readonly yaw: number;
  readonly pitch: number;
  readonly moveSpeedMps: number;
  readonly boostMultiplier: number;
  readonly fovYRad: number;
  readonly aspect: number;
  readonly near: number;
  readonly far: number;
}

export interface FreeCameraUpdateResult {
  readonly moved: boolean;
  readonly resetTriggered: boolean;
}

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

function directionToYawPitch(dir: TrackVec3): { readonly yaw: number; readonly pitch: number } {
  const len = Math.hypot(dir.x, dir.y, dir.z);
  if (len <= 1e-8 || !Number.isFinite(len)) {
    return { yaw: 0, pitch: 0 };
  }
  const nx = dir.x / len;
  const ny = clamp(dir.y / len, -1, 1);
  const nz = dir.z / len;
  // Forward convention: [-sin(yaw)*cos(pitch), sin(pitch), -cos(yaw)*cos(pitch)]
  const yaw = wrapAngle(Math.atan2(-nx, -nz));
  const pitch = clamp(Math.asin(ny), MIN_PITCH_RAD, MAX_PITCH_RAD);
  return { yaw, pitch };
}

function computeSegmentGroundCentroid(
  track: TrackModel,
  segment: TrackSegmentInfo,
): { readonly x: number; readonly y: number; readonly z: number } {
  if (track.collision !== undefined) {
    const colSeg = track.collision.segments[segment.segmentIndex];
    if (colSeg !== undefined && colSeg.triangleCount > 0) {
      let sumX = 0;
      let sumY = 0;
      let sumZ = 0;
      let count = 0;
      const endTri = colSeg.triangleStart + colSeg.triangleCount;
      for (let ti = colSeg.triangleStart; ti < endTri; ti += 1) {
        if (track.collision.surfaceTypes[ti] !== COLLISION_SURFACE_GROUND) {
          continue;
        }
        const base = ti * 9;
        const cx =
          ((track.collision.vertices[base] ?? 0) +
            (track.collision.vertices[base + 3] ?? 0) +
            (track.collision.vertices[base + 6] ?? 0)) /
          3;
        const cy =
          ((track.collision.vertices[base + 1] ?? 0) +
            (track.collision.vertices[base + 4] ?? 0) +
            (track.collision.vertices[base + 7] ?? 0)) /
          3;
        const cz =
          ((track.collision.vertices[base + 2] ?? 0) +
            (track.collision.vertices[base + 5] ?? 0) +
            (track.collision.vertices[base + 8] ?? 0)) /
          3;
        sumX += cx;
        sumY += cy;
        sumZ += cz;
        count += 1;
      }
      if (count > 0) {
        return { x: sumX / count, y: sumY / count, z: sumZ / count };
      }
    }
  }

  // Fallback: average horizontal vertex positions of the segment's primary render parts.
  let sumX = 0;
  let sumZ = 0;
  let vertCount = 0;
  const partEnd = segment.primaryPartStart + segment.primaryPartCount;
  for (let pi = segment.primaryPartStart; pi < partEnd; pi += 1) {
    const part = track.render[pi];
    if (part === undefined) {
      continue;
    }
    for (let vi = 0; vi < part.vertexCount; vi += 1) {
      const base = vi * 3;
      sumX += part.positions[base] ?? 0;
      sumZ += part.positions[base + 2] ?? 0;
      vertCount += 1;
    }
  }
  if (vertCount > 0) {
    return {
      x: sumX / vertCount,
      y: segment.bounds.min.y,
      z: sumZ / vertCount,
    };
  }

  return {
    x: (segment.bounds.min.x + segment.bounds.max.x) * 0.5,
    y: segment.bounds.min.y,
    z: (segment.bounds.min.z + segment.bounds.max.z) * 0.5,
  };
}

function findNonEmptySegment(track: TrackModel, preferredIndex = 0): TrackSegmentInfo | null {
  const preferred = track.segments[preferredIndex];
  if (preferred !== undefined && preferred.primaryPartCount > 0) {
    return preferred;
  }
  for (const seg of track.segments) {
    if (seg.primaryPartCount > 0) {
      return seg;
    }
  }
  return preferred ?? null;
}

/**
 * Pure 3D free-fly camera decoupled from DOM/WebGL and integrated with `InputManager`
 * (`freecam` context: simultaneous WSAD + Arrow movement via `KeyboardEvent.code`,
 * `Q`/`E` down/up, `Shift` speed boost, edge-triggered `KeyR` start teleport) (`M8.6`).
 */
export class FreeCamera {
  private position: Vec3;
  private yaw: number;
  private pitch: number;
  private moveSpeedMps: number;
  private readonly minSpeedMps: number;
  private readonly maxSpeedMps: number;
  private readonly boostMultiplier: number;
  private fovYRad: number;
  private aspect: number;
  private near: number;
  private far: number;

  private defaultPosition: Vec3;
  private defaultYaw: number;
  private defaultPitch: number;
  private prevResetActive = false;

  public constructor(options: FreeCameraOptions = {}) {
    this.minSpeedMps = Math.max(0.1, options.minSpeedMps ?? DEFAULT_FREECAM_MIN_SPEED_MPS);
    this.maxSpeedMps = Math.max(this.minSpeedMps, options.maxSpeedMps ?? DEFAULT_FREECAM_MAX_SPEED_MPS);
    this.moveSpeedMps = clamp(
      options.moveSpeedMps ?? DEFAULT_FREECAM_SPEED_MPS,
      this.minSpeedMps,
      this.maxSpeedMps,
    );
    this.boostMultiplier = Math.max(1, options.boostMultiplier ?? DEFAULT_FREECAM_BOOST_MULTIPLIER);
    this.position = options.position !== undefined ? [...options.position] : [0, 4, 0];
    this.yaw = wrapAngle(options.yaw ?? 0);
    this.pitch = clamp(options.pitch ?? 0, MIN_PITCH_RAD, MAX_PITCH_RAD);
    this.fovYRad = options.fovYRad ?? DEFAULT_FREECAM_FOV_Y_RAD;
    this.aspect = options.aspect ?? DEFAULT_FREECAM_ASPECT;
    this.near = options.near ?? DEFAULT_FREECAM_NEAR;
    this.far = options.far ?? DEFAULT_FREECAM_FAR;

    this.defaultPosition = this.position;
    this.defaultYaw = this.yaw;
    this.defaultPitch = this.pitch;
  }

  public setAspect(aspect: number): void {
    if (Number.isFinite(aspect) && aspect > 0) {
      this.aspect = aspect;
    }
  }

  public setPose(position: Vec3, yaw: number, pitch: number): void {
    if (
      Number.isFinite(position[0]) &&
      Number.isFinite(position[1]) &&
      Number.isFinite(position[2])
    ) {
      this.position = [position[0], position[1], position[2]];
    }
    if (Number.isFinite(yaw)) {
      this.yaw = wrapAngle(yaw);
    }
    if (Number.isFinite(pitch)) {
      this.pitch = clamp(pitch, MIN_PITCH_RAD, MAX_PITCH_RAD);
    }
  }

  public setSpeed(speedMps: number): void {
    if (Number.isFinite(speedMps)) {
      this.moveSpeedMps = clamp(speedMps, this.minSpeedMps, this.maxSpeedMps);
    }
  }

  /**
   * Adjusts fly speed exponentially on mouse wheel (`deltaY < 0` speeds up, `deltaY > 0` slows down).
   */
  public adjustSpeedByWheel(deltaY: number, stepFactor = 0.0012): void {
    if (!Number.isFinite(deltaY) || deltaY === 0) {
      return;
    }
    const factor = Math.exp(-deltaY * stepFactor);
    this.moveSpeedMps = clamp(this.moveSpeedMps * factor, this.minSpeedMps, this.maxSpeedMps);
  }

  public lookBy(deltaYawRad: number, deltaPitchRad: number): void {
    if (Number.isFinite(deltaYawRad)) {
      this.yaw = wrapAngle(this.yaw + deltaYawRad);
    }
    if (Number.isFinite(deltaPitchRad)) {
      this.pitch = clamp(this.pitch + deltaPitchRad, MIN_PITCH_RAD, MAX_PITCH_RAD);
    }
  }

  /**
   * Pointer/touch drag look helper scaled relative to viewport height.
   */
  public lookByPixels(
    deltaX: number,
    deltaY: number,
    viewportHeight: number,
    sensitivity = Math.PI * 0.85,
  ): void {
    const height = Math.max(1, viewportHeight);
    const scale = sensitivity / height;
    this.lookBy(-deltaX * scale, -deltaY * scale);
  }

  public getForwardVector(): Vec3 {
    const cosPitch = Math.cos(this.pitch);
    return [
      -Math.sin(this.yaw) * cosPitch,
      Math.sin(this.pitch),
      -Math.cos(this.yaw) * cosPitch,
    ];
  }

  public getRightVector(): Vec3 {
    return [Math.cos(this.yaw), 0, -Math.sin(this.yaw)];
  }

  public getUpVector(): Vec3 {
    return vec3Normalize(vec3Cross(this.getRightVector(), this.getForwardVector()));
  }

  /**
   * Teleports camera to `track.startGrid[0]` if available, or deterministically above
   * the ground centroid of the first renderable segment aiming toward the next segment.
   * Stores the resulting pose as the `reset()` baseline.
   */
  public teleportToStart(track: TrackModel): void {
    const gridPose = track.startGrid[0];
    if (gridPose !== undefined) {
      const angles = directionToYawPitch(gridPose.forward);
      this.setPose(
        [gridPose.position.x, gridPose.position.y + 2.0, gridPose.position.z],
        angles.yaw,
        clamp(angles.pitch - 0.08, MIN_PITCH_RAD, MAX_PITCH_RAD),
      );
      this.defaultPosition = this.position;
      this.defaultYaw = this.yaw;
      this.defaultPitch = this.pitch;
      return;
    }

    const startSeg = findNonEmptySegment(track, 0);
    if (startSeg === null) {
      const cx = (track.bounds.min.x + track.bounds.max.x) * 0.5;
      const cy = track.bounds.min.y + DEFAULT_FREECAM_START_HEIGHT_METERS;
      const cz = (track.bounds.min.z + track.bounds.max.z) * 0.5;
      this.setPose([cx, cy, cz], 0, DEFAULT_FREECAM_START_PITCH_RAD);
      this.defaultPosition = this.position;
      this.defaultYaw = this.yaw;
      this.defaultPitch = this.pitch;
      return;
    }

    const startCentroid = computeSegmentGroundCentroid(track, startSeg);
    let nextSeg = track.segments[startSeg.nextSegment];
    if (
      nextSeg === undefined ||
      nextSeg.segmentIndex === startSeg.segmentIndex ||
      nextSeg.primaryPartCount === 0
    ) {
      const fallbackIdx =
        track.segments.length > 1 ? (startSeg.segmentIndex + 1) % track.segments.length : 0;
      nextSeg = findNonEmptySegment(track, fallbackIdx) ?? startSeg;
    }

    let aimX = 0;
    let aimZ = -1;
    if (nextSeg.segmentIndex !== startSeg.segmentIndex) {
      const nextCentroid = computeSegmentGroundCentroid(track, nextSeg);
      const dx = nextCentroid.x - startCentroid.x;
      const dz = nextCentroid.z - startCentroid.z;
      const horizLen = Math.hypot(dx, dz);
      if (horizLen > 1e-4) {
        aimX = dx / horizLen;
        aimZ = dz / horizLen;
      }
    }

    const { yaw } = directionToYawPitch({ x: aimX, y: 0, z: aimZ });
    const startPos: Vec3 = [
      startCentroid.x,
      startCentroid.y + DEFAULT_FREECAM_START_HEIGHT_METERS,
      startCentroid.z,
    ];

    this.setPose(startPos, yaw, DEFAULT_FREECAM_START_PITCH_RAD);
    this.defaultPosition = this.position;
    this.defaultYaw = this.yaw;
    this.defaultPitch = this.pitch;
  }

  public reset(): void {
    this.position = [...this.defaultPosition];
    this.yaw = this.defaultYaw;
    this.pitch = this.defaultPitch;
  }

  /**
   * Advances camera movement and handles edge-triggered `freecamReset` (`KeyR`)
   * from `InputManager` when active context is `'freecam'`.
   */
  public updateFromInput(input: InputManager, dtSeconds: number): FreeCameraUpdateResult {
    if (input.getContext() !== 'freecam') {
      this.prevResetActive = false;
      return { moved: false, resetTriggered: false };
    }

    const resetActive = input.isActionActive('freecamReset');
    let resetTriggered = false;
    if (resetActive && !this.prevResetActive) {
      this.reset();
      resetTriggered = true;
    }
    this.prevResetActive = resetActive;

    const dt = Number.isFinite(dtSeconds) && dtSeconds > 0 ? dtSeconds : 0;
    if (dt === 0) {
      return { moved: false, resetTriggered };
    }

    const axes = input.getAxes();
    if (axes.moveX === 0 && axes.moveY === 0 && axes.moveZ === 0) {
      return { moved: false, resetTriggered };
    }

    const forward = this.getForwardVector();
    const right = this.getRightVector();
    let dx = forward[0] * axes.moveY + right[0] * axes.moveX;
    let dy = forward[1] * axes.moveY + axes.moveZ;
    let dz = forward[2] * axes.moveY + right[2] * axes.moveX;

    const len = Math.hypot(dx, dy, dz);
    if (len <= 1e-8) {
      return { moved: false, resetTriggered };
    }
    if (len > 1) {
      dx /= len;
      dy /= len;
      dz /= len;
    }

    const boost = input.isActionActive('freecamBoost') ? this.boostMultiplier : 1;
    const distance = this.moveSpeedMps * boost * dt;
    this.position = [
      this.position[0] + dx * distance,
      this.position[1] + dy * distance,
      this.position[2] + dz * distance,
    ];
    return { moved: true, resetTriggered };
  }

  public getViewMatrix(): Mat4 {
    const target = vec3Add(this.position, this.getForwardVector());
    return mat4LookAt(this.position, target, [0, 1, 0]);
  }

  public getProjectionMatrix(): Mat4 {
    return mat4Perspective(this.fovYRad, this.aspect, this.near, this.far);
  }

  public getViewProjectionMatrix(): Mat4 {
    return mat4Multiply(this.getProjectionMatrix(), this.getViewMatrix());
  }

  public getState(): FreeCameraState {
    return {
      position: [...this.position],
      yaw: this.yaw,
      pitch: this.pitch,
      moveSpeedMps: this.moveSpeedMps,
      boostMultiplier: this.boostMultiplier,
      fovYRad: this.fovYRad,
      aspect: this.aspect,
      near: this.near,
      far: this.far,
    };
  }
}
