import {
  type GamepadConfig,
  type GamepadProvider,
  type InputManager,
  type InputSmoothingConfig,
  computeMaxSteeringForSpeed,
  defaultGamepadProvider,
  pollGamepadDriveState,
} from '../core/input';
import { clamp } from './math';
import type { VehicleControls } from './types';

export interface DriveEdgeEvents {
  readonly shiftUp: boolean;
  readonly shiftDown: boolean;
  readonly resetCar: boolean;
  readonly cameraNext: boolean;
  readonly pause: boolean;
  readonly mute: boolean;
}

export interface DriveControlFrame {
  readonly controls: VehicleControls;
  readonly edges: DriveEdgeEvents;
  readonly gamepadConnected: boolean;
}

export interface DriveControlAdapterOptions {
  readonly inputManager: InputManager;
  readonly gamepadProvider?: GamepadProvider;
  readonly gamepadConfig?: GamepadConfig;
  readonly smoothing?: InputSmoothingConfig;
}

export const EMPTY_DRIVE_EDGES: DriveEdgeEvents = Object.freeze({
  shiftUp: false,
  shiftDown: false,
  resetCar: false,
  cameraNext: false,
  pause: false,
  mute: false,
});

export const NEUTRAL_VEHICLE_CONTROLS: VehicleControls = Object.freeze({
  throttle: 0,
  brake: 0,
  handbrake: 0,
  steer: 0,
  shiftUp: false,
  shiftDown: false,
});

/**
 * Pure TypeScript adapter bridging `InputManager` (`race` context, simultaneous WSAD + Arrows
 * via `KeyboardEvent.code`, centralized smoothing & speed-sensitive steering) and optional
 * Gamepad API polling into `VehicleControls` + rising-edge race events (`M9.7`).
 *
 * Sign convention:
 * - `InputManager` & Gamepad horizontal axis use `-1` = left, `+1` = right.
 * - `VehicleControls.steer` uses `+1` = left (`+Y` CCW yaw), `-1` = right.
 */
export class DriveControlAdapter {
  private readonly inputManager: InputManager;
  private readonly gamepadProvider: GamepadProvider;
  private readonly gamepadConfig: GamepadConfig | undefined;
  private readonly smoothing: InputSmoothingConfig;

  private prevGearUp = false;
  private prevGearDown = false;
  private prevResetCar = false;
  private prevCameraNext = false;
  private prevPause = false;
  private prevMute = false;

  public constructor(options: DriveControlAdapterOptions) {
    this.inputManager = options.inputManager;
    this.gamepadProvider = options.gamepadProvider ?? defaultGamepadProvider;
    this.gamepadConfig = options.gamepadConfig;
    this.smoothing = options.smoothing ?? options.inputManager.getSmoothingConfig();
  }

  /**
   * Clears latched rising-edge states so held keys cannot re-trigger on resume or tab switch.
   */
  public resetLatches(): void {
    this.prevGearUp = false;
    this.prevGearDown = false;
    this.prevResetCar = false;
    this.prevCameraNext = false;
    this.prevPause = false;
    this.prevMute = false;
  }

  /**
   * Advances keyboard analog smoothing by `dtSeconds` at vehicle `speedMps`, polls optional
   * gamepad state, and outputs `VehicleControls` plus edge-triggered actions.
   */
  public step(dtSeconds: number, speedMps: number): DriveControlFrame {
    if (this.inputManager.getContext() !== 'race') {
      this.resetLatches();
      return {
        controls: NEUTRAL_VEHICLE_CONTROLS,
        edges: EMPTY_DRIVE_EDGES,
        gamepadConnected: false,
      };
    }

    const safeDt = Number.isFinite(dtSeconds) && dtSeconds > 0 ? dtSeconds : 0;
    const safeSpeedMps = Number.isFinite(speedMps) ? Math.max(0, speedMps) : 0;

    const axes = this.inputManager.update(safeDt, safeSpeedMps);
    const gp = pollGamepadDriveState(this.gamepadProvider, this.gamepadConfig);

    const maxSteer = computeMaxSteeringForSpeed(safeSpeedMps, this.smoothing);
    const gpSteer = clamp(gp.steer, -1, 1) * maxSteer;
    const combinedScreenSteer = clamp(axes.steering + gpSteer, -maxSteer, maxSteer);
    // Invert screen/input convention (-1 left, +1 right) to physics +Y CCW (+1 left, -1 right).
    const physicsSteer = combinedScreenSteer === 0 ? 0 : -combinedScreenSteer;

    const throttle = clamp(Math.max(axes.throttle, gp.throttle), 0, 1);
    const brake = clamp(Math.max(axes.brake, gp.brake), 0, 1);
    const kbHandbrake = this.inputManager.isActionActive('handbrake') ? 1 : 0;
    const handbrake = clamp(Math.max(kbHandbrake, gp.handbrake), 0, 1);

    const rawGearUp = this.inputManager.isActionActive('gearUp') || gp.gearUp;
    const rawGearDown = this.inputManager.isActionActive('gearDown') || gp.gearDown;
    const rawResetCar = this.inputManager.isActionActive('resetCar') || gp.resetCar;
    const rawCameraNext = this.inputManager.isActionActive('cameraNext') || gp.cameraNext;
    const rawPause = this.inputManager.isActionActive('pause') || gp.pause;
    const rawMute = this.inputManager.isActionActive('mute') || gp.mute;

    const shiftUp = rawGearUp && !this.prevGearUp;
    const shiftDown = rawGearDown && !this.prevGearDown;
    const resetCar = rawResetCar && !this.prevResetCar;
    const cameraNext = rawCameraNext && !this.prevCameraNext;
    const pause = rawPause && !this.prevPause;
    const mute = rawMute && !this.prevMute;

    this.prevGearUp = rawGearUp;
    this.prevGearDown = rawGearDown;
    this.prevResetCar = rawResetCar;
    this.prevCameraNext = rawCameraNext;
    this.prevPause = rawPause;
    this.prevMute = rawMute;

    return {
      controls: {
        throttle,
        brake,
        handbrake,
        steer: physicsSteer,
        shiftUp,
        shiftDown,
      },
      edges: {
        shiftUp,
        shiftDown,
        resetCar,
        cameraNext,
        pause,
        mute,
      },
      gamepadConnected: gp.connected,
    };
  }
}
