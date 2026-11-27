import type { AssetRepository, AssetRepositoryCacheStats } from '../assets';
import type { InputManager } from '../core/input';
import type { TrackModel } from '../formats/track';
import type {
  CarViewerCanvasInputTarget,
  CarViewerGlContextLike,
  CarViewerPixelSample,
  CarViewerPointerEventLike,
  CarViewerRafScheduler,
  CarViewerWheelEventLike,
} from './carViewerSession';
import type { RenderMode } from './carRenderer';
import { FreeCamera, type FreeCameraState } from './freecam';
import {
  DEFAULT_PS1_DISPLAY_ASPECT,
  DEFAULT_PS1_HEIGHT,
  DEFAULT_PS1_WIDTH,
} from './ps1Math';
import {
  EMPTY_TRACK_RENDER_STATS,
  type TrackRenderStats,
  TrackRenderer,
  type TrackRendererOptions,
  type WebGL2TrackRendererContext,
} from './trackRenderer';
import {
  EMPTY_GPU_RESOURCE_COUNTS,
  GL_NO_ERROR_CODE,
  type GlErrorStatus,
  type GpuResourceCounts,
} from './types';

export interface TrackViewerDebugStats {
  readonly fps: number;
  readonly renderStats: TrackRenderStats;
  readonly gpuResources: GpuResourceCounts;
  readonly glError: GlErrorStatus;
  readonly glErrorCount: number;
  readonly cacheStats: AssetRepositoryCacheStats;
}

export interface TrackViewerSessionSnapshot {
  readonly trackStem: string | null;
  readonly renderMode: RenderMode;
  readonly ps1Width: number;
  readonly ps1Height: number;
  readonly ps1Dithering: boolean;
  readonly ps1VertexSnap: boolean;
  readonly ps1AffineMapping: boolean;
  readonly wireframe: boolean;
  readonly loading: boolean;
  readonly loadProgress: number;
  readonly loadStageLabel: string | null;
  readonly errorMessage: string | null;
  readonly activeModel: TrackModel | null;
  readonly contextLost: boolean;
  readonly restoredCount: number;
  readonly running: boolean;
  readonly disposed: boolean;
  readonly cameraState: FreeCameraState;
}

export interface LoadTrackOptions {
  readonly preserveCamera?: boolean;
}

export interface TrackViewerSessionOptions {
  readonly glContext: CarViewerGlContextLike;
  readonly gl?: WebGL2TrackRendererContext;
  readonly canvas?: CarViewerCanvasInputTarget;
  readonly inputManager: InputManager;
  readonly assetRepository: AssetRepository;
  readonly initialMode?: RenderMode;
  readonly rendererFactory?: (
    gl: WebGL2TrackRendererContext,
    options: TrackRendererOptions,
  ) => TrackRenderer;
  readonly raf?: CarViewerRafScheduler;
  readonly now?: () => number;
  readonly onStateChange?: (snapshot: TrackViewerSessionSnapshot) => void;
  readonly onStatsUpdate?: (stats: TrackViewerDebugStats) => void;
}

const MAX_FRAME_DT_SECONDS = 0.1;
const FPS_WINDOW_MS = 250;

interface WebGL2ReadPixelsContext {
  readonly RGBA: number;
  readonly UNSIGNED_BYTE: number;
  readonly FRAMEBUFFER: number;
  bindFramebuffer?(target: number, framebuffer: WebGLFramebuffer | null): void;
  readPixels?(
    x: number,
    y: number,
    width: number,
    height: number,
    format: number,
    type: number,
    pixels: ArrayBufferView,
  ): void;
}

function defaultRafScheduler(): CarViewerRafScheduler {
  if (typeof requestAnimationFrame === 'function' && typeof cancelAnimationFrame === 'function') {
    return {
      request: (cb) => requestAnimationFrame(cb),
      cancel: (id) => cancelAnimationFrame(id),
    };
  }
  return {
    request: (cb) => Number(setTimeout(() => cb(Date.now()), 16)),
    cancel: (id) => clearTimeout(id),
  };
}

function defaultNow(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Coordinates `TrackRenderer`, `FreeCamera`, `InputManager` (`freecam` context),
 * pointer drag look / wheel speed adjust, streaming `AssetRepository` track loading,
 * and `webglcontextlost`/`restored` recovery (`M8.9`).
 */
export class TrackViewerSession {
  private readonly glContext: CarViewerGlContextLike;
  private readonly gl: WebGL2TrackRendererContext;
  private readonly canvas: CarViewerCanvasInputTarget | undefined;
  private readonly inputManager: InputManager;
  private readonly assetRepository: AssetRepository;
  private readonly rendererFactory: (
    gl: WebGL2TrackRendererContext,
    options: TrackRendererOptions,
  ) => TrackRenderer;
  private readonly raf: CarViewerRafScheduler;
  private readonly now: () => number;
  private readonly onStateChange: ((snapshot: TrackViewerSessionSnapshot) => void) | undefined;
  private readonly onStatsUpdate: ((stats: TrackViewerDebugStats) => void) | undefined;

  public readonly camera = new FreeCamera();

  private renderer: TrackRenderer | null = null;
  private activeModel: TrackModel | null = null;
  private trackStem: string | null = null;
  private renderMode: RenderMode;
  private ps1Width = DEFAULT_PS1_WIDTH;
  private ps1Height = DEFAULT_PS1_HEIGHT;
  private ps1Dithering = true;
  private ps1VertexSnap = true;
  private ps1AffineMapping = true;
  private wireframe = false;
  private loading = false;
  private loadProgress = 0;
  private loadStageLabel: string | null = null;
  private errorMessage: string | null = null;
  private contextLost = false;
  private restoredCount = 0;
  private running = false;
  private pausedByContextLoss = false;
  private disposed = false;

  private loadGeneration = 0;
  private activeLoadAbort: AbortController | null = null;
  private rafId: number | null = null;
  private lastTickMs: number | null = null;
  private fpsWindowStartMs = 0;
  private fpsFrameCount = 0;
  private currentFps = 0;
  private lastRenderStats: TrackRenderStats = EMPTY_TRACK_RENDER_STATS;
  private lastGlError: GlErrorStatus = {
    code: GL_NO_ERROR_CODE,
    name: 'NO_ERROR',
    hasError: false,
  };
  private glErrorCount = 0;
  private readonly removeContextListener: (() => void) | null = null;

  private readonly activePointers = new Map<number, { x: number; y: number }>();

  private readonly handlePointerDown = (event: CarViewerPointerEventLike): void => {
    if (this.disposed || !this.running) {
      return;
    }
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    this.activePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  };

  private readonly handlePointerMove = (event: CarViewerPointerEventLike): void => {
    if (this.disposed || !this.running) {
      return;
    }
    const prev = this.activePointers.get(event.pointerId);
    if (prev === undefined) {
      return;
    }
    if (this.activePointers.size === 1) {
      const dx = event.clientX - prev.x;
      const dy = event.clientY - prev.y;
      prev.x = event.clientX;
      prev.y = event.clientY;
      const viewportHeight = Math.max(1, this.glContext.getSize().height);
      this.camera.lookByPixels(dx, dy, viewportHeight);
    }
  };

  private readonly handlePointerUp = (event: CarViewerPointerEventLike): void => {
    this.activePointers.delete(event.pointerId);
  };

  private readonly handleWheel = (event: CarViewerWheelEventLike): void => {
    if (this.disposed || !this.running) {
      return;
    }
    event.preventDefault();
    this.camera.adjustSpeedByWheel(event.deltaY);
    this.emitStateChange();
  };

  public constructor(options: TrackViewerSessionOptions) {
    this.glContext = options.glContext;
    this.gl = options.gl ?? (options.glContext.gl as unknown as WebGL2TrackRendererContext);
    this.canvas = options.canvas;
    this.inputManager = options.inputManager;
    this.assetRepository = options.assetRepository;
    this.renderMode = options.initialMode ?? 'hd';
    this.rendererFactory =
      options.rendererFactory ?? ((gl, rendererOpts) => new TrackRenderer(gl, rendererOpts));
    this.raf = options.raf ?? defaultRafScheduler();
    this.now = options.now ?? defaultNow;
    this.onStateChange = options.onStateChange;
    this.onStatsUpdate = options.onStatsUpdate;
    this.contextLost = this.glContext.isContextLost();

    if (this.canvas !== undefined) {
      this.canvas.addEventListener('pointerdown', this.handlePointerDown);
      this.canvas.addEventListener('pointermove', this.handlePointerMove);
      this.canvas.addEventListener('pointerup', this.handlePointerUp);
      this.canvas.addEventListener('pointercancel', this.handlePointerUp);
      this.canvas.addEventListener('wheel', this.handleWheel, { passive: false });
    }

    if (typeof this.glContext.addContextListener === 'function') {
      this.removeContextListener = this.glContext.addContextListener({
        onContextLost: () => this.handleContextLost(),
        onContextRestored: () => this.handleContextRestored(),
      });
    }
  }

  public start(): void {
    if (this.disposed) {
      return;
    }
    if (this.contextLost) {
      this.pausedByContextLoss = true;
      return;
    }
    if (this.running) {
      return;
    }
    this.running = true;
    this.lastTickMs = null;
    this.fpsWindowStartMs = this.now();
    this.fpsFrameCount = 0;
    this.scheduleNextFrame();
    this.emitStateChange();
  }

  public pause(): void {
    this.pausedByContextLoss = false;
    if (!this.running) {
      return;
    }
    this.running = false;
    this.activePointers.clear();
    if (this.rafId !== null) {
      this.raf.cancel(this.rafId);
      this.rafId = null;
    }
    this.lastTickMs = null;
    this.emitStateChange();
  }

  public async loadTrack(
    stem: string,
    options: LoadTrackOptions = {},
  ): Promise<TrackModel | null> {
    if (this.disposed) {
      return null;
    }

    const normalizedStem = stem.trim().toLowerCase();
    this.loadGeneration += 1;
    const generation = this.loadGeneration;

    if (this.activeLoadAbort !== null) {
      this.activeLoadAbort.abort('Superseded by newer track selection');
    }
    const controller = new AbortController();
    this.activeLoadAbort = controller;

    this.trackStem = normalizedStem;
    this.loading = true;
    this.loadProgress = 0.05;
    this.loadStageLabel = `Preparing ${normalizedStem}…`;
    this.errorMessage = null;
    this.emitStateChange();

    try {
      const model = await this.assetRepository.getTrackModel(normalizedStem, {
        signal: controller.signal,
        onProgress: (prog) => {
          if (this.disposed || generation !== this.loadGeneration) {
            return;
          }
          this.loadProgress = prog.progress;
          this.loadStageLabel = prog.label;
          this.emitStateChange();
        },
      });
      if (this.disposed || generation !== this.loadGeneration) {
        return null;
      }

      this.activeModel = model;
      this.loading = false;
      this.loadProgress = 1;
      this.loadStageLabel = null;
      this.errorMessage = null;

      if (options.preserveCamera !== true) {
        this.camera.teleportToStart(model);
      }

      if (this.running && !this.contextLost && !this.glContext.isContextLost()) {
        const renderer = this.ensureRenderer();
        renderer.setTrack(model);
      } else {
        // Release stale GPU track if inactive so next renderCurrentFrame() uploads activeModel cleanly.
        this.renderer?.dispose();
        this.renderer = null;
      }

      this.emitStateChange();
      this.emitDebugStats();
      return model;
    } catch (error: unknown) {
      if (this.disposed || generation !== this.loadGeneration) {
        return null;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        return null;
      }
      this.loading = false;
      this.loadProgress = 0;
      this.loadStageLabel = null;
      this.errorMessage =
        error instanceof Error ? error.message : 'Failed to load track model.';
      this.emitStateChange();
      return null;
    } finally {
      if (this.activeLoadAbort === controller) {
        this.activeLoadAbort = null;
      }
    }
  }

  public setRenderMode(mode: RenderMode): void {
    if (this.disposed || this.renderMode === mode) {
      return;
    }
    this.renderMode = mode;
    this.renderer?.setMode(mode);
    this.emitStateChange();
    this.emitDebugStats();
  }

  public setPs1Resolution(width: number, height: number): void {
    if (this.disposed) {
      return;
    }
    this.ps1Width = width;
    this.ps1Height = height;
    this.renderer?.setPs1InternalResolution(width, height);
    this.emitStateChange();
    this.emitDebugStats();
  }

  public setPs1Dithering(enabled: boolean): void {
    if (this.disposed || this.ps1Dithering === enabled) {
      return;
    }
    this.ps1Dithering = enabled;
    this.emitStateChange();
  }

  public setPs1VertexSnap(enabled: boolean): void {
    if (this.disposed || this.ps1VertexSnap === enabled) {
      return;
    }
    this.ps1VertexSnap = enabled;
    this.emitStateChange();
  }

  public setPs1AffineMapping(enabled: boolean): void {
    if (this.disposed || this.ps1AffineMapping === enabled) {
      return;
    }
    this.ps1AffineMapping = enabled;
    this.emitStateChange();
  }

  public setWireframe(enabled: boolean): void {
    if (this.disposed || this.wireframe === enabled) {
      return;
    }
    this.wireframe = enabled;
    this.emitStateChange();
  }

  public setMoveSpeed(speedMps: number): void {
    if (this.disposed) {
      return;
    }
    this.camera.setSpeed(speedMps);
    this.emitStateChange();
  }

  public teleportToStart(): void {
    if (this.disposed) {
      return;
    }
    if (this.activeModel !== null) {
      this.camera.teleportToStart(this.activeModel);
    } else {
      this.camera.reset();
    }
    this.emitStateChange();
  }

  public stepFrame(dtSeconds: number): void {
    if (this.disposed || this.contextLost || this.glContext.isContextLost()) {
      return;
    }
    const updateRes = this.camera.updateFromInput(this.inputManager, dtSeconds);
    if (updateRes.resetTriggered) {
      this.emitStateChange();
    }
    this.renderCurrentFrame();
  }

  public renderCurrentFrame(): void {
    if (this.disposed || this.contextLost || this.glContext.isContextLost()) {
      return;
    }
    if (this.activeModel === null) {
      this.glContext.clear();
      return;
    }

    let renderer = this.renderer;
    if (renderer === null || renderer.isDisposed()) {
      renderer = this.ensureRenderer();
      renderer.setTrack(this.activeModel);
    }

    const { width, height } = this.glContext.getSize();
    const safeW = Math.max(1, width);
    const safeH = Math.max(1, height);

    this.camera.setAspect(
      this.renderMode === 'ps1' ? DEFAULT_PS1_DISPLAY_ASPECT : safeW / safeH,
    );

    this.lastRenderStats = renderer.render(this.camera, safeW, safeH, {
      wireframe: this.wireframe,
      ps1VertexSnap: this.ps1VertexSnap,
      ps1AffineMapping: this.ps1AffineMapping,
      ps1Dithering: this.ps1Dithering,
      ps1Quantize15Bit: this.ps1Dithering,
    });

    const polledError = renderer.pollGlError();
    if (polledError.hasError && !(this.contextLost && polledError.code === 0x9242)) {
      this.lastGlError = polledError;
      this.glErrorCount += 1;
      this.emitDebugStats();
    } else if (this.lastGlError.hasError && !polledError.hasError) {
      this.lastGlError = polledError;
    }
  }

  public getGpuResourceCounts(): GpuResourceCounts {
    if (this.disposed || this.contextLost || this.renderer === null) {
      return EMPTY_GPU_RESOURCE_COUNTS;
    }
    return this.renderer.getResourceCounts();
  }

  public getSnapshot(): TrackViewerSessionSnapshot {
    return {
      trackStem: this.trackStem,
      renderMode: this.renderMode,
      ps1Width: this.ps1Width,
      ps1Height: this.ps1Height,
      ps1Dithering: this.ps1Dithering,
      ps1VertexSnap: this.ps1VertexSnap,
      ps1AffineMapping: this.ps1AffineMapping,
      wireframe: this.wireframe,
      loading: this.loading,
      loadProgress: this.loadProgress,
      loadStageLabel: this.loadStageLabel,
      errorMessage: this.errorMessage,
      activeModel: this.activeModel,
      contextLost: this.contextLost,
      restoredCount: this.restoredCount,
      running: this.running,
      disposed: this.disposed,
      cameraState: this.camera.getState(),
    };
  }

  public getDebugStats(): TrackViewerDebugStats {
    return {
      fps: this.currentFps,
      renderStats: this.lastRenderStats,
      gpuResources: this.getGpuResourceCounts(),
      glError: this.lastGlError,
      glErrorCount: this.glErrorCount,
      cacheStats: this.assetRepository.getTrackCacheStats(),
    };
  }

  /**
   * Renders a fresh frame if ready and samples a centered viewport box via `gl.readPixels`
   * for `?debug=1` / E2E verification without altering `preserveDrawingBuffer: false`.
   */
  public sampleCenterPixels(boxSize = 48): CarViewerPixelSample {
    const { width, height } = this.glContext.getSize();
    const safeW = Math.max(1, width);
    const safeH = Math.max(1, height);

    if (this.disposed || this.contextLost || this.glContext.isContextLost()) {
      return {
        width: safeW,
        height: safeH,
        totalSamples: 0,
        nonBackgroundPixels: 0,
        avgR: 0,
        avgG: 0,
        avgB: 0,
      };
    }

    this.renderCurrentFrame();

    const readGl = this.gl as unknown as WebGL2ReadPixelsContext;
    if (typeof readGl.readPixels !== 'function') {
      return {
        width: safeW,
        height: safeH,
        totalSamples: 0,
        nonBackgroundPixels: 0,
        avgR: 0,
        avgG: 0,
        avgB: 0,
      };
    }

    const readW = Math.min(safeW, Math.max(1, Math.trunc(boxSize)));
    const readH = Math.min(safeH, Math.max(1, Math.trunc(boxSize)));
    const readX = Math.max(0, Math.floor((safeW - readW) * 0.5));
    const readY = Math.max(0, Math.floor((safeH - readH) * 0.5));

    if (typeof readGl.bindFramebuffer === 'function') {
      readGl.bindFramebuffer(readGl.FRAMEBUFFER, null);
    }

    const pixels = new Uint8Array(readW * readH * 4);
    readGl.readPixels(readX, readY, readW, readH, readGl.RGBA, readGl.UNSIGNED_BYTE, pixels);

    let nonBackgroundPixels = 0;
    let sumR = 0;
    let sumG = 0;
    let sumB = 0;
    const totalSamples = readW * readH;

    for (let i = 0; i < totalSamples; i += 1) {
      const base = i * 4;
      const r = pixels[base] ?? 0;
      const g = pixels[base + 1] ?? 0;
      const b = pixels[base + 2] ?? 0;

      const isBlackBg = r <= 2 && g <= 2 && b <= 2;
      const isClearBg =
        Math.abs(r - 12) <= 2 && Math.abs(g - 16) <= 2 && Math.abs(b - 24) <= 2;

      if (!isBlackBg && !isClearBg) {
        nonBackgroundPixels += 1;
        sumR += r;
        sumG += g;
        sumB += b;
      }
    }

    return {
      width: safeW,
      height: safeH,
      totalSamples,
      nonBackgroundPixels,
      avgR: nonBackgroundPixels > 0 ? sumR / nonBackgroundPixels : 0,
      avgG: nonBackgroundPixels > 0 ? sumG / nonBackgroundPixels : 0,
      avgB: nonBackgroundPixels > 0 ? sumB / nonBackgroundPixels : 0,
    };
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.pause();
    this.removeContextListener?.();
    this.loadGeneration += 1;
    if (this.activeLoadAbort !== null) {
      this.activeLoadAbort.abort('TrackViewerSession disposed');
      this.activeLoadAbort = null;
    }
    if (this.canvas !== undefined) {
      this.canvas.removeEventListener('pointerdown', this.handlePointerDown);
      this.canvas.removeEventListener('pointermove', this.handlePointerMove);
      this.canvas.removeEventListener('pointerup', this.handlePointerUp);
      this.canvas.removeEventListener('pointercancel', this.handlePointerUp);
      this.canvas.removeEventListener('wheel', this.handleWheel);
    }
    this.renderer?.dispose();
    this.renderer = null;
    this.activeModel = null;
  }

  private handleContextLost(): void {
    if (this.disposed || this.contextLost) {
      return;
    }
    const wasRunning = this.running;
    this.pause();
    this.pausedByContextLoss = wasRunning;
    this.contextLost = true;
    this.renderer?.invalidateOnContextLost();
    this.renderer = null;
    this.emitStateChange();
    this.emitDebugStats();
  }

  private handleContextRestored(): void {
    if (this.disposed) {
      return;
    }
    this.contextLost = false;
    this.restoredCount += 1;
    this.lastGlError = {
      code: GL_NO_ERROR_CODE,
      name: 'NO_ERROR',
      hasError: false,
    };

    if (this.trackStem !== null) {
      const cached =
        this.assetRepository.getCachedTrackModel(this.trackStem) ?? this.activeModel;
      if (cached !== null) {
        this.activeModel = cached;
        if (this.pausedByContextLoss) {
          const renderer = this.ensureRenderer();
          renderer.setTrack(cached);
        }
      }
    }

    if (this.pausedByContextLoss) {
      this.pausedByContextLoss = false;
      this.start();
    }
    if (this.running) {
      this.renderCurrentFrame();
    }
    this.emitStateChange();
    this.emitDebugStats();
  }

  private ensureRenderer(): TrackRenderer {
    if (this.renderer !== null && !this.renderer.isDisposed()) {
      return this.renderer;
    }
    this.renderer = this.rendererFactory(this.gl, {
      initialMode: this.renderMode,
      ps1InternalWidth: this.ps1Width,
      ps1InternalHeight: this.ps1Height,
    });
    return this.renderer;
  }

  private scheduleNextFrame(): void {
    if (this.disposed || !this.running) {
      return;
    }
    this.rafId = this.raf.request((timestampMs) => {
      if (this.disposed || !this.running) {
        return;
      }
      const prevMs = this.lastTickMs;
      this.lastTickMs = timestampMs;
      const dtSeconds =
        prevMs !== null
          ? Math.min(MAX_FRAME_DT_SECONDS, Math.max(0, (timestampMs - prevMs) / 1000))
          : 0;

      this.stepFrame(dtSeconds);

      this.fpsFrameCount += 1;
      const elapsed = timestampMs - this.fpsWindowStartMs;
      if (elapsed >= FPS_WINDOW_MS) {
        this.currentFps = Math.round((this.fpsFrameCount * 1000) / Math.max(1, elapsed));
        this.fpsFrameCount = 0;
        this.fpsWindowStartMs = timestampMs;
        this.emitDebugStats();
      }

      this.scheduleNextFrame();
    });
  }

  private emitStateChange(): void {
    this.onStateChange?.(this.getSnapshot());
  }

  private emitDebugStats(): void {
    this.onStatsUpdate?.(this.getDebugStats());
  }
}
