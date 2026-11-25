import { describe, expect, it } from 'vitest';
import {
  DEFAULT_INPUT_BINDINGS,
  DEFAULT_INPUT_SMOOTHING,
  ForbiddenModifierBindingError,
  InputManager,
  attachDomInputBridge,
  computeMaxSteeringForSpeed,
  installInputDebugHook,
  isDebugMode,
  validateBindings,
  type CanvasFocusTarget,
  type DocumentInputTarget,
  type InputBindings,
  type InputDebugWindowHost,
  type KeyInputEvent,
  type PreventableKeyEvent,
  type WindowInputTarget,
} from '../../src/core/input';

function keyEvent(
  type: 'keydown' | 'keyup',
  code: string,
  extra: Partial<Omit<KeyInputEvent, 'type' | 'code'>> = {},
): KeyInputEvent {
  return {
    type,
    code,
    repeat: extra.repeat ?? false,
    ...(extra.ctrlKey !== undefined ? { ctrlKey: extra.ctrlKey } : {}),
    ...(extra.altKey !== undefined ? { altKey: extra.altKey } : {}),
    ...(extra.metaKey !== undefined ? { metaKey: extra.metaKey } : {}),
  };
}

describe('InputManager (M0.11)', () => {
  it('has zero same-context conflicts in DEFAULT_INPUT_BINDINGS', () => {
    expect(validateBindings(DEFAULT_INPUT_BINDINGS)).toEqual([]);
    const input = new InputManager();
    expect(input.detectConflicts()).toEqual([]);
  });

  it('supports WSAD and arrow keys simultaneously by KeyboardEvent.code', () => {
    const input = new InputManager({ initialContext: 'race' });

    input.handleKeyEvent(keyEvent('keydown', 'KeyW'));
    expect(input.isActionActive('throttle')).toBe(true);
    expect(input.getPressedCodes()).toEqual(['KeyW']);

    input.handleKeyEvent(keyEvent('keydown', 'ArrowUp'));
    expect(input.isActionActive('throttle')).toBe(true);
    expect(input.getPressedCodes()).toEqual(['ArrowUp', 'KeyW']);

    // Releasing W while ArrowUp is still held keeps throttle active.
    input.handleKeyEvent(keyEvent('keyup', 'KeyW'));
    expect(input.isActionActive('throttle')).toBe(true);
    expect(input.getPressedCodes()).toEqual(['ArrowUp']);

    input.handleKeyEvent(keyEvent('keyup', 'ArrowUp'));
    expect(input.isActionActive('throttle')).toBe(false);
    expect(input.getPressedCodes()).toEqual([]);
  });

  it('maps the same physical keys to distinct actions per context (menu, viewer, freecam, race)', () => {
    const input = new InputManager({ initialContext: 'menu' });

    input.handleKeyEvent(keyEvent('keydown', 'KeyW'));
    input.handleKeyEvent(keyEvent('keydown', 'Space'));
    input.handleKeyEvent(keyEvent('keydown', 'KeyM'));
    expect(input.getActiveActions()).toEqual(['menuConfirm', 'menuUp', 'mute']);

    input.setContext('viewer');
    expect(input.getActiveActions()).toEqual(['mute', 'orbitUp']);

    input.setContext('freecam');
    expect(input.getActiveActions()).toEqual(['moveForward', 'mute']);

    input.setContext('race');
    expect(input.getActiveActions()).toEqual(['handbrake', 'mute', 'throttle']);
  });

  it('ignores repeated keydown events even after releaseAll', () => {
    const input = new InputManager({ initialContext: 'race' });

    expect(input.handleKeyEvent(keyEvent('keydown', 'KeyW', { repeat: true }))).toBe(false);
    expect(input.isActionActive('throttle')).toBe(false);

    input.handleKeyEvent(keyEvent('keydown', 'KeyW'));
    expect(input.isActionActive('throttle')).toBe(true);

    input.releaseAll();
    expect(input.isActionActive('throttle')).toBe(false);

    // Repeating keydown after blur/releaseAll must NOT re-stick the key.
    expect(input.handleKeyEvent(keyEvent('keydown', 'KeyW', { repeat: true }))).toBe(false);
    expect(input.isActionActive('throttle')).toBe(false);
    expect(input.getPressedCodes()).toEqual([]);
  });

  it('cancels opposing directions to zero across all contexts', () => {
    const input = new InputManager({ initialContext: 'race' });

    // Left (KeyA) + Right (ArrowRight) cancel to 0.
    input.handleKeyEvent(keyEvent('keydown', 'KeyA'));
    input.handleKeyEvent(keyEvent('keydown', 'ArrowRight'));
    expect(input.isActionActive('steerLeft')).toBe(false);
    expect(input.isActionActive('steerRight')).toBe(false);
    expect(input.getAxes().moveX).toBe(0);

    // Releasing left immediately activates right.
    input.handleKeyEvent(keyEvent('keyup', 'KeyA'));
    expect(input.isActionActive('steerRight')).toBe(true);
    expect(input.getAxes().moveX).toBe(1);
    input.releaseAll();

    // Throttle (KeyW) + Brake (ArrowDown) cancel to 0 in race.
    input.handleKeyEvent(keyEvent('keydown', 'KeyW'));
    input.handleKeyEvent(keyEvent('keydown', 'ArrowDown'));
    expect(input.isActionActive('throttle')).toBe(false);
    expect(input.isActionActive('brake')).toBe(false);
    expect(input.getAxes().moveY).toBe(0);
    input.releaseAll();

    // Viewer zoomIn + zoomOut cancel to 0.
    input.setContext('viewer');
    input.handleKeyEvent(keyEvent('keydown', 'Equal'));
    input.handleKeyEvent(keyEvent('keydown', 'Minus'));
    expect(input.getAxes().zoom).toBe(0);
    input.releaseAll();

    // Freecam moveUp + moveDown cancel to 0.
    input.setContext('freecam');
    input.handleKeyEvent(keyEvent('keydown', 'KeyE'));
    input.handleKeyEvent(keyEvent('keydown', 'KeyQ'));
    expect(input.getAxes().moveZ).toBe(0);
  });

  it('smooths steering, throttle, and brake axes and limits max steering with speed', () => {
    const input = new InputManager({ initialContext: 'race' });

    // Ramp steering right at 0 m/s.
    input.handleKeyEvent(keyEvent('keydown', 'KeyD'));
    const step1 = input.update(0.1, 0);
    expect(step1.steering).toBeCloseTo(DEFAULT_INPUT_SMOOTHING.steeringRiseRate * 0.1, 5);
    expect(step1.steering).toBeGreaterThan(0);
    expect(step1.steering).toBeLessThan(1);

    // Reach full steering lock at 0 m/s.
    const full = input.update(1.0, 0);
    expect(full.steering).toBeCloseTo(1, 5);

    // Release and return smoothly toward center.
    input.handleKeyEvent(keyEvent('keyup', 'KeyD'));
    const returning = input.update(0.1, 0);
    expect(returning.steering).toBeCloseTo(1 - DEFAULT_INPUT_SMOOTHING.steeringReturnRate * 0.1, 5);
    const centered = input.update(1.0, 0);
    expect(centered.steering).toBe(0);

    // Speed sensitivity: high speed shrinks maximum steering angle monotonically.
    const maxAt0 = computeMaxSteeringForSpeed(0);
    const maxAt30 = computeMaxSteeringForSpeed(30);
    const maxAt60 = computeMaxSteeringForSpeed(60);
    const maxAt100 = computeMaxSteeringForSpeed(100);
    expect(maxAt0).toBe(1);
    expect(maxAt30).toBeLessThan(maxAt0);
    expect(maxAt30).toBeGreaterThan(maxAt60);
    expect(maxAt60).toBeCloseTo(DEFAULT_INPUT_SMOOTHING.speedSensitivityMinScale, 5);
    expect(maxAt100).toBeCloseTo(DEFAULT_INPUT_SMOOTHING.speedSensitivityMinScale, 5);

    input.handleKeyEvent(keyEvent('keydown', 'ArrowLeft'));
    const highSpeedSteer = input.update(1.0, 60);
    expect(highSpeedSteer.steering).toBeCloseTo(-maxAt60, 5);

    // Reversing direction crosses zero smoothly.
    input.handleKeyEvent(keyEvent('keyup', 'ArrowLeft'));
    input.handleKeyEvent(keyEvent('keydown', 'ArrowRight'));
    const reversed = input.update(0.2, 60);
    expect(reversed.steering).toBeGreaterThan(0);
    expect(reversed.steering).toBeLessThanOrEqual(maxAt60);

    // Throttle & brake smoothing and invalid dt resilience.
    input.releaseAll();
    input.handleKeyEvent(keyEvent('keydown', 'KeyW'));
    const t1 = input.update(0.1, 0);
    expect(t1.throttle).toBeCloseTo(DEFAULT_INPUT_SMOOTHING.throttleRiseRate * 0.1, 5);
    expect(input.update(-1, 0).throttle).toBeCloseTo(t1.throttle, 5);
    expect(input.update(Number.NaN, 0).throttle).toBeCloseTo(t1.throttle, 5);

    input.handleKeyEvent(keyEvent('keyup', 'KeyW'));
    const tReturn = input.update(0.5, 0);
    expect(tReturn.throttle).toBe(0);
  });

  it('forbids Ctrl/Alt/Meta in events and bindings, and detects same-context conflicts', () => {
    const input = new InputManager({ initialContext: 'race' });

    // Browser shortcuts must be ignored.
    expect(input.handleKeyEvent(keyEvent('keydown', 'KeyW', { ctrlKey: true }))).toBe(false);
    expect(input.handleKeyEvent(keyEvent('keydown', 'KeyS', { metaKey: true }))).toBe(false);
    expect(input.handleKeyEvent(keyEvent('keydown', 'ArrowLeft', { altKey: true }))).toBe(false);
    expect(input.handleKeyEvent(keyEvent('keydown', 'ControlLeft'))).toBe(false);
    expect(input.handleKeyEvent(keyEvent('keydown', 'AltRight'))).toBe(false);
    expect(input.handleKeyEvent(keyEvent('keydown', 'MetaLeft'))).toBe(false);
    expect(input.getPressedCodes()).toEqual([]);

    // Keyup still releases a held key even if Ctrl was pressed before release.
    input.handleKeyEvent(keyEvent('keydown', 'KeyW'));
    expect(input.isCodePressed('KeyW')).toBe(true);
    input.handleKeyEvent(keyEvent('keyup', 'KeyW', { ctrlKey: true }));
    expect(input.isCodePressed('KeyW')).toBe(false);

    // Binding Ctrl/Alt/Meta throws ForbiddenModifierBindingError.
    const invalidBindings: InputBindings = {
      ...DEFAULT_INPUT_BINDINGS,
      race: {
        ...DEFAULT_INPUT_BINDINGS.race,
        handbrake: ['ControlLeft'],
      },
    };
    expect(() => validateBindings(invalidBindings)).toThrow(ForbiddenModifierBindingError);
    expect(() => new InputManager({ bindings: invalidBindings })).toThrow(
      ForbiddenModifierBindingError,
    );

    // Same-context conflict detection.
    const conflictingBindings: InputBindings = {
      ...DEFAULT_INPUT_BINDINGS,
      race: {
        ...DEFAULT_INPUT_BINDINGS.race,
        handbrake: ['KeyW'],
      },
    };
    const conflicts = validateBindings(conflictingBindings);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.context).toBe('race');
    expect(conflicts[0]?.code).toBe('KeyW');
    expect(conflicts[0]?.actions).toEqual(['throttle', 'handbrake']);
  });

  it('prevents default on arrows and Space ONLY when canvas has focus', () => {
    const input = new InputManager();

    expect(input.shouldPreventDefault('ArrowUp', true)).toBe(true);
    expect(input.shouldPreventDefault('ArrowDown', true)).toBe(true);
    expect(input.shouldPreventDefault('ArrowLeft', true)).toBe(true);
    expect(input.shouldPreventDefault('ArrowRight', true)).toBe(true);
    expect(input.shouldPreventDefault('Space', true)).toBe(true);
    expect(input.shouldPreventDefault('KeyW', true)).toBe(false);

    // Never prevent default when canvas does not have focus.
    expect(input.shouldPreventDefault('ArrowUp', false)).toBe(false);
    expect(input.shouldPreventDefault('Space', false)).toBe(false);
  });

  it('releases all keys on blur, visibilitychange (hidden), and pointerlockchange via DOM bridge', () => {
    const windowListeners = new Map<string, Set<(...args: never[]) => void>>();
    const docListeners = new Map<string, Set<() => void>>();
    const canvasListeners = new Map<string, Set<() => void>>();

    let focusCalls = 0;
    const canvas: CanvasFocusTarget = {
      focus(): void {
        focusCalls += 1;
        fakeDoc.activeElement = canvas;
      },
      addEventListener(type, listener): void {
        const set = canvasListeners.get(type) ?? new Set<() => void>();
        set.add(listener);
        canvasListeners.set(type, set);
      },
      removeEventListener(type, listener): void {
        canvasListeners.get(type)?.delete(listener);
      },
    };

    const fakeDoc: {
      activeElement: unknown;
      visibilityState: DocumentVisibilityState;
    } & DocumentInputTarget = {
      activeElement: null,
      visibilityState: 'visible',
      addEventListener(type, listener): void {
        const set = docListeners.get(type) ?? new Set<() => void>();
        set.add(listener);
        docListeners.set(type, set);
      },
      removeEventListener(type, listener): void {
        docListeners.get(type)?.delete(listener);
      },
    };

    const fakeWin: WindowInputTarget = {
      addEventListener(type: string, listener: (...args: never[]) => void): void {
        const set = windowListeners.get(type) ?? new Set<(...args: never[]) => void>();
        set.add(listener);
        windowListeners.set(type, set);
      },
      removeEventListener(type: string, listener: (...args: never[]) => void): void {
        windowListeners.get(type)?.delete(listener);
      },
    };

    const emitKeyDown = (
      code: string,
      opts: Partial<Omit<KeyInputEvent, 'type' | 'code'>> = {},
    ): boolean => {
      let prevented = false;
      const evt: PreventableKeyEvent = {
        ...keyEvent('keydown', code, opts),
        preventDefault(): void {
          prevented = true;
        },
      };
      for (const listener of windowListeners.get('keydown') ?? []) {
        (listener as (e: PreventableKeyEvent) => void)(evt);
      }
      return prevented;
    };

    const emitWindowEvent = (type: 'blur'): void => {
      for (const listener of windowListeners.get(type) ?? []) {
        (listener as () => void)();
      }
    };

    const emitDocEvent = (type: 'visibilitychange' | 'pointerlockchange'): void => {
      for (const listener of docListeners.get(type) ?? []) {
        listener();
      }
    };

    const input = new InputManager({ initialContext: 'race' });
    const bridge = attachDomInputBridge({
      inputManager: input,
      canvas,
      targetWindow: fakeWin,
      targetDocument: fakeDoc,
    });

    // Canvas is focused on mount.
    expect(focusCalls).toBe(1);
    expect(fakeDoc.activeElement).toBe(canvas);

    // Focused canvas -> Space & ArrowUp call preventDefault; Ctrl+Space does not.
    expect(emitKeyDown('Space')).toBe(true);
    expect(emitKeyDown('ArrowUp')).toBe(true);
    expect(emitKeyDown('Space', { ctrlKey: true })).toBe(false);
    expect(input.isActionActive('handbrake')).toBe(true);
    expect(input.isActionActive('throttle')).toBe(true);

    // Window blur releases all keys.
    emitWindowEvent('blur');
    expect(input.getPressedCodes()).toEqual([]);

    // Unfocused canvas -> ArrowDown does NOT call preventDefault.
    fakeDoc.activeElement = { tagName: 'BUTTON' };
    expect(emitKeyDown('ArrowDown')).toBe(false);
    expect(input.isActionActive('brake')).toBe(true);

    // visibilitychange to 'visible' keeps state; 'hidden' releases all.
    fakeDoc.visibilityState = 'visible';
    emitDocEvent('visibilitychange');
    expect(input.isActionActive('brake')).toBe(true);
    fakeDoc.visibilityState = 'hidden';
    emitDocEvent('visibilitychange');
    expect(input.getPressedCodes()).toEqual([]);

    // pointerlockchange releases all keys.
    emitKeyDown('KeyW');
    expect(input.isActionActive('throttle')).toBe(true);
    emitDocEvent('pointerlockchange');
    expect(input.getPressedCodes()).toEqual([]);

    // Clicking canvas restores focus.
    fakeDoc.activeElement = null;
    for (const listener of canvasListeners.get('click') ?? []) {
      listener();
    }
    expect(focusCalls).toBe(2);
    expect(fakeDoc.activeElement).toBe(canvas);

    bridge.dispose();
    expect(windowListeners.get('keydown')?.size ?? 0).toBe(0);
    expect(docListeners.get('visibilitychange')?.size ?? 0).toBe(0);
  });

  it('exposes window.__input ONLY when URL query contains ?debug=1', () => {
    expect(isDebugMode('')).toBe(false);
    expect(isDebugMode('?debug=0')).toBe(false);
    expect(isDebugMode('?debug=true')).toBe(false);
    expect(isDebugMode('?debug=10')).toBe(false);
    expect(isDebugMode('?debug=1')).toBe(true);
    expect(isDebugMode('?foo=bar&debug=1')).toBe(true);

    const input = new InputManager({ initialContext: 'menu' });

    const prodWindow: InputDebugWindowHost = {};
    const cleanupProd = installInputDebugHook(prodWindow, '', input);
    expect('__input' in prodWindow).toBe(false);
    cleanupProd();

    const debugWindow: InputDebugWindowHost = {};
    const cleanupDebug = installInputDebugHook(debugWindow, '?debug=1', input);
    expect(debugWindow.__input).toBeDefined();

    input.handleKeyEvent(keyEvent('keydown', 'KeyW'));
    expect(debugWindow.__input?.getSnapshot().pressedCodes).toEqual(['KeyW']);
    expect(debugWindow.__input?.getSnapshot().activeActions).toEqual(['menuUp']);

    debugWindow.__input?.setContext('race');
    expect(debugWindow.__input?.getContext()).toBe('race');
    expect(debugWindow.__input?.isActionActive('throttle')).toBe(true);

    cleanupDebug();
    expect('__input' in debugWindow).toBe(false);
  });
});
