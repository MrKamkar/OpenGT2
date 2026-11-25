import type { InputManager } from './InputManager';
import type { KeyInputEvent } from './types';

export interface PreventableKeyEvent extends KeyInputEvent {
  preventDefault(): void;
}

export interface WindowInputTarget {
  addEventListener(type: 'keydown' | 'keyup', listener: (event: PreventableKeyEvent) => void): void;
  addEventListener(type: 'blur', listener: () => void): void;
  removeEventListener(
    type: 'keydown' | 'keyup',
    listener: (event: PreventableKeyEvent) => void,
  ): void;
  removeEventListener(type: 'blur', listener: () => void): void;
}

export interface DocumentInputTarget {
  readonly activeElement: unknown;
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: 'visibilitychange' | 'pointerlockchange', listener: () => void): void;
  removeEventListener(type: 'visibilitychange' | 'pointerlockchange', listener: () => void): void;
}

export interface CanvasFocusTarget {
  focus(options?: FocusOptions): void;
  addEventListener(type: 'pointerdown' | 'click', listener: () => void): void;
  removeEventListener(type: 'pointerdown' | 'click', listener: () => void): void;
}

export interface DomInputBridgeOptions {
  readonly inputManager: InputManager;
  readonly canvas: CanvasFocusTarget;
  readonly targetWindow?: WindowInputTarget;
  readonly targetDocument?: DocumentInputTarget;
}

export interface DomInputBridgeHandle {
  dispose(): void;
}

/** `<input type>` values that do not accept typed text (keys there may still drive the game). */
const NON_TEXT_INPUT_TYPES: ReadonlySet<string> = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

interface EditableCandidate {
  readonly tagName?: unknown;
  readonly type?: unknown;
  readonly isContentEditable?: unknown;
}

/**
 * Returns true when `element` is a text-editing control (text-like `<input>`, `<textarea>`,
 * `<select>` or a contenteditable host). Structural check so it works without DOM in tests.
 */
export function isEditableElement(element: unknown): boolean {
  if (typeof element !== 'object' || element === null) {
    return false;
  }
  const candidate = element as EditableCandidate;
  if (candidate.isContentEditable === true) {
    return true;
  }
  const tagName = typeof candidate.tagName === 'string' ? candidate.tagName.toUpperCase() : '';
  if (tagName === 'TEXTAREA' || tagName === 'SELECT') {
    return true;
  }
  if (tagName === 'INPUT') {
    const type = typeof candidate.type === 'string' ? candidate.type.toLowerCase() : 'text';
    return !NON_TEXT_INPUT_TYPES.has(type);
  }
  return false;
}

/**
 * Connects InputManager to browser window/document/canvas events:
 * - focuses canvas on mount and on click/pointerdown (ROADMAP §1.6)
 * - prevents default on arrows/Space ONLY when canvas has focus and no Ctrl/Alt/Meta
 * - releases all held keys on blur, visibilitychange (hidden), and pointerlockchange
 */
export function attachDomInputBridge(options: DomInputBridgeOptions): DomInputBridgeHandle {
  const { inputManager, canvas } = options;
  const targetWindow: WindowInputTarget =
    options.targetWindow ?? (window as unknown as WindowInputTarget);
  const targetDocument: DocumentInputTarget =
    options.targetDocument ?? (document as unknown as DocumentInputTarget);

  const focusCanvas = (): void => {
    canvas.focus({ preventScroll: true });
  };

  const onKeyDown = (event: PreventableKeyEvent): void => {
    // Typing in text fields (e.g. explorer search) must neither be blocked nor drive game actions.
    if (isEditableElement(targetDocument.activeElement)) {
      return;
    }
    const hasForbiddenModifier =
      event.ctrlKey === true || event.altKey === true || event.metaKey === true;
    const isCanvasFocused = targetDocument.activeElement === canvas;

    if (!hasForbiddenModifier && inputManager.shouldPreventDefault(event.code, isCanvasFocused)) {
      event.preventDefault();
    }

    inputManager.handleKeyEvent(event);
  };

  const onKeyUp = (event: PreventableKeyEvent): void => {
    inputManager.handleKeyEvent(event);
  };

  const onWindowBlur = (): void => {
    inputManager.releaseAll();
  };

  const onVisibilityChange = (): void => {
    if (targetDocument.visibilityState === 'hidden') {
      inputManager.releaseAll();
    }
  };

  const onPointerLockChange = (): void => {
    inputManager.releaseAll();
  };

  targetWindow.addEventListener('keydown', onKeyDown);
  targetWindow.addEventListener('keyup', onKeyUp);
  targetWindow.addEventListener('blur', onWindowBlur);
  targetDocument.addEventListener('visibilitychange', onVisibilityChange);
  targetDocument.addEventListener('pointerlockchange', onPointerLockChange);
  canvas.addEventListener('pointerdown', focusCanvas);
  canvas.addEventListener('click', focusCanvas);

  focusCanvas();

  return {
    dispose(): void {
      targetWindow.removeEventListener('keydown', onKeyDown);
      targetWindow.removeEventListener('keyup', onKeyUp);
      targetWindow.removeEventListener('blur', onWindowBlur);
      targetDocument.removeEventListener('visibilitychange', onVisibilityChange);
      targetDocument.removeEventListener('pointerlockchange', onPointerLockChange);
      canvas.removeEventListener('pointerdown', focusCanvas);
      canvas.removeEventListener('click', focusCanvas);
      inputManager.releaseAll();
    },
  };
}
