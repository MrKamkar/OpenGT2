import {
  CANVAS_PREVENT_DEFAULT_CODES,
  DEFAULT_INPUT_BINDINGS,
  DEFAULT_INPUT_SMOOTHING,
  OPPOSING_ACTION_PAIRS,
  isForbiddenModifierCode,
  validateBindings,
} from './config';
import type {
  AnalogAxes,
  BindingConflict,
  InputAction,
  InputBindings,
  InputContext,
  InputSmoothingConfig,
  InputSnapshot,
  KeyInputEvent,
} from './types';

const ZERO_EPSILON = 1e-6;

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

function snapNearZero(value: number): number {
  return Math.abs(value) < ZERO_EPSILON ? 0 : value;
}

/**
 * Computes maximum allowed steering magnitude in [minScale, 1] for a given
 * speed (m/s). Higher speed reduces max steering angle (ROADMAP §1.6).
 */
export function computeMaxSteeringForSpeed(
  speedMps: number,
  smoothing: InputSmoothingConfig = DEFAULT_INPUT_SMOOTHING,
): number {
  const safeSpeed = Number.isFinite(speedMps) ? Math.max(0, speedMps) : 0;
  const reference = Math.max(ZERO_EPSILON, smoothing.speedSensitivityReferenceSpeedMps);
  const minScale = clamp(smoothing.speedSensitivityMinScale, 0, 1);
  const ratio = clamp(safeSpeed / reference, 0, 1);
  return minScale + (1 - minScale) * Math.pow(1 - ratio, 1.6);
}

function approachUnipolar(
  current: number,
  target: number,
  dtSeconds: number,
  riseRate: number,
  returnRate: number,
): number {
  if (dtSeconds <= 0) {
    return clamp(current, 0, 1);
  }
  const clampedTarget = clamp(target, 0, 1);
  if (clampedTarget > current) {
    return Math.min(clampedTarget, current + riseRate * dtSeconds);
  }
  if (clampedTarget < current) {
    return snapNearZero(Math.max(clampedTarget, current - returnRate * dtSeconds));
  }
  return current;
}

function approachBipolar(
  current: number,
  target: number,
  dtSeconds: number,
  riseRate: number,
  returnRate: number,
  maxMagnitude: number,
): number {
  const limit = clamp(maxMagnitude, 0, 1);
  const clampedTarget = clamp(target, -limit, limit);

  if (dtSeconds <= 0) {
    return snapNearZero(clamp(current, -limit, limit));
  }

  // Returning to center (no input or opposing directions cancelled).
  if (clampedTarget === 0) {
    if (current > 0) {
      return snapNearZero(Math.max(0, current - returnRate * dtSeconds));
    }
    if (current < 0) {
      return snapNearZero(Math.min(0, current + returnRate * dtSeconds));
    }
    return 0;
  }

  // Crossing through zero when steering direction reverses: return to 0 at
  // returnRate, then apply remaining dt toward the new direction at riseRate.
  if (current !== 0 && Math.sign(current) !== Math.sign(clampedTarget)) {
    const distanceToZero = Math.abs(current);
    const timeToZero = returnRate > 0 ? distanceToZero / returnRate : 0;
    if (dtSeconds <= timeToZero) {
      const step = returnRate * dtSeconds;
      const next = current > 0 ? current - step : current + step;
      return snapNearZero(clamp(next, -limit, limit));
    }
    const remainingDt = dtSeconds - timeToZero;
    const risen = Math.sign(clampedTarget) * Math.min(Math.abs(clampedTarget), riseRate * remainingDt);
    return snapNearZero(clamp(risen, -limit, limit));
  }

  // Moving in the same direction (or starting from 0).
  const targetAbs = Math.abs(clampedTarget);
  const currentAbs = Math.abs(current);
  const sign = Math.sign(clampedTarget);

  if (currentAbs < targetAbs) {
    const nextAbs = Math.min(targetAbs, currentAbs + riseRate * dtSeconds);
    return snapNearZero(sign * nextAbs);
  }

  // Speed increased and shrank maxSteering below current magnitude: pull down smoothly/clamp.
  const nextAbs = Math.max(targetAbs, currentAbs - returnRate * dtSeconds);
  return snapNearZero(sign * Math.min(limit, nextAbs));
}

export interface InputManagerOptions {
  readonly initialContext?: InputContext;
  readonly bindings?: InputBindings;
  readonly smoothing?: InputSmoothingConfig;
}

export class InputManager {
  private context: InputContext;
  private bindings: InputBindings;
  private readonly smoothing: InputSmoothingConfig;
  private readonly pressedCodes = new Set<string>();
  private steeringValue = 0;
  private throttleValue = 0;
  private brakeValue = 0;

  public constructor(options: InputManagerOptions = {}) {
    this.context = options.initialContext ?? 'menu';
    this.bindings = options.bindings ?? DEFAULT_INPUT_BINDINGS;
    this.smoothing = options.smoothing ?? DEFAULT_INPUT_SMOOTHING;
    validateBindings(this.bindings);
  }

  public getContext(): InputContext {
    return this.context;
  }

  public setContext(nextContext: InputContext): void {
    if (this.context === nextContext) {
      return;
    }
    this.context = nextContext;
    if (nextContext !== 'race') {
      this.steeringValue = 0;
      this.throttleValue = 0;
      this.brakeValue = 0;
    }
  }

  public getBindings(): InputBindings {
    return this.bindings;
  }

  public setBindings(nextBindings: InputBindings): readonly BindingConflict[] {
    const conflicts = validateBindings(nextBindings);
    this.bindings = nextBindings;
    return conflicts;
  }

  public detectConflicts(): readonly BindingConflict[] {
    return validateBindings(this.bindings);
  }

  public getSmoothingConfig(): InputSmoothingConfig {
    return this.smoothing;
  }

  /**
   * Processes a minimal keyboard event (`{ type, code, repeat }`).
   * Returns true if the event updated input state, false if ignored.
   */
  public handleKeyEvent(event: KeyInputEvent): boolean {
    if (event.repeat) {
      return false;
    }

    if (event.type === 'keyup') {
      // Always release on keyup even if a modifier is currently held so keys cannot get stuck.
      return this.pressedCodes.delete(event.code);
    }

    if (
      event.ctrlKey === true ||
      event.altKey === true ||
      event.metaKey === true ||
      isForbiddenModifierCode(event.code)
    ) {
      return false;
    }

    this.pressedCodes.add(event.code);
    return true;
  }

  /**
   * Releases all currently held keys and resets smoothed analog outputs.
   * Must be invoked on window blur, visibilitychange (hidden), and pointerlockchange.
   */
  public releaseAll(): void {
    this.pressedCodes.clear();
    this.steeringValue = 0;
    this.throttleValue = 0;
    this.brakeValue = 0;
  }

  public isCodePressed(code: string): boolean {
    return this.pressedCodes.has(code);
  }

  public getPressedCodes(): readonly string[] {
    return [...this.pressedCodes].sort();
  }

  /**
   * Whether the browser default action for this key should be prevented.
   * Per ROADMAP §1.6: only for Arrow keys & Space AND only while canvas has focus.
   */
  public shouldPreventDefault(code: string, isCanvasFocused: boolean): boolean {
    if (!isCanvasFocused) {
      return false;
    }
    return CANVAS_PREVENT_DEFAULT_CODES.has(code);
  }

  private isActionRawPressed(action: InputAction, context: InputContext = this.context): boolean {
    const codes = this.bindings[context][action];
    if (codes === undefined) {
      return false;
    }
    for (const code of codes) {
      if (this.pressedCodes.has(code)) {
        return true;
      }
    }
    return false;
  }

  private getCancelledActions(context: InputContext = this.context): ReadonlySet<InputAction> {
    const cancelled = new Set<InputAction>();
    const pairs = OPPOSING_ACTION_PAIRS[context];
    for (const [negative, positive] of pairs) {
      if (this.isActionRawPressed(negative, context) && this.isActionRawPressed(positive, context)) {
        cancelled.add(negative);
        cancelled.add(positive);
      }
    }
    return cancelled;
  }

  public isActionActive(action: InputAction): boolean {
    if (!this.isActionRawPressed(action)) {
      return false;
    }
    return !this.getCancelledActions().has(action);
  }

  public getActiveActions(): readonly InputAction[] {
    const contextBindings = this.bindings[this.context];
    const cancelled = this.getCancelledActions();
    const active: InputAction[] = [];

    for (const rawAction of Object.keys(contextBindings)) {
      const action = rawAction as InputAction;
      if (!cancelled.has(action) && this.isActionRawPressed(action)) {
        active.push(action);
      }
    }

    return active.sort();
  }

  /**
   * Advances analog axis smoothing by `dtSeconds` at optional vehicle speed `speedMps`.
   */
  public update(dtSeconds: number, speedMps = 0): AnalogAxes {
    const safeDt = Number.isFinite(dtSeconds) && dtSeconds > 0 ? dtSeconds : 0;

    if (this.context === 'race') {
      const maxSteer = computeMaxSteeringForSpeed(speedMps, this.smoothing);
      const steerTarget =
        ((this.isActionActive('steerRight') ? 1 : 0) - (this.isActionActive('steerLeft') ? 1 : 0)) *
        maxSteer;
      const throttleTarget = this.isActionActive('throttle') ? 1 : 0;
      const brakeTarget = this.isActionActive('brake') ? 1 : 0;

      this.steeringValue = approachBipolar(
        this.steeringValue,
        steerTarget,
        safeDt,
        this.smoothing.steeringRiseRate,
        this.smoothing.steeringReturnRate,
        maxSteer,
      );
      this.throttleValue = approachUnipolar(
        this.throttleValue,
        throttleTarget,
        safeDt,
        this.smoothing.throttleRiseRate,
        this.smoothing.throttleReturnRate,
      );
      this.brakeValue = approachUnipolar(
        this.brakeValue,
        brakeTarget,
        safeDt,
        this.smoothing.brakeRiseRate,
        this.smoothing.brakeReturnRate,
      );
    } else {
      this.steeringValue = 0;
      this.throttleValue = 0;
      this.brakeValue = 0;
    }

    return this.getAxes();
  }

  public getAxes(): AnalogAxes {
    let moveX = 0;
    let moveY = 0;
    let moveZ = 0;
    let zoom = 0;

    switch (this.context) {
      case 'menu': {
        moveX = (this.isActionActive('menuRight') ? 1 : 0) - (this.isActionActive('menuLeft') ? 1 : 0);
        moveY = (this.isActionActive('menuUp') ? 1 : 0) - (this.isActionActive('menuDown') ? 1 : 0);
        break;
      }
      case 'viewer': {
        moveX = (this.isActionActive('orbitRight') ? 1 : 0) - (this.isActionActive('orbitLeft') ? 1 : 0);
        moveY = (this.isActionActive('orbitUp') ? 1 : 0) - (this.isActionActive('orbitDown') ? 1 : 0);
        zoom = (this.isActionActive('zoomIn') ? 1 : 0) - (this.isActionActive('zoomOut') ? 1 : 0);
        break;
      }
      case 'freecam': {
        moveX = (this.isActionActive('moveRight') ? 1 : 0) - (this.isActionActive('moveLeft') ? 1 : 0);
        moveY =
          (this.isActionActive('moveForward') ? 1 : 0) -
          (this.isActionActive('moveBackward') ? 1 : 0);
        moveZ = (this.isActionActive('moveUp') ? 1 : 0) - (this.isActionActive('moveDown') ? 1 : 0);
        break;
      }
      case 'race': {
        moveX =
          (this.isActionActive('steerRight') ? 1 : 0) - (this.isActionActive('steerLeft') ? 1 : 0);
        moveY = (this.isActionActive('throttle') ? 1 : 0) - (this.isActionActive('brake') ? 1 : 0);
        break;
      }
    }

    return {
      steering: this.steeringValue,
      throttle: this.throttleValue,
      brake: this.brakeValue,
      moveX,
      moveY,
      moveZ,
      zoom,
    };
  }

  public getSnapshot(): InputSnapshot {
    return {
      context: this.context,
      pressedCodes: this.getPressedCodes(),
      activeActions: this.getActiveActions(),
      axes: this.getAxes(),
    };
  }
}
