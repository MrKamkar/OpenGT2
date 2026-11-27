import type { AssetRepository, AssetRepositoryCacheStats } from '../assets';
import type { GamepadProvider, InputManager } from '../core/input';
import type { CarModel } from '../formats/car';
import type { CarCatalogEntry } from '../formats/gtdb';
import type { IndexedImage } from '../formats/ps1';
import {
  COLLISION_SURFACE_GROUND,
  type TrackModel,
  type TrackSegmentInfo,
} from '../formats/track';
import {
  type CarPhysicsSpec,
  CollisionIndex,
  DriveControlAdapter,
  type PhysicsVec3,
  type TransmissionMode,
  type VehiclePose,
  VehicleSimulation,
  buildCarPhysicsSpec,
} from '../physics';
import type { RenderMode } from './carRenderer';
import type {
  CarViewerGlContextLike,
  CarViewerPixelSample,
  CarViewerRafScheduler,
} from './carViewerSession';
import { ChaseCamera, type ChaseCameraPresetId } from './chaseCamera';
import {
  DriveRenderer,
  type DriveRendererOptions,
  type DriveRenderStats,
  EMPTY_DRIVE_RENDER_STATS,
  type WebGL2DriveRendererContext,
} from './driveRenderer';
import { DEFAULT_PS1_DISPLAY_ASPECT, DEFAULT_PS1_HEIGHT, DEFAULT_PS1_WIDTH } from './ps1Math';
import {
  EMPTY_GPU_RESOURCE_COUNTS,
  GL_NO_ERROR_CODE,
  type GlErrorStatus,
  type GpuResourceCounts,
} from './types';
import { type DriveWheelRenderTuple, hasCdpWheelPalette } from './wheelMesh';

export interface DriveSpawnPose {
  readonly position: PhysicsVec3;
  readonly yawRad: number;
}

export interface DriveTelemetrySnapshot {
  readonly speedKph: number;
  readonly speedMps: number;
  readonly forwardSpeedMps: number;
  readonly gear: number;
  readonly engineRpm: number;
  readonly idleRpm: number;
  readonly redlineRpm: number;
  readonly elapsedSeconds: number;
  readonly groundedWheels: number;
  readonly maxSlipRatio: number;
  readonly maxSlipAngleDeg: number;
  readonly wallCollisionCount: number;
  readonly cameraPreset: ChaseCameraPresetId;
  readonly transmissionMode: TransmissionMode;
  readonly paused: boolean;
  readonly muted: boolean;
  readonly gamepadConnected: boolean;
  readonly pose: VehiclePose;
}

export interface DriveDebugStats {
  readonly fps: number;
  readonly renderStats: DriveRenderStats;
  readonly gpuResources: GpuResourceCounts;
  readonly glError: GlErrorStatus;
  readonly glErrorCount: number;
  readonly carCacheStats: AssetRepositoryCacheStats;
  readonly trackCacheStats: AssetRepositoryCacheStats;
}

export interface DriveSessionSnapshot {
  readonly carId: number | null;
  readonly bodyCode: string | null;
  readonly trackStem: string | null;
  readonly colorSlotIndex: number;
  readonly renderMode: RenderMode;
  readonly ps1Width: number;
  readonly ps1Height: number;
  readonly ps1Dithering: boolean;
  readonly ps1VertexSnap: boolean;
  readonly ps1AffineMapping: boolean;
  readonly wireframe: boolean;
  readonly transmissionMode: TransmissionMode;
  readonly cameraPreset: ChaseCameraPresetId;
  readonly paused: boolean;
  readonly muted: boolean;
  readonly loading: boolean;
  readonly loadProgress: number;
  readonly loadStageLabel: string | null;
  readonly errorMessage: string | null;
  readonly ready: boolean;
  readonly activeCarModel: CarModel | null;
  readonly activeTrackModel: TrackModel | null;
  readonly activePhysicsSpec: CarPhysicsSpec | null;
  readonly contextLost: boolean;
  readonly restoredCount: number;
  readonly running: boolean;
  readonly disposed: boolean;
}

export interface DriveSessionOptions {
  readonly glContext: CarViewerGlContextLike;
  readonly gl?: WebGL2DriveRendererContext;
  readonly inputManager: InputManager;
  readonly assetRepository: AssetRepository;
  readonly gamepadProvider?: GamepadProvider;
  readonly initialMode?: RenderMode;
  readonly rendererFactory?: (
    gl: WebGL2DriveRendererContext,
    options: DriveRendererOptions,
  ) => DriveRenderer;
  readonly raf?: CarViewerRafScheduler;
  readonly now?: () => number;
  readonly onStateChange?: (snapshot: DriveSessionSnapshot) => void;
  readonly onTelemetryUpdate?: (telemetry: DriveTelemetrySnapshot) => void;
  readonly onStatsUpdate?: (stats: DriveDebugStats) => void;
}

const MAX_FRAME_DT_SECONDS = 0.1;
const FPS_WINDOW_MS = 250;
const RAD_TO_DEG = 180 / Math.PI;

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

function computeSegmentGroundPoint(
  track: TrackModel,
  segment: TrackSegmentInfo,
): PhysicsVec3 {
  if (track.collision !== undefined) {
    const colSeg = track.collision.segments[segment.segmentIndex];
    if (colSeg !== undefined && colSeg.triangleCount > 0) {
      let sx = 0;
      let sy = 0;
      let sz = 0;
      let count = 0;
      const endTri = colSeg.triangleStart + colSeg.triangleCount;
      for (let ti = colSeg.triangleStart; ti < endTri; ti += 1) {
        if (track.collision.surfaceTypes[ti] !== COLLISION_SURFACE_GROUND) {
          continue;
        }
        const base = ti * 9;
        sx +=
          ((track.collision.vertices[base] ?? 0) +
            (track.collision.vertices[base + 3] ?? 0) +
            (track.collision.vertices[base + 6] ?? 0)) /
          3;
        sy +=
          ((track.collision.vertices[base + 1] ?? 0) +
            (track.collision.vertices[base + 4] ?? 0) +
            (track.collision.vertices[base + 7] ?? 0)) /
          3;
        sz +=
          ((track.collision.vertices[base + 2] ?? 0) +
            (track.collision.vertices[base + 5] ?? 0) +
            (track.collision.vertices[base + 8] ?? 0)) /
          3;
        count += 1;
      }
      if (count > 0) {
        return { x: sx / count, y: sy / count, z: sz / count };
      }
    }
  }
  return {
    x: (segment.bounds.min.x + segment.bounds.max.x) * 0.5,
    y: segment.bounds.min.y,
    z: (segment.bounds.min.z + segment.bounds.max.z) * 0.5,
  };
}

/**
 * Deterministically finds a grounded spawn pose on `track` using `startGrid[0]` if available
 * or a downward ground raycast onto the first renderable segment aimed toward `nextSegment` (`M9.9`).
 */
export function findTrackSpawnPose(
  track: TrackModel,
  collisionIndex: CollisionIndex,
  comHeightMeters: number,
): DriveSpawnPose {
  const gridPose = track.startGrid[0];
  if (gridPose !== undefined) {
    const horizLen = Math.hypot(gridPose.forward.x, gridPose.forward.z);
    const fx = horizLen > 1e-4 ? gridPose.forward.x / horizLen : 0;
    const fz = horizLen > 1e-4 ? gridPose.forward.z / horizLen : -1;
    const hit = collisionIndex.raycastWheelDown(
      { x: gridPose.position.x, y: gridPose.position.y + 4, z: gridPose.position.z },
      { x: 0, y: -1, z: 0 },
      24,
    );
    const baseY = hit !== null ? hit.point.y : gridPose.position.y;
    return {
      position: { x: gridPose.position.x, y: baseY + comHeightMeters + 0.05, z: gridPose.position.z },
      yawRad: Math.atan2(-fx, -fz),
    };
  }

  for (let i = 0; i < track.segments.length; i += 1) {
    const seg = track.segments[i]!;
    if (seg.primaryPartCount === 0) {
      continue;
    }

    const origin = computeSegmentGroundPoint(track, seg);
    const spanY = Math.max(10, seg.bounds.max.y - seg.bounds.min.y + 12);
    const hit = collisionIndex.raycastWheelDown(
      { x: origin.x, y: seg.bounds.max.y + 4, z: origin.z },
      { x: 0, y: -1, z: 0 },
      spanY + 12,
    );
    if (hit === null || hit.normal.y < 0.7) {
      continue;
    }

    let nextSeg = track.segments[seg.nextSegment];
    if (nextSeg === undefined || nextSeg.segmentIndex === seg.segmentIndex || nextSeg.primaryPartCount === 0) {
      const nextIdx = track.segments.length > 1 ? (i + 1) % track.segments.length : i;
      nextSeg = track.segments[nextIdx];
    }

    let fx = 0;
    let fz = -1;
    if (nextSeg !== undefined && nextSeg.segmentIndex !== seg.segmentIndex) {
      const nextPt = computeSegmentGroundPoint(track, nextSeg);
      const dx = nextPt.x - origin.x;
      const dz = nextPt.z - origin.z;
      const len = Math.hypot(dx, dz);
      if (len > 1e-3) {
        fx = dx / len;
        fz = dz / len;
      }
    }

    return {
      position: { x: hit.point.x, y: hit.point.y + comHeightMeters + 0.05, z: hit.point.z },
      yawRad: Math.atan2(-fx, -fz),
    };
  }

  const cx = (track.bounds.min.x + track.bounds.max.x) * 0.5;
  const cz = (track.bounds.min.z + track.bounds.max.z) * 0.5;
  const fallbackHit = collisionIndex.raycastWheelDown(
    { x: cx, y: track.bounds.max.y + 8, z: cz },
    { x: 0, y: -1, z: 0 },
    Math.max(24, track.bounds.max.y - track.bounds.min.y + 24),
  );
  return {
    position: {
      x: cx,
      y: (fallbackHit !== null ? fallbackHit.point.y : track.bounds.min.y) + comHeightMeters + 0.05,
      z: cz,
    },
    yawRad: 0,
  };
}

/**
 * Coordinates combined Track + Car Drive Mode (`M9.9`):
 * `DriveControlAdapter` (`race` context + optional Gamepad), fixed-120 Hz `VehicleSimulation`,
 * damped `ChaseCamera`, combined `DriveRenderer` (HD + PS1), HUD telemetry, and
 * isolated `webglcontextlost`/`restored` recovery from `AssetRepository` cache.
 */
export class DriveSession {
  private readonly glContext: CarViewerGlContextLike;
  private readonly gl: WebGL2DriveRendererContext;
  private readonly inputManager: InputManager;
  private readonly assetRepository: AssetRepository;
  private readonly controlsAdapter: DriveControlAdapter;
  private readonly rendererFactory: (
    gl: WebGL2DriveRendererContext,
    options: DriveRendererOptions,
  ) => DriveRenderer;
  private readonly raf: CarViewerRafScheduler;
  private readonly now: () => number;
  private readonly onStateChange: ((snapshot: DriveSessionSnapshot) => void) | undefined;
  private readonly onTelemetryUpdate: ((telemetry: DriveTelemetrySnapshot) => void) | undefined;
  private readonly onStatsUpdate: ((stats: DriveDebugStats) => void) | undefined;

  public readonly camera = new ChaseCamera();

  private renderer: DriveRenderer | null = null;
  private carEntry: CarCatalogEntry | null = null;
  private bodyCode: string | null = null;
  private trackStem: string | null = null;
  private activeCarModel: CarModel | null = null;
  private activeWheelFallbackTexture: IndexedImage | null = null;
  private activeTrackModel: TrackModel | null = null;
  private activePhysicsSpec: CarPhysicsSpec | null = null;
  private collisionIndex: CollisionIndex | null = null;
  private simulation: VehicleSimulation | null = null;
  private spawnPose: DriveSpawnPose = { position: { x: 0, y: 0.5, z: 0 }, yawRad: 0 };

  private colorSlotIndex = 0;
  private renderMode: RenderMode;
  private ps1Width = DEFAULT_PS1_WIDTH;
  private ps1Height = DEFAULT_PS1_HEIGHT;
  private ps1Dithering = true;
  private ps1VertexSnap = true;
  private ps1AffineMapping = true;
  private wireframe = false;
  private transmissionMode: TransmissionMode = 'auto';
  private paused = false;
  private muted = false;
  private gamepadConnected = false;
  private elapsedSeconds = 0;

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
  private lastRenderStats: DriveRenderStats = EMPTY_DRIVE_RENDER_STATS;
  private lastGlError: GlErrorStatus = {
    code: GL_NO_ERROR_CODE,
    name: 'NO_ERROR',
    hasError: false,
  };
  private glErrorCount = 0;
  private readonly removeContextListener: (() => void) | null = null;

  public constructor(options: DriveSessionOptions) {
    this.glContext = options.glContext;
    this.gl = options.gl ?? (options.glContext.gl as unknown as WebGL2DriveRendererContext);
    this.inputManager = options.inputManager;
    this.assetRepository = options.assetRepository;
    this.controlsAdapter = new DriveControlAdapter({
      inputManager: options.inputManager,
      ...(options.gamepadProvider !== undefined ? { gamepadProvider: options.gamepadProvider } : {}),
    });
    this.renderMode = options.initialMode ?? 'hd';
    this.rendererFactory =
      options.rendererFactory ?? ((gl, rendererOpts) => new DriveRenderer(gl, rendererOpts));
    this.raf = options.raf ?? defaultRafScheduler();
    this.now = options.now ?? defaultNow;
    this.onStateChange = options.onStateChange;
    this.onTelemetryUpdate = options.onTelemetryUpdate;
    this.onStatsUpdate = options.onStatsUpdate;
    this.contextLost = this.glContext.isContextLost();

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
    this.controlsAdapter.resetLatches();
    this.lastTickMs = null;
    this.fpsWindowStartMs = this.now();
    this.fpsFrameCount = 0;
    this.scheduleNextFrame();
    this.emitStateChange();
    this.emitTelemetry();
  }

  public pause(): void {
    this.pausedByContextLoss = false;
    if (!this.running) {
      return;
    }
    this.running = false;
    this.controlsAdapter.resetLatches();
    if (this.rafId !== null) {
      this.raf.cancel(this.rafId);
      this.rafId = null;
    }
    this.lastTickMs = null;
    this.emitStateChange();
  }

  public setPaused(paused: boolean): void {
    if (this.disposed || this.paused === paused) {
      return;
    }
    this.paused = paused;
    this.inputManager.releaseAll();
    this.lastTickMs = null;
    if (paused) {
      this.renderCurrentFrame();
    }
    this.emitStateChange();
    this.emitTelemetry();
  }

  public togglePaused(): void {
    this.setPaused(!this.paused);
  }

  public setMuted(muted: boolean): void {
    if (this.disposed || this.muted === muted) {
      return;
    }
    this.muted = muted;
    this.emitStateChange();
    this.emitTelemetry();
  }

  public setTransmissionMode(mode: TransmissionMode): void {
    if (this.disposed || this.transmissionMode === mode) {
      return;
    }
    this.transmissionMode = mode;
    this.simulation?.setTransmissionMode(mode);
    this.emitStateChange();
    this.emitTelemetry();
  }

  public cycleCamera(): ChaseCameraPresetId {
    const preset = this.camera.cyclePreset();
    if (this.simulation !== null) {
      this.camera.snapToPose(this.simulation.getPose());
    }
    this.renderCurrentFrame();
    this.emitStateChange();
    this.emitTelemetry();
    return preset;
  }

  public resetCar(): void {
    if (this.disposed || this.simulation === null) {
      return;
    }
    this.simulation.reset(this.spawnPose.position, this.spawnPose.yawRad);
    this.elapsedSeconds = 0;
    this.inputManager.releaseAll();
    this.camera.snapToPose(this.simulation.getPose());
    this.renderCurrentFrame();
    this.emitTelemetry();
  }

  public setRenderMode(mode: RenderMode): void {
    if (this.disposed || this.renderMode === mode) {
      return;
    }
    this.renderMode = mode;
    this.renderer?.setMode(mode);
    this.renderCurrentFrame();
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
    this.renderCurrentFrame();
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

  public setPaintSlot(slotIndex: number): void {
    if (this.disposed || this.colorSlotIndex === slotIndex) {
      return;
    }
    this.colorSlotIndex = slotIndex;
    this.renderer?.setPaintSlot(slotIndex);
    this.emitStateChange();
  }

  /**
   * Loads the selected car + track pair via `AssetRepository` (`includeCollision: true`),
   * constructs `CarPhysicsSpec` and `CollisionIndex`, spawns `VehicleSimulation`, and
   * snaps `ChaseCamera` cleanly behind the vehicle.
   */
  public async loadSession(params: {
    readonly carEntry: CarCatalogEntry;
    readonly bodyCode: string;
    readonly trackStem: string;
    readonly colorSlotIndex?: number;
  }): Promise<boolean> {
    if (this.disposed) {
      return false;
    }

    const normalizedBody = params.bodyCode.trim().toLowerCase();
    const normalizedStem = params.trackStem.trim().toLowerCase();
    const requestedSlot = params.colorSlotIndex ?? 0;

    this.loadGeneration += 1;
    const generation = this.loadGeneration;

    if (this.activeLoadAbort !== null) {
      this.activeLoadAbort.abort('Superseded by newer Drive selection');
    }
    const controller = new AbortController();
    this.activeLoadAbort = controller;

    this.carEntry = params.carEntry;
    this.bodyCode = normalizedBody;
    this.trackStem = normalizedStem;
    this.colorSlotIndex = requestedSlot;
    this.loading = true;
    this.loadProgress = 0.05;
    this.loadStageLabel = `Loading ${normalizedBody} & ${normalizedStem}…`;
    this.errorMessage = null;
    this.emitStateChange();

    try {
      const carPromise = this.assetRepository.getCarModel(normalizedBody, 'day', {
        signal: controller.signal,
      });
      const trackPromise = this.assetRepository.getTrackModel(normalizedStem, {
        signal: controller.signal,
        includeCollision: true,
        onProgress: (prog) => {
          if (this.disposed || generation !== this.loadGeneration) {
            return;
          }
          this.loadProgress = Math.max(0.05, Math.min(0.95, prog.progress));
          this.loadStageLabel = prog.label;
          this.emitStateChange();
        },
      });

      const [carModel, trackModel] = await Promise.all([carPromise, trackPromise]);
      if (this.disposed || generation !== this.loadGeneration) {
        return false;
      }
      if (trackModel.collision === undefined) {
        throw new Error(`Track "${normalizedStem}" does not contain collision geometry.`);
      }

      const maxSlots = carModel.texture?.source.colorCount ?? 1;
      const clampedSlot = Math.max(0, Math.min(requestedSlot, Math.max(0, maxSlots - 1)));

      let wheelFallbackTexture: IndexedImage | null = null;
      if (
        !hasCdpWheelPalette(carModel, clampedSlot) &&
        this.assetRepository.wheelAssetIndex.getCount() > 0
      ) {
        const wheelPath = this.assetRepository.wheelAssetIndex.getPathByIndex(params.carEntry.carId);
        if (wheelPath !== null) {
          wheelFallbackTexture = await this.assetRepository.getWheelTexture(wheelPath, {
            signal: controller.signal,
          });
          if (this.disposed || generation !== this.loadGeneration) {
            return false;
          }
        }
      }

      const spec = buildCarPhysicsSpec(params.carEntry, { carModel });
      const colIndex = new CollisionIndex(trackModel.collision);
      const spawn = findTrackSpawnPose(trackModel, colIndex, spec.comHeightMeters);
      const sim = new VehicleSimulation(spec, colIndex, {
        initialPosition: spawn.position,
        initialYawRad: spawn.yawRad,
        transmissionMode: this.transmissionMode,
      });

      this.activeCarModel = carModel;
      this.activeWheelFallbackTexture = wheelFallbackTexture;
      this.activeTrackModel = trackModel;
      this.activePhysicsSpec = spec;
      this.collisionIndex = colIndex;
      this.spawnPose = spawn;
      this.simulation = sim;
      this.colorSlotIndex = clampedSlot;
      this.elapsedSeconds = 0;
      this.paused = false;
      this.loading = false;
      this.loadProgress = 1;
      this.loadStageLabel = null;
      this.errorMessage = null;

      this.controlsAdapter.resetLatches();
      this.camera.snapToPose(sim.getPose());

      if (this.running && !this.contextLost && !this.glContext.isContextLost()) {
        const renderer = this.ensureRenderer();
        renderer.setTrack(trackModel);
        renderer.setCar(carModel, { lodIndex: 0, colorSlotIndex: clampedSlot });
        renderer.setWheelFallbackTexture(wheelFallbackTexture);
      } else {
        this.renderer?.dispose();
        this.renderer = null;
      }

      this.renderCurrentFrame();
      this.emitStateChange();
      this.emitTelemetry();
      this.emitDebugStats();
      return true;
    } catch (error: unknown) {
      if (this.disposed || generation !== this.loadGeneration) {
        return false;
      }
      if (error instanceof Error && error.name === 'AbortError') {
        return false;
      }
      this.loading = false;
      this.loadProgress = 0;
      this.loadStageLabel = null;
      this.errorMessage =
        error instanceof Error ? error.message : 'Failed to initialize Drive session.';
      this.emitStateChange();
      return false;
    } finally {
      if (this.activeLoadAbort === controller) {
        this.activeLoadAbort = null;
      }
    }
  }

  public stepFrame(dtSeconds: number): void {
    if (this.disposed || this.contextLost || this.glContext.isContextLost()) {
      return;
    }

    const safeDt =
      Number.isFinite(dtSeconds) && dtSeconds > 0
        ? Math.min(dtSeconds, MAX_FRAME_DT_SECONDS)
        : 0;
    const currentSpeedMps = this.simulation?.getSnapshot().speedMps ?? 0;
    const frameInput = this.controlsAdapter.step(safeDt, currentSpeedMps);
    this.gamepadConnected = frameInput.gamepadConnected;

    if (frameInput.edges.mute) {
      this.setMuted(!this.muted);
    }
    if (frameInput.edges.pause) {
      this.togglePaused();
    }
    if (frameInput.edges.cameraNext) {
      this.cycleCamera();
    }
    if (frameInput.edges.resetCar) {
      this.resetCar();
      return;
    }

    let renderPose: VehiclePose | null = null;
    if (this.simulation !== null && !this.loading) {
      if (!this.paused) {
        const updateOut = this.simulation.update(safeDt, frameInput.controls);
        this.elapsedSeconds += safeDt;
        renderPose = updateOut.interpolatedPose;
        this.camera.update(renderPose, safeDt, this.simulation.getSnapshot().linearVelocity);
      } else {
        renderPose = this.simulation.getPose();
      }
    }

    this.renderCurrentFrame(renderPose ?? undefined);
    this.emitTelemetry();
  }

  public renderCurrentFrame(poseOverride?: VehiclePose): void {
    if (this.disposed || this.contextLost || this.glContext.isContextLost()) {
      return;
    }
    if (
      this.activeTrackModel === null ||
      this.activeCarModel === null ||
      this.activePhysicsSpec === null ||
      this.simulation === null
    ) {
      this.glContext.clear();
      return;
    }

    let renderer = this.renderer;
    if (renderer === null || renderer.isDisposed()) {
      renderer = this.ensureRenderer();
      renderer.setTrack(this.activeTrackModel);
      renderer.setCar(this.activeCarModel, {
        lodIndex: 0,
        colorSlotIndex: this.colorSlotIndex,
      });
      renderer.setWheelFallbackTexture(this.activeWheelFallbackTexture);
    }

    const { width, height } = this.glContext.getSize();
    const safeW = Math.max(1, width);
    const safeH = Math.max(1, height);

    this.camera.setAspect(
      this.renderMode === 'ps1' ? DEFAULT_PS1_DISPLAY_ASPECT : safeW / safeH,
    );

    const simSnapshot = this.simulation.getSnapshot();
    const wheelStates: DriveWheelRenderTuple = [
      {
        suspensionDeltaMeters: simSnapshot.wheels[0].suspensionDeltaMeters,
        steerAngleRad: simSnapshot.wheels[0].steerAngleRad,
        spinAngleRad: simSnapshot.wheels[0].spinAngleRad,
      },
      {
        suspensionDeltaMeters: simSnapshot.wheels[1].suspensionDeltaMeters,
        steerAngleRad: simSnapshot.wheels[1].steerAngleRad,
        spinAngleRad: simSnapshot.wheels[1].spinAngleRad,
      },
      {
        suspensionDeltaMeters: simSnapshot.wheels[2].suspensionDeltaMeters,
        steerAngleRad: simSnapshot.wheels[2].steerAngleRad,
        spinAngleRad: simSnapshot.wheels[2].spinAngleRad,
      },
      {
        suspensionDeltaMeters: simSnapshot.wheels[3].suspensionDeltaMeters,
        steerAngleRad: simSnapshot.wheels[3].steerAngleRad,
        spinAngleRad: simSnapshot.wheels[3].spinAngleRad,
      },
    ];
    const pose = poseOverride ?? simSnapshot.pose;
    this.lastRenderStats = renderer.render(
      this.camera,
      pose,
      this.activePhysicsSpec.comHeightMeters,
      safeW,
      safeH,
      {
        wireframe: this.wireframe,
        ps1VertexSnap: this.ps1VertexSnap,
        ps1AffineMapping: this.ps1AffineMapping,
        ps1Dithering: this.ps1Dithering,
        ps1Quantize15Bit: this.ps1Dithering,
        wheelStates,
      },
    );

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

  public getTelemetry(): DriveTelemetrySnapshot {
    const spec = this.activePhysicsSpec;
    if (this.simulation === null || spec === null) {
      return {
        speedKph: 0,
        speedMps: 0,
        forwardSpeedMps: 0,
        gear: 1,
        engineRpm: 0,
        idleRpm: 900,
        redlineRpm: 7000,
        elapsedSeconds: this.elapsedSeconds,
        groundedWheels: 0,
        maxSlipRatio: 0,
        maxSlipAngleDeg: 0,
        wallCollisionCount: 0,
        cameraPreset: this.camera.getPresetId(),
        transmissionMode: this.transmissionMode,
        paused: this.paused,
        muted: this.muted,
        gamepadConnected: this.gamepadConnected,
        pose: {
          position: { ...this.spawnPose.position },
          orientation: { x: 0, y: 0, z: 0, w: 1 },
        },
      };
    }

    const snap = this.simulation.getSnapshot();
    let groundedWheels = 0;
    let maxSlipRatio = 0;
    let maxSlipAngleRad = 0;
    for (const w of snap.wheels) {
      if (w.grounded) {
        groundedWheels += 1;
      }
      maxSlipRatio = Math.max(maxSlipRatio, Math.abs(w.slipRatio));
      maxSlipAngleRad = Math.max(maxSlipAngleRad, Math.abs(w.slipAngleRad));
    }

    return {
      speedKph: snap.speedKph,
      speedMps: snap.speedMps,
      forwardSpeedMps: snap.forwardSpeedMps,
      gear: snap.gear,
      engineRpm: snap.engineRpm,
      idleRpm: spec.engine.idleRpm,
      redlineRpm: spec.engine.redlineRpm,
      elapsedSeconds: this.elapsedSeconds,
      groundedWheels,
      maxSlipRatio,
      maxSlipAngleDeg: maxSlipAngleRad * RAD_TO_DEG,
      wallCollisionCount: snap.wallCollisionCount,
      cameraPreset: this.camera.getPresetId(),
      transmissionMode: this.transmissionMode,
      paused: this.paused,
      muted: this.muted,
      gamepadConnected: this.gamepadConnected,
      pose: snap.pose,
    };
  }

  public getSnapshot(): DriveSessionSnapshot {
    return {
      carId: this.carEntry?.carId ?? null,
      bodyCode: this.bodyCode,
      trackStem: this.trackStem,
      colorSlotIndex: this.colorSlotIndex,
      renderMode: this.renderMode,
      ps1Width: this.ps1Width,
      ps1Height: this.ps1Height,
      ps1Dithering: this.ps1Dithering,
      ps1VertexSnap: this.ps1VertexSnap,
      ps1AffineMapping: this.ps1AffineMapping,
      wireframe: this.wireframe,
      transmissionMode: this.transmissionMode,
      cameraPreset: this.camera.getPresetId(),
      paused: this.paused,
      muted: this.muted,
      loading: this.loading,
      loadProgress: this.loadProgress,
      loadStageLabel: this.loadStageLabel,
      errorMessage: this.errorMessage,
      ready:
        this.activeCarModel !== null &&
        this.activeTrackModel !== null &&
        this.simulation !== null &&
        !this.loading,
      activeCarModel: this.activeCarModel,
      activeTrackModel: this.activeTrackModel,
      activePhysicsSpec: this.activePhysicsSpec,
      contextLost: this.contextLost,
      restoredCount: this.restoredCount,
      running: this.running,
      disposed: this.disposed,
    };
  }

  public getDebugStats(): DriveDebugStats {
    return {
      fps: this.currentFps,
      renderStats: this.lastRenderStats,
      gpuResources: this.getGpuResourceCounts(),
      glError: this.lastGlError,
      glErrorCount: this.glErrorCount,
      carCacheStats: this.assetRepository.getCacheStats(),
      trackCacheStats: this.assetRepository.getTrackCacheStats(),
    };
  }

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
      this.activeLoadAbort.abort('DriveSession disposed');
      this.activeLoadAbort = null;
    }
    this.renderer?.dispose();
    this.renderer = null;
    this.activeCarModel = null;
    this.activeWheelFallbackTexture = null;
    this.activeTrackModel = null;
    this.activePhysicsSpec = null;
    this.collisionIndex = null;
    this.simulation = null;
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

    if (this.bodyCode !== null) {
      this.activeCarModel =
        this.assetRepository.getCachedCarModel(this.bodyCode, 'day') ?? this.activeCarModel;
    }
    if (this.trackStem !== null) {
      this.activeTrackModel =
        this.assetRepository.getCachedTrackModel(this.trackStem) ?? this.activeTrackModel;
    }

    if (this.pausedByContextLoss) {
      if (this.activeTrackModel !== null && this.activeCarModel !== null) {
        const renderer = this.ensureRenderer();
        renderer.setTrack(this.activeTrackModel);
        renderer.setCar(this.activeCarModel, {
          lodIndex: 0,
          colorSlotIndex: this.colorSlotIndex,
        });
        renderer.setWheelFallbackTexture(this.activeWheelFallbackTexture);
      }
      this.pausedByContextLoss = false;
      this.start();
      this.renderCurrentFrame();
    }

    this.emitStateChange();
    this.emitTelemetry();
    this.emitDebugStats();
  }

  private ensureRenderer(): DriveRenderer {
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

  private emitTelemetry(): void {
    this.onTelemetryUpdate?.(this.getTelemetry());
  }

  private emitDebugStats(): void {
    this.onStatsUpdate?.(this.getDebugStats());
  }
}
