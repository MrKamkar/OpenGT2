/**
 * Structural Gamepad API contracts decoupled from DOM globals so M9.7 gamepad
 * polling can be unit-tested deterministically in Node without a browser.
 */
export interface GamepadButtonLike {
  readonly pressed: boolean;
  readonly value: number;
}

export interface GamepadLike {
  readonly connected: boolean;
  readonly mapping: string;
  readonly axes: readonly number[];
  readonly buttons: readonly GamepadButtonLike[];
}

export type GamepadProvider = () => readonly (GamepadLike | null | undefined)[];

export interface GamepadConfig {
  readonly deadzone?: number;
  readonly triggerThreshold?: number;
  readonly buttonThreshold?: number;
}

export interface GamepadDriveState {
  readonly connected: boolean;
  /** Normalized steering in `[-1, 1]` (`-1` = left, `+1` = right, matching `InputManager`). */
  readonly steer: number;
  /** Analog throttle in `[0, 1]`. */
  readonly throttle: number;
  /** Analog brake in `[0, 1]`. */
  readonly brake: number;
  /** Analog/digital handbrake in `[0, 1]`. */
  readonly handbrake: number;
  readonly gearUp: boolean;
  readonly gearDown: boolean;
  readonly cameraNext: boolean;
  readonly resetCar: boolean;
  readonly pause: boolean;
  readonly mute: boolean;
}

export const DEFAULT_GAMEPAD_DEADZONE = 0.12;
export const DEFAULT_GAMEPAD_TRIGGER_THRESHOLD = 0.02;
export const DEFAULT_GAMEPAD_BUTTON_THRESHOLD = 0.5;

export const DISCONNECTED_GAMEPAD_DRIVE_STATE: GamepadDriveState = Object.freeze({
  connected: false,
  steer: 0,
  throttle: 0,
  brake: 0,
  handbrake: 0,
  gearUp: false,
  gearDown: false,
  cameraNext: false,
  resetCar: false,
  pause: false,
  mute: false,
});

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

/**
 * Rescales an analog stick axis in `[-1, 1]` outside `deadzone` smoothly to `[-1, 1]`.
 */
export function applyStickDeadzone(rawAxis: number, deadzone = DEFAULT_GAMEPAD_DEADZONE): number {
  if (!Number.isFinite(rawAxis)) {
    return 0;
  }
  const safeDeadzone = clamp(deadzone, 0, 0.95);
  const absVal = Math.abs(rawAxis);
  if (absVal <= safeDeadzone) {
    return 0;
  }
  const scaled = (absVal - safeDeadzone) / (1 - safeDeadzone);
  return Math.sign(rawAxis) * clamp(scaled, 0, 1);
}

function readButtonValue(
  buttons: readonly GamepadButtonLike[],
  index: number,
  threshold: number,
): number {
  const btn = buttons[index];
  if (btn === undefined) {
    return 0;
  }
  const val = Number.isFinite(btn.value) ? clamp(btn.value, 0, 1) : btn.pressed ? 1 : 0;
  if (val > threshold) {
    return val;
  }
  return btn.pressed ? 1 : 0;
}

function isButtonPressed(
  buttons: readonly GamepadButtonLike[],
  index: number,
  threshold: number,
): boolean {
  const btn = buttons[index];
  if (btn === undefined) {
    return false;
  }
  if (btn.pressed) {
    return true;
  }
  return Number.isFinite(btn.value) && btn.value >= threshold;
}

/**
 * Safely reads connected gamepads from `navigator.getGamepads()` when available.
 */
export function defaultGamepadProvider(): readonly (GamepadLike | null | undefined)[] {
  if (typeof navigator === 'undefined' || typeof navigator.getGamepads !== 'function') {
    return [];
  }
  try {
    return navigator.getGamepads();
  } catch {
    return [];
  }
}

/**
 * Polls the first connected gamepad (preferring `'standard'` mapping) and maps its
 * axes/buttons to race driving actions compatible with `InputManager` (`M9.7`).
 */
export function pollGamepadDriveState(
  provider: GamepadProvider = defaultGamepadProvider,
  config: GamepadConfig = {},
): GamepadDriveState {
  const pads = provider();
  let chosen: GamepadLike | null = null;

  for (const pad of pads) {
    if (pad == null || !pad.connected) {
      continue;
    }
    if (pad.mapping === 'standard') {
      chosen = pad;
      break;
    }
    if (chosen === null) {
      chosen = pad;
    }
  }

  if (chosen === null) {
    return DISCONNECTED_GAMEPAD_DRIVE_STATE;
  }

  const deadzone = config.deadzone ?? DEFAULT_GAMEPAD_DEADZONE;
  const triggerThreshold = config.triggerThreshold ?? DEFAULT_GAMEPAD_TRIGGER_THRESHOLD;
  const buttonThreshold = config.buttonThreshold ?? DEFAULT_GAMEPAD_BUTTON_THRESHOLD;

  const stickSteer = applyStickDeadzone(chosen.axes[0] ?? 0, deadzone);
  const dpadLeft = isButtonPressed(chosen.buttons, 14, buttonThreshold) ? 1 : 0;
  const dpadRight = isButtonPressed(chosen.buttons, 15, buttonThreshold) ? 1 : 0;
  const dpadSteer = dpadRight - dpadLeft;
  const steer = stickSteer !== 0 ? stickSteer : dpadSteer;

  const throttle = readButtonValue(chosen.buttons, 7, triggerThreshold);
  const brake = readButtonValue(chosen.buttons, 6, triggerThreshold);
  const handbrake = Math.max(
    readButtonValue(chosen.buttons, 0, buttonThreshold),
    readButtonValue(chosen.buttons, 2, buttonThreshold),
  );

  return {
    connected: true,
    steer: steer === 0 ? 0 : steer,
    throttle,
    brake,
    handbrake,
    gearUp: isButtonPressed(chosen.buttons, 5, buttonThreshold),
    gearDown: isButtonPressed(chosen.buttons, 4, buttonThreshold),
    cameraNext: isButtonPressed(chosen.buttons, 3, buttonThreshold),
    resetCar: isButtonPressed(chosen.buttons, 8, buttonThreshold),
    pause: isButtonPressed(chosen.buttons, 9, buttonThreshold),
    mute: isButtonPressed(chosen.buttons, 1, buttonThreshold),
  };
}
