export interface RgbaColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** Background color matching CSS --ogt2-bg (#0c1018). */
export const DEFAULT_CLEAR_COLOR: RgbaColor = Object.freeze({
  r: 12 / 255,
  g: 16 / 255,
  b: 24 / 255,
  a: 1,
});

export interface WebGL2ClearContext {
  readonly COLOR_BUFFER_BIT: number;
  viewport(x: number, y: number, width: number, height: number): void;
  clearColor(red: number, green: number, blue: number, alpha: number): void;
  clear(mask: number): void;
  isContextLost(): boolean;
}

export interface GlCanvasTarget {
  width: number;
  height: number;
  readonly clientWidth: number;
  readonly clientHeight: number;
  getContext(
    contextId: 'webgl2',
    options?: WebGLContextAttributes,
  ): WebGL2ClearContext | null;
  addEventListener(type: string, listener: (event: Event) => void): void;
  removeEventListener(type: string, listener: (event: Event) => void): void;
}

export interface ResizeObserverLike {
  observe(target: GlCanvasTarget): void;
  disconnect(): void;
}

export interface GlContextLifecycleListener {
  readonly onContextLost?: () => void;
  readonly onContextRestored?: () => void;
}

export interface GlContextOptions {
  readonly clearColor?: RgbaColor;
  readonly getDevicePixelRatio?: () => number;
  readonly createResizeObserver?: (onResize: () => void) => ResizeObserverLike;
  readonly onContextLost?: () => void;
  readonly onContextRestored?: () => void;
}

export interface GlViewportSize {
  readonly width: number;
  readonly height: number;
}

export class WebGL2UnavailableError extends Error {
  public constructor(message = 'WebGL2 context could not be created.') {
    super(message);
    this.name = 'WebGL2UnavailableError';
  }
}

const DEFAULT_WEBGL2_ATTRIBUTES: WebGLContextAttributes = {
  alpha: false,
  antialias: false,
  depth: false,
  stencil: false,
  preserveDrawingBuffer: false,
  powerPreference: 'high-performance',
};

function defaultDevicePixelRatio(): number {
  if (typeof window === 'undefined') {
    return 1;
  }
  const dpr = window.devicePixelRatio;
  return Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
}

/**
 * Pure WebGL2 context wrapper for M0.7.
 * Handles devicePixelRatio sizing, ResizeObserver, and context lost/restored.
 * Strictly clears the background color only — draws no geometry or placeholder assets (§1.1).
 */
export class GlContext {
  public readonly canvas: GlCanvasTarget;
  public readonly gl: WebGL2ClearContext;

  private clearColorValue: RgbaColor;
  private readonly getDevicePixelRatio: () => number;
  private readonly onContextLostCallback: (() => void) | undefined;
  private readonly onContextRestoredCallback: (() => void) | undefined;
  private resizeObserver: ResizeObserverLike | null = null;
  private readonly contextListeners = new Set<GlContextLifecycleListener>();
  private contextLost = false;
  private disposed = false;

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.contextLost = true;
    this.onContextLostCallback?.();
    for (const listener of this.contextListeners) {
      listener.onContextLost?.();
    }
  };

  private readonly handleContextRestored = (): void => {
    this.contextLost = false;
    this.resize();
    this.onContextRestoredCallback?.();
    for (const listener of this.contextListeners) {
      listener.onContextRestored?.();
    }
  };

  private readonly handleWindowResize = (): void => {
    this.resize();
  };

  public constructor(canvas: GlCanvasTarget, options: GlContextOptions = {}) {
    const gl = canvas.getContext('webgl2', DEFAULT_WEBGL2_ATTRIBUTES);
    if (gl === null) {
      throw new WebGL2UnavailableError();
    }

    this.canvas = canvas;
    this.gl = gl;
    this.clearColorValue = options.clearColor ?? DEFAULT_CLEAR_COLOR;
    this.getDevicePixelRatio = options.getDevicePixelRatio ?? defaultDevicePixelRatio;
    this.onContextLostCallback = options.onContextLost;
    this.onContextRestoredCallback = options.onContextRestored;
    this.contextLost = gl.isContextLost();

    this.canvas.addEventListener('webglcontextlost', this.handleContextLost);
    this.canvas.addEventListener('webglcontextrestored', this.handleContextRestored);

    if (options.createResizeObserver !== undefined) {
      this.resizeObserver = options.createResizeObserver(() => {
        this.resize();
      });
      this.resizeObserver.observe(this.canvas);
    } else if (typeof ResizeObserver !== 'undefined' && this.canvas instanceof Element) {
      const observer = new ResizeObserver(() => {
        this.resize();
      });
      observer.observe(this.canvas);
      this.resizeObserver = {
        observe: () => {
          // Already observing canvas.
        },
        disconnect: () => {
          observer.disconnect();
        },
      };
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('resize', this.handleWindowResize);
    }

    this.resize();
  }

  public addContextListener(listener: GlContextLifecycleListener): () => void {
    if (this.disposed) {
      return () => {};
    }
    this.contextListeners.add(listener);
    return () => {
      this.contextListeners.delete(listener);
    };
  }

  public isContextLost(): boolean {
    return this.contextLost || this.gl.isContextLost();
  }

  public getSize(): GlViewportSize {
    return {
      width: this.canvas.width,
      height: this.canvas.height,
    };
  }

  public setClearColor(color: RgbaColor): void {
    this.clearColorValue = color;
    this.clear();
  }

  public resize(): void {
    if (this.disposed) {
      return;
    }

    const rawDpr = this.getDevicePixelRatio();
    const dpr = Number.isFinite(rawDpr) && rawDpr > 0 ? rawDpr : 1;
    const cssWidth = this.canvas.clientWidth > 0 ? this.canvas.clientWidth : this.canvas.width;
    const cssHeight = this.canvas.clientHeight > 0 ? this.canvas.clientHeight : this.canvas.height;
    const pixelWidth = Math.max(1, Math.round(cssWidth * dpr));
    const pixelHeight = Math.max(1, Math.round(cssHeight * dpr));

    if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
      this.canvas.width = pixelWidth;
      this.canvas.height = pixelHeight;
    }

    if (this.isContextLost()) {
      return;
    }

    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.clear();
  }

  public clear(): void {
    if (this.disposed || this.isContextLost()) {
      return;
    }

    const { r, g, b, a } = this.clearColorValue;
    this.gl.clearColor(r, g, b, a);
    this.gl.clear(this.gl.COLOR_BUFFER_BIT);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.contextListeners.clear();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored);
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', this.handleWindowResize);
    }
  }
}
