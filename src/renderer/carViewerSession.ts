import type { AssetRepository, AssetRepositoryCacheStats } from '../assets';
import type { InputManager } from '../core/input';
import type { CarModel, CarModelLod, CarTextureVariant } from '../formats/car';
import type { GlViewportSize, WebGL2ClearContext } from './GlContext';
import { type OrbitCameraState, OrbitCamera } from './camera';
import {
  CarRenderer,
  type CarRendererOptions,
  type RenderMode,
  type WebGL2CarRendererContext,
} from './carRenderer';
import {
  DEFAULT_PS1_DISPLAY_ASPECT,
  DEFAULT_PS1_HEIGHT,
  DEFAULT_PS1_WIDTH,
} from './ps1Math';
import { EMPTY_GPU_RESOURCE_COUNTS, type GpuResourceCounts } from './types';

export type CarLodSelection = 'auto' | 0 | 1 | 2;

export interface CarViewerGlContextLike {
  readonly gl: WebGL2ClearContext;
  isContextLost(): boolean;
  getSize(): GlViewportSize;
  clear(): void;
}

export interface CarViewerPointerEventLike {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly button: number;
  readonly clientX: number;
  readonly clientY: number;
}

export interface CarViewerWheelEventLike {
  readonly deltaY: number;
  preventDefault(): void;
}

export interface CarViewerCanvasInputTarget {
  addEventListener(type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel', listener: (event: CarViewerPointerEventLike) => void): void;
  addEventListener(type: 'wheel', listener: (event: CarViewerWheelEventLike) => void, options?: AddEventListenerOptions): void;
  removeEventListener(type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel', listener: (event: CarViewerPointerEventLike) => void): void;
  removeEventListener(type: 'wheel', listener: (event: CarViewerWheelEventLike) => void): void;
}

export interface CarViewerRafScheduler {
  request(callback: (timestampMs: number) => void): number;
  cancel(id: number): void;
}

export interface CarViewerDebugStats {
  readonly fps: number;
  readonly gpuResources: GpuResourceCounts;
  readonly cacheStats: AssetRepositoryCacheStats;
}

export interface CarViewerSessionSnapshot {
  readonly bodyCode: string | null;
  readonly timeOfDay: CarTextureVariant;
  readonly colorSlotIndex: number;
  readonly renderMode: RenderMode;
  readonly ps1Width: number;
  readonly ps1Height: number;
  readonly ps1Dithering: boolean;
  readonly ps1OrderingTable: boolean;
  readonly lodSelection: CarLodSelection;
  readonly activeLodIndex: number;
  readonly wireframe: boolean;
  readonly loading: boolean;
  readonly errorMessage: string | null;
  readonly activeModel: CarModel | null;
  readonly contextLost: boolean;
  readonly restoredCount: number;
  readonly running: boolean;
  readonly disposed: boolean;
  readonly cameraState: OrbitCameraState;
}

export interface LoadCarOptions {
  readonly preserveCamera?: boolean;
  readonly colorSlotIndex?: number;
}

export interface CarViewerSessionOptions {
  readonly glContext: CarViewerGlContextLike;
  readonly gl?: WebGL2CarRendererContext;
  readonly canvas?: CarViewerCanvasInputTarget;
  readonly inputManager: InputManager;
  readonly assetRepository: AssetRepository;
  readonly initialMode?: RenderMode;
  readonly rendererFactory?: (
    gl: WebGL2CarRendererContext,
    options: CarRendererOptions,
  ) => CarRenderer;
  readonly raf?: CarViewerRafScheduler;
  readonly now?: () => number;
  readonly onStateChange?: (snapshot: CarViewerSessionSnapshot) => void;
  readonly onStatsUpdate?: (stats: CarViewerDebugStats) => void;
}

const MAX_FRAME_DT_SECONDS = 0.1;
const FPS_WINDOW_MS = 250;

/**
 * Selects the appropriate LOD index from camera distance using `lod.maxDistance` thresholds
 * verified across all 2,220 CDO/CNO models (`[5, 15, 300]`).
 */
export function resolveAutoLodIndex(
  distanceMeters: number,
  lods: readonly CarModelLod[],
): number {
  if (lods.length === 0) {
    return 0;
  }
  for (let i = 0; i < lods.length; i += 1) {
    const lod = lods[i];
    if (lod !== undefined && distanceMeters <= lod.maxDistance) {
      return i;
    }
  }
  return lods.length - 1;
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
 * Coordinates `CarRenderer`, `OrbitCamera`, `InputManager` (`viewer` context),
 * pointer/touch orbit & wheel zoom, `AssetRepository` loading, and rAF rendering (`M7.7`).
 */
export class CarViewerSession {
  private readonly glContext: CarViewerGlContextLike;
  private readonly gl: WebGL2CarRendererContext;
  private readonly canvas: CarViewerCanvasInputTarget | undefined;
  private readonly inputManager: InputManager;
  private readonly assetRepository: AssetRepository;
  private readonly rendererFactory: (
    gl: WebGL2CarRendererContext,
    options: CarRendererOptions,
  ) => CarRenderer;
  private readonly raf: CarViewerRafScheduler;
  private readonly now: () => number;
  private readonly onStateChange: ((snapshot: CarViewerSessionSnapshot) => void) | undefined;
  private readonly onStatsUpdate: ((stats: CarViewerDebugStats) => void) | undefined;

  public readonly camera = new OrbitCamera();

  private renderer: CarRenderer | null = null;
  private activeModel: CarModel | null = null;
  private bodyCode: string | null = null;
  private timeOfDay: CarTextureVariant = 'day';
  private colorSlotIndex = 0;
  private renderMode: RenderMode;
  private ps1Width = DEFAULT_PS1_WIDTH;
  private ps1Height = DEFAULT_PS1_HEIGHT;
  private ps1Dithering = true;
  private ps1OrderingTable = false;
  private lodSelection: CarLodSelection = 'auto';
  private activeLodIndex = 0;
  private wireframe = false;
  private loading = false;
  private errorMessage: string | null = null;
  private contextLost = false;
  private restoredCount = 0;
  private running = false;
  private disposed = false;

  private loadGeneration = 0;
  private activeLoadAbort: AbortController | null = null;
  private rafId: number | null = null;
  private lastTickMs: number | null = null;
  private fpsWindowStartMs = 0;
  private fpsFrameCount = 0;
  private currentFps = 0;

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
      this.camera.orbitByPixels(dx, dy, viewportHeight);
      return;
    }

    if (this.activePointers.size >= 2) {
      const pointsBefore = Array.from(this.activePointers.entries());
      const otherEntry = pointsBefore.find(([id]) => id !== event.pointerId);
      if (otherEntry === undefined) {
        prev.x = event.clientX;
        prev.y = event.clientY;
        return;
      }
      const other = otherEntry[1];
      const prevDist = Math.hypot(prev.x - other.x, prev.y - other.y);
      prev.x = event.clientX;
      prev.y = event.clientY;
      const nextDist = Math.hypot(prev.x - other.x, prev.y - other.y);
      if (prevDist > 1 && nextDist > 1) {
        this.camera.zoomByFactor(prevDist / nextDist);
      }
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
    this.camera.zoomByWheel(event.deltaY);
  };

  public constructor(options: CarViewerSessionOptions) {
    this.glContext = options.glContext;
    this.gl = options.gl ?? (options.glContext.gl as unknown as WebGL2CarRendererContext);
    this.canvas = options.canvas;
    this.inputManager = options.inputManager;
    this.assetRepository = options.assetRepository;
    this.renderMode = options.initialMode ?? 'hd';
    this.rendererFactory =
      options.rendererFactory ?? ((gl, rendererOpts) => new CarRenderer(gl, rendererOpts));
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
  }

  public start(): void {
    if (this.disposed || this.running) {
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

  public async loadCar(
    bodyCode: string,
    timeOfDay: CarTextureVariant,
    options: LoadCarOptions = {},
  ): Promise<CarModel | null> {
    if (this.disposed) {
      return null;
    }

    const normalizedCode = bodyCode.trim().toLowerCase();
    this.loadGeneration += 1;
    const generation = this.loadGeneration;

    if (this.activeLoadAbort !== null) {
      this.activeLoadAbort.abort('Superseded by newer car selection');
    }
    const controller = new AbortController();
    this.activeLoadAbort = controller;

    this.bodyCode = normalizedCode;
    this.timeOfDay = timeOfDay;
    this.loading = true;
    this.errorMessage = null;
    this.emitStateChange();

    try {
      const model = await this.assetRepository.getCarModel(normalizedCode, timeOfDay, {
        signal: controller.signal,
      });
      if (this.disposed || generation !== this.loadGeneration) {
        return null;
      }

      const maxSlot = Math.max(0, (model.texture?.source.colorCount ?? 1) - 1);
      const requestedSlot = options.colorSlotIndex ?? 0;
      const safeSlot = Math.min(Math.max(0, requestedSlot), maxSlot);

      this.activeModel = model;
      this.colorSlotIndex = safeSlot;
      this.loading = false;
      this.errorMessage = null;

      if (options.preserveCamera !== true) {
        this.camera.fitToCarModel(model, 0);
      }

      this.activeLodIndex = this.computeTargetLodIndex(model);

      if (!this.contextLost && !this.glContext.isContextLost()) {
        const renderer = this.ensureRenderer();
        renderer.setCar(model, {
          lodIndex: this.activeLodIndex,
          colorSlotIndex: this.colorSlotIndex,
        });
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
      this.errorMessage =
        error instanceof Error ? error.message : 'Nie udało się wczytać modelu 3D auta.';
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

  public setPaintSlot(colorSlotIndex: number): void {
    if (this.disposed || this.activeModel === null || this.activeModel.texture === null) {
      return;
    }
    const maxSlot = Math.max(0, this.activeModel.texture.source.colorCount - 1);
    const clamped = Math.min(Math.max(0, Math.trunc(colorSlotIndex)), maxSlot);
    if (clamped === this.colorSlotIndex) {
      return;
    }
    this.colorSlotIndex = clamped;
    this.renderer?.setPaintSlot(clamped);
    this.emitStateChange();
  }

  public setLodSelection(selection: CarLodSelection): void {
    if (this.disposed || this.lodSelection === selection) {
      return;
    }
    this.lodSelection = selection;
    if (this.activeModel !== null) {
      const targetLod = this.computeTargetLodIndex(this.activeModel);
      this.activeLodIndex = targetLod;
      if (this.renderer !== null && this.renderer.getMesh() !== null) {
        this.renderer.setLod(targetLod);
      }
    }
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

  public setPs1OrderingTable(enabled: boolean): void {
    if (this.disposed || this.ps1OrderingTable === enabled) {
      return;
    }
    this.ps1OrderingTable = enabled;
    this.renderer?.setDrawOrderMode(enabled ? 'ordering-table-experimental' : 'zbuffer');
    this.emitStateChange();
  }

  public setWireframe(enabled: boolean): void {
    if (this.disposed || this.wireframe === enabled) {
      return;
    }
    this.wireframe = enabled;
    this.emitStateChange();
  }

  public resetCamera(): void {
    if (this.disposed) {
      return;
    }
    this.camera.reset();
    this.emitStateChange();
  }

  public nextCameraPreset(): number {
    if (this.disposed) {
      return 0;
    }
    const idx = this.camera.nextPreset();
    this.emitStateChange();
    return idx;
  }

  public stepFrame(dtSeconds: number): void {
    if (this.disposed || this.contextLost || this.glContext.isContextLost()) {
      return;
    }
    this.camera.updateFromInput(this.inputManager, dtSeconds);
    this.renderCurrentFrame();
  }

  public renderCurrentFrame(): void {
    if (this.disposed || this.contextLost || this.glContext.isContextLost()) {
      return;
    }
    if (this.activeModel === null || this.renderer === null || this.renderer.getMesh() === null) {
      this.glContext.clear();
      return;
    }

    const { width, height } = this.glContext.getSize();
    const safeW = Math.max(1, width);
    const safeH = Math.max(1, height);

    if (this.lodSelection === 'auto') {
      const targetLod = this.computeTargetLodIndex(this.activeModel);
      if (targetLod !== this.activeLodIndex) {
        this.activeLodIndex = targetLod;
        this.renderer.setLod(targetLod);
      }
    }

    this.camera.setAspect(
      this.renderMode === 'ps1' ? DEFAULT_PS1_DISPLAY_ASPECT : safeW / safeH,
    );

    this.renderer.render(this.camera, safeW, safeH, {
      wireframe: this.wireframe,
      ps1: {
        dithering: this.ps1Dithering,
        quantize15Bit: this.ps1Dithering,
        drawOrderMode: this.ps1OrderingTable ? 'ordering-table-experimental' : 'zbuffer',
      },
    });
  }

  public getGpuResourceCounts(): GpuResourceCounts {
    if (this.disposed || this.contextLost || this.renderer === null) {
      return EMPTY_GPU_RESOURCE_COUNTS;
    }
    return this.renderer.getResourceCounts();
  }

  public getSnapshot(): CarViewerSessionSnapshot {
    return {
      bodyCode: this.bodyCode,
      timeOfDay: this.timeOfDay,
      colorSlotIndex: this.colorSlotIndex,
      renderMode: this.renderMode,
      ps1Width: this.ps1Width,
      ps1Height: this.ps1Height,
      ps1Dithering: this.ps1Dithering,
      ps1OrderingTable: this.ps1OrderingTable,
      lodSelection: this.lodSelection,
      activeLodIndex: this.activeLodIndex,
      wireframe: this.wireframe,
      loading: this.loading,
      errorMessage: this.errorMessage,
      activeModel: this.activeModel,
      contextLost: this.contextLost,
      restoredCount: this.restoredCount,
      running: this.running,
      disposed: this.disposed,
      cameraState: this.camera.getState(),
    };
  }

  public getDebugStats(): CarViewerDebugStats {
    return {
      fps: this.currentFps,
      gpuResources: this.getGpuResourceCounts(),
      cacheStats: this.assetRepository.getCacheStats(),
    };
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.pause();
    this.loadGeneration += 1;
    if (this.activeLoadAbort !== null) {
      this.activeLoadAbort.abort('CarViewerSession disposed');
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

  private ensureRenderer(): CarRenderer {
    if (this.renderer !== null && !this.renderer.isDisposed()) {
      return this.renderer;
    }
    this.renderer = this.rendererFactory(this.gl, {
      initialMode: this.renderMode,
      drawOrderMode: this.ps1OrderingTable ? 'ordering-table-experimental' : 'zbuffer',
      ps1: {
        internalWidth: this.ps1Width,
        internalHeight: this.ps1Height,
      },
    });
    return this.renderer;
  }

  private computeTargetLodIndex(model: CarModel): number {
    const maxIndex = Math.max(0, model.lods.length - 1);
    if (this.lodSelection === 'auto') {
      return Math.min(maxIndex, resolveAutoLodIndex(this.camera.getState().distance, model.lods));
    }
    return Math.min(maxIndex, this.lodSelection);
  }

  private scheduleNextFrame(): void {
    if (this.disposed || !this.running || this.rafId !== null) {
      return;
    }
    this.rafId = this.raf.request((timestampMs) => {
      this.rafId = null;
      if (this.disposed || !this.running) {
        return;
      }
      const prev = this.lastTickMs;
      const dtSeconds =
        prev === null
          ? 0
          : Math.min(MAX_FRAME_DT_SECONDS, Math.max(0, (timestampMs - prev) / 1000));
      this.lastTickMs = timestampMs;

      this.stepFrame(dtSeconds);
      this.updateFps(timestampMs);
      this.scheduleNextFrame();
    });
  }

  private updateFps(timestampMs: number): void {
    this.fpsFrameCount += 1;
    const elapsed = timestampMs - this.fpsWindowStartMs;
    if (elapsed >= FPS_WINDOW_MS) {
      this.currentFps = Math.round((this.fpsFrameCount * 1000) / Math.max(1, elapsed));
      this.fpsWindowStartMs = timestampMs;
      this.fpsFrameCount = 0;
      this.emitDebugStats();
    }
  }

  private emitStateChange(): void {
    this.onStateChange?.(this.getSnapshot());
  }

  private emitDebugStats(): void {
    this.onStatsUpdate?.(this.getDebugStats());
  }
}
