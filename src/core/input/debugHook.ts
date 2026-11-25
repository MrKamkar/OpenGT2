import type { InputManager } from './InputManager';
import type { AnalogAxes, InputAction, InputContext, InputSnapshot } from './types';

export const DEBUG_QUERY_PARAM = 'debug';
export const DEBUG_QUERY_ENABLED_VALUE = '1';

export interface InputDebugApi {
  getSnapshot(): InputSnapshot;
  getContext(): InputContext;
  setContext(context: InputContext): void;
  isCodePressed(code: string): boolean;
  isActionActive(action: InputAction): boolean;
  step(dtSeconds: number, speedMps?: number): AnalogAxes;
  releaseAll(): void;
}

export interface InputDebugWindowHost {
  __input?: InputDebugApi;
}

declare global {
  interface Window {
    __input?: InputDebugApi;
  }
}

/**
 * Returns true strictly when URL search params include `debug=1`.
 */
export function isDebugMode(search: string): boolean {
  const params = new URLSearchParams(search);
  return params.get(DEBUG_QUERY_PARAM) === DEBUG_QUERY_ENABLED_VALUE;
}

/**
 * Exposes read/inspect handle at `window.__input` ONLY when URL contains `?debug=1`.
 */
export function installInputDebugHook(
  targetWindow: InputDebugWindowHost,
  search: string,
  inputManager: InputManager,
): () => void {
  if (!isDebugMode(search)) {
    return () => {
      // No-op when debug mode is inactive.
    };
  }

  const debugApi: InputDebugApi = {
    getSnapshot(): InputSnapshot {
      return inputManager.getSnapshot();
    },
    getContext(): InputContext {
      return inputManager.getContext();
    },
    setContext(context: InputContext): void {
      inputManager.setContext(context);
    },
    isCodePressed(code: string): boolean {
      return inputManager.isCodePressed(code);
    },
    isActionActive(action: InputAction): boolean {
      return inputManager.isActionActive(action);
    },
    step(dtSeconds: number, speedMps = 0): AnalogAxes {
      return inputManager.update(dtSeconds, speedMps);
    },
    releaseAll(): void {
      inputManager.releaseAll();
    },
  };

  targetWindow.__input = debugApi;

  return () => {
    if (targetWindow.__input === debugApi) {
      delete targetWindow.__input;
    }
  };
}
