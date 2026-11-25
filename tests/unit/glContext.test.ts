import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CLEAR_COLOR,
  GlContext,
  WebGL2UnavailableError,
  type GlCanvasTarget,
  type ResizeObserverLike,
  type WebGL2ClearContext,
} from '../../src/renderer/GlContext';

interface MockGlSetup {
  readonly canvas: GlCanvasTarget & { clientWidth: number; clientHeight: number };
  readonly gl: WebGL2ClearContext & {
    viewport: ReturnType<typeof vi.fn>;
    clearColor: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
    setLost(lost: boolean): void;
  };
  dispatchCanvasEvent(type: string): { defaultPrevented: boolean };
}

function createMockGlSetup(options?: {
  webgl2Available?: boolean;
  clientWidth?: number;
  clientHeight?: number;
}): MockGlSetup {
  let lost = false;
  const listeners = new Map<string, Set<(event: Event) => void>>();

  const gl = {
    COLOR_BUFFER_BIT: 0x00004000,
    viewport: vi.fn(),
    clearColor: vi.fn(),
    clear: vi.fn(),
    isContextLost: () => lost,
    setLost(next: boolean): void {
      lost = next;
    },
  };

  const canvas = {
    width: 300,
    height: 150,
    clientWidth: options?.clientWidth ?? 800,
    clientHeight: options?.clientHeight ?? 600,
    getContext: vi.fn((contextId: 'webgl2') => {
      if (contextId !== 'webgl2' || options?.webgl2Available === false) {
        return null;
      }
      return gl;
    }),
    addEventListener: vi.fn((type: string, listener: (event: Event) => void) => {
      let bucket = listeners.get(type);
      if (bucket === undefined) {
        bucket = new Set();
        listeners.set(type, bucket);
      }
      bucket.add(listener);
    }),
    removeEventListener: vi.fn((type: string, listener: (event: Event) => void) => {
      listeners.get(type)?.delete(listener);
    }),
  };

  return {
    canvas,
    gl,
    dispatchCanvasEvent(type: string): { defaultPrevented: boolean } {
      let defaultPrevented = false;
      const fakeEvent = {
        type,
        preventDefault(): void {
          defaultPrevented = true;
        },
      } as unknown as Event;

      for (const listener of listeners.get(type) ?? []) {
        listener(fakeEvent);
      }
      return { defaultPrevented };
    },
  };
}

describe('GlContext (M0.7)', () => {
  it('throws WebGL2UnavailableError when webgl2 context cannot be created', () => {
    const setup = createMockGlSetup({ webgl2Available: false });
    expect(() => new GlContext(setup.canvas)).toThrow(WebGL2UnavailableError);
  });

  it('sizes canvas by devicePixelRatio, sets viewport, and only clears background color', () => {
    const setup = createMockGlSetup({ clientWidth: 640, clientHeight: 360 });
    const ctx = new GlContext(setup.canvas, {
      getDevicePixelRatio: () => 2,
    });

    expect(ctx.getSize()).toEqual({ width: 1280, height: 720 });
    expect(setup.gl.viewport).toHaveBeenCalledWith(0, 0, 1280, 720);
    expect(setup.gl.clearColor).toHaveBeenCalledWith(
      DEFAULT_CLEAR_COLOR.r,
      DEFAULT_CLEAR_COLOR.g,
      DEFAULT_CLEAR_COLOR.b,
      DEFAULT_CLEAR_COLOR.a,
    );
    expect(setup.gl.clear).toHaveBeenCalledWith(setup.gl.COLOR_BUFFER_BIT);

    ctx.dispose();
  });

  it('reacts to ResizeObserver updates with current DPR', () => {
    const setup = createMockGlSetup({ clientWidth: 400, clientHeight: 300 });
    let dpr = 1;
    let triggerResize: (() => void) | undefined;
    const disconnect = vi.fn();

    const ctx = new GlContext(setup.canvas, {
      getDevicePixelRatio: () => dpr,
      createResizeObserver: (onResize): ResizeObserverLike => {
        triggerResize = onResize;
        return {
          observe: vi.fn(),
          disconnect,
        };
      },
    });

    expect(ctx.getSize()).toEqual({ width: 400, height: 300 });

    setup.canvas.clientWidth = 500;
    setup.canvas.clientHeight = 250;
    dpr = 1.5;
    triggerResize?.();

    expect(ctx.getSize()).toEqual({ width: 750, height: 375 });
    expect(setup.gl.viewport).toHaveBeenLastCalledWith(0, 0, 750, 375);

    ctx.dispose();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it('handles webglcontextlost and webglcontextrestored safely', () => {
    const setup = createMockGlSetup({ clientWidth: 320, clientHeight: 240 });
    const onLost = vi.fn();
    const onRestored = vi.fn();

    const ctx = new GlContext(setup.canvas, {
      getDevicePixelRatio: () => 1,
      onContextLost: onLost,
      onContextRestored: onRestored,
    });

    setup.gl.clear.mockClear();

    const lostResult = setup.dispatchCanvasEvent('webglcontextlost');
    expect(lostResult.defaultPrevented).toBe(true);
    expect(ctx.isContextLost()).toBe(true);
    expect(onLost).toHaveBeenCalledTimes(1);

    ctx.clear();
    expect(setup.gl.clear).not.toHaveBeenCalled();

    setup.dispatchCanvasEvent('webglcontextrestored');
    expect(ctx.isContextLost()).toBe(false);
    expect(onRestored).toHaveBeenCalledTimes(1);
    expect(setup.gl.clear).toHaveBeenCalledTimes(1);

    ctx.dispose();
  });
});
