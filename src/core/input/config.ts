import type {
  BindingConflict,
  InputAction,
  InputBindings,
  InputContext,
  InputSmoothingConfig,
} from './types';

export const INPUT_CONTEXTS: readonly InputContext[] = ['menu', 'viewer', 'freecam', 'race'];

/**
 * Browser-shortcut modifier codes forbidden in any action binding (ROADMAP §1.6).
 */
export const FORBIDDEN_MODIFIER_CODES: ReadonlySet<string> = new Set([
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'MetaLeft',
  'MetaRight',
]);

/**
 * Keys whose default browser scroll/activation action must be prevented ONLY
 * while focus is on the game canvas (ROADMAP §1.6).
 */
export const CANVAS_PREVENT_DEFAULT_CODES: ReadonlySet<string> = new Set([
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Space',
]);

/**
 * Opposing action pairs that cancel each other to zero when held together
 * (ROADMAP §1.6: left+right, throttle+brake, etc.).
 */
export const OPPOSING_ACTION_PAIRS: Readonly<
  Record<InputContext, readonly (readonly [InputAction, InputAction])[]>
> = {
  menu: [
    ['menuLeft', 'menuRight'],
    ['menuUp', 'menuDown'],
  ],
  viewer: [
    ['orbitLeft', 'orbitRight'],
    ['orbitUp', 'orbitDown'],
    ['zoomIn', 'zoomOut'],
  ],
  freecam: [
    ['moveLeft', 'moveRight'],
    ['moveForward', 'moveBackward'],
    ['moveUp', 'moveDown'],
  ],
  race: [
    ['steerLeft', 'steerRight'],
    ['throttle', 'brake'],
  ],
};

/**
 * Default keyboard bindings per input context (ROADMAP §1.6).
 * Uses KeyboardEvent.code exclusively so WSAD and arrows work identically
 * across QWERTY/QWERTZ/AZERTY layouts and regardless of Caps Lock.
 */
export const DEFAULT_INPUT_BINDINGS: InputBindings = {
  menu: {
    menuUp: ['KeyW', 'ArrowUp'],
    menuDown: ['KeyS', 'ArrowDown'],
    menuLeft: ['KeyA', 'ArrowLeft'],
    menuRight: ['KeyD', 'ArrowRight'],
    menuConfirm: ['Enter', 'Space'],
    menuBack: ['Escape', 'Backspace'],
    mute: ['KeyM'],
  },
  viewer: {
    orbitLeft: ['KeyA', 'ArrowLeft'],
    orbitRight: ['KeyD', 'ArrowRight'],
    orbitUp: ['KeyW', 'ArrowUp'],
    orbitDown: ['KeyS', 'ArrowDown'],
    zoomIn: ['Equal', 'NumpadAdd'],
    zoomOut: ['Minus', 'NumpadSubtract'],
    cameraNext: ['KeyC'],
    mute: ['KeyM'],
  },
  freecam: {
    moveForward: ['KeyW', 'ArrowUp'],
    moveBackward: ['KeyS', 'ArrowDown'],
    moveLeft: ['KeyA', 'ArrowLeft'],
    moveRight: ['KeyD', 'ArrowRight'],
    moveDown: ['KeyQ'],
    moveUp: ['KeyE'],
    freecamBoost: ['ShiftLeft', 'ShiftRight'],
    freecamReset: ['KeyR'],
    mute: ['KeyM'],
  },
  race: {
    throttle: ['KeyW', 'ArrowUp'],
    brake: ['KeyS', 'ArrowDown'],
    steerLeft: ['KeyA', 'ArrowLeft'],
    steerRight: ['KeyD', 'ArrowRight'],
    handbrake: ['Space'],
    gearUp: ['KeyE'],
    gearDown: ['KeyQ'],
    cameraNext: ['KeyC'],
    resetCar: ['KeyR'],
    pause: ['Escape', 'KeyP'],
    mute: ['KeyM'],
  },
};

/**
 * Default analog smoothing parameters for digital keyboard input (ROADMAP §1.6).
 * Centralized in configuration rather than hardcoded in physics.
 */
export const DEFAULT_INPUT_SMOOTHING: InputSmoothingConfig = Object.freeze({
  // Reaches full steering lock in ~0.22 s, centers in ~0.16 s.
  steeringRiseRate: 4.5,
  steeringReturnRate: 6.0,
  // Smooth ramp for throttle/brake to emulate analog pedal travel.
  throttleRiseRate: 5.0,
  throttleReturnRate: 8.0,
  brakeRiseRate: 6.0,
  brakeReturnRate: 8.0,
  // At 60 m/s (~216 km/h), max steering angle reduces linearly to 35%.
  speedSensitivityMinScale: 0.35,
  speedSensitivityReferenceSpeedMps: 60,
});

export class ForbiddenModifierBindingError extends Error {
  public readonly context: InputContext;
  public readonly action: InputAction;
  public readonly code: string;

  public constructor(context: InputContext, action: InputAction, code: string) {
    super(
      `Forbidden modifier code "${code}" cannot be bound to action "${action}" in context "${context}".`,
    );
    this.name = 'ForbiddenModifierBindingError';
    this.context = context;
    this.action = action;
    this.code = code;
  }
}

export function isForbiddenModifierCode(code: string): boolean {
  return FORBIDDEN_MODIFIER_CODES.has(code);
}

/**
 * Validates bindings across all contexts:
 * - Throws ForbiddenModifierBindingError if Ctrl/Alt/Meta codes are bound.
 * - Returns same-context binding conflicts (multiple actions sharing one code).
 */
export function validateBindings(bindings: InputBindings): readonly BindingConflict[] {
  const conflicts: BindingConflict[] = [];

  for (const context of INPUT_CONTEXTS) {
    const contextMap = bindings[context];
    const codeToActions = new Map<string, InputAction[]>();

    for (const [rawAction, codes] of Object.entries(contextMap)) {
      if (codes === undefined) {
        continue;
      }
      const action = rawAction as InputAction;
      for (const code of codes) {
        if (isForbiddenModifierCode(code)) {
          throw new ForbiddenModifierBindingError(context, action, code);
        }
        const existing = codeToActions.get(code);
        if (existing === undefined) {
          codeToActions.set(code, [action]);
        } else if (!existing.includes(action)) {
          existing.push(action);
        }
      }
    }

    for (const [code, actions] of codeToActions.entries()) {
      if (actions.length > 1) {
        conflicts.push({
          context,
          code,
          actions: Object.freeze([...actions]),
        });
      }
    }
  }

  return conflicts;
}
