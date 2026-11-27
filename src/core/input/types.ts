export type InputContext = 'menu' | 'viewer' | 'freecam' | 'race';

export type InputAction =
  | 'throttle'
  | 'brake'
  | 'steerLeft'
  | 'steerRight'
  | 'handbrake'
  | 'gearUp'
  | 'gearDown'
  | 'cameraNext'
  | 'resetCar'
  | 'pause'
  | 'mute'
  | 'menuUp'
  | 'menuDown'
  | 'menuLeft'
  | 'menuRight'
  | 'menuConfirm'
  | 'menuBack'
  | 'orbitLeft'
  | 'orbitRight'
  | 'orbitUp'
  | 'orbitDown'
  | 'zoomIn'
  | 'zoomOut'
  | 'moveForward'
  | 'moveBackward'
  | 'moveLeft'
  | 'moveRight'
  | 'moveUp'
  | 'moveDown'
  | 'freecamBoost'
  | 'freecamReset';

/**
 * Minimal keyboard event contract decoupled from the DOM so InputManager can
 * be unit-tested in Node without jsdom while accepting native KeyboardEvent.
 */
export interface KeyInputEvent {
  readonly type: 'keydown' | 'keyup';
  readonly code: string;
  readonly repeat: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly metaKey?: boolean;
}

export type ContextBindings = Partial<Record<InputAction, readonly string[]>>;

export type InputBindings = Record<InputContext, ContextBindings>;

export interface BindingConflict {
  readonly context: InputContext;
  readonly code: string;
  readonly actions: readonly InputAction[];
}

export interface InputSmoothingConfig {
  /** Rate (units/sec) at which steering ramps toward full lock. */
  readonly steeringRiseRate: number;
  /** Rate (units/sec) at which steering returns toward center on release. */
  readonly steeringReturnRate: number;
  /** Rate (units/sec) at which throttle ramps from 0 to 1. */
  readonly throttleRiseRate: number;
  /** Rate (units/sec) at which throttle returns from 1 to 0. */
  readonly throttleReturnRate: number;
  /** Rate (units/sec) at which brake ramps from 0 to 1. */
  readonly brakeRiseRate: number;
  /** Rate (units/sec) at which brake returns from 1 to 0. */
  readonly brakeReturnRate: number;
  /** Minimum fraction (0..1] of max steering angle allowed at high speed. */
  readonly speedSensitivityMinScale: number;
  /** Speed (m/s) at which steering limit reaches speedSensitivityMinScale. */
  readonly speedSensitivityReferenceSpeedMps: number;
}

export interface AnalogAxes {
  /** Smoothed race steering in [-1, 1] (negative = left, positive = right). */
  readonly steering: number;
  /** Smoothed race throttle in [0, 1]. */
  readonly throttle: number;
  /** Smoothed race brake in [0, 1]. */
  readonly brake: number;
  /** Instant opposing-cancelled horizontal axis in [-1, 1] for active context. */
  readonly moveX: number;
  /** Instant opposing-cancelled vertical/forward axis in [-1, 1] for active context. */
  readonly moveY: number;
  /** Instant opposing-cancelled elevation axis in [-1, 1] (freecam up/down). */
  readonly moveZ: number;
  /** Instant opposing-cancelled zoom axis in [-1, 1] (viewer zoom in/out). */
  readonly zoom: number;
}

export interface InputSnapshot {
  readonly context: InputContext;
  readonly pressedCodes: readonly string[];
  readonly activeActions: readonly InputAction[];
  readonly axes: AnalogAxes;
}
