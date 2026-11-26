import type { CarModel } from '../formats/car';
import type { OrbitCamera } from './camera';
import type { DrawOrderMode, OrderingTableOptions } from './drawOrder';
import { HdCarTextureArray, HdPipeline, type HdPipelineOptions, type WebGL2HdContext } from './hdPipeline';
import { type IndexedTextureHandle, type WebGL2IndexedTextureContext, uploadIndexedTexture } from './indexedTexture';
import { CarRenderMesh } from './mesh';
import { buildStackedCarPaletteImage, getPaletteRowOffsetForSlot } from './ps1Math';
import {
  Ps1Pipeline,
  type Ps1PipelineOptions,
  type Ps1RenderOptions,
  type WebGL2Ps1Context,
} from './ps1Pipeline';
import {
  EMPTY_GPU_RESOURCE_COUNTS,
  type GlErrorStatus,
  type GpuResourceCounts,
  type WebGL2ErrorContext,
  addResourceCounts,
  pollGlError,
} from './types';

export type RenderMode = 'hd' | 'ps1';

export type WebGL2CarRendererContext = WebGL2Ps1Context &
  WebGL2HdContext &
  WebGL2IndexedTextureContext;

export interface CarRendererOptions {
  readonly initialMode?: RenderMode;
  readonly drawOrderMode?: DrawOrderMode;
  readonly orderingTable?: OrderingTableOptions;
  readonly ps1?: Ps1PipelineOptions;
  readonly hd?: HdPipelineOptions;
}

export interface SetCarOptions {
  readonly lodIndex?: number;
  readonly colorSlotIndex?: number;
}

/**
 * Unified WebGL2 car renderer managing both HD Remaster (`'hd'`, default) and PS1 (`'ps1'`)
 * pipelines over a shared `CarRenderMesh` and in-memory `CarModel`/`CdpTexture` without
 * reloading VOL resources when toggling modes or switching paint slots (`M7.5`).
 */
export class CarRenderer {
  private readonly gl: WebGL2CarRendererContext;
  private readonly ps1Pipeline: Ps1Pipeline;
  private readonly hdPipeline: HdPipeline;

  private mode: RenderMode;
  private drawOrderMode: DrawOrderMode;
  private orderingTable: OrderingTableOptions | undefined;
  private carModel: CarModel | null = null;
  private lodIndex = 0;
  private colorSlotIndex = 0;
  private mesh: CarRenderMesh | null = null;
  private ps1Texture: IndexedTextureHandle | null = null;
  private hdTexture: HdCarTextureArray | null = null;
  private hdTextureDirty = false;
  private disposed = false;

  public constructor(gl: WebGL2CarRendererContext, options: CarRendererOptions = {}) {
    this.gl = gl;
    this.mode = options.initialMode ?? 'hd';
    this.drawOrderMode = options.drawOrderMode ?? options.ps1?.drawOrderMode ?? 'zbuffer';
    this.orderingTable = options.orderingTable ?? options.ps1?.orderingTable;

    let ps1: Ps1Pipeline | null = null;
    let hd: HdPipeline | null = null;
    try {
      ps1 = new Ps1Pipeline(gl, options.ps1);
      hd = new HdPipeline(gl, options.hd);
      this.ps1Pipeline = ps1;
      this.hdPipeline = hd;
    } catch (error) {
      ps1?.dispose();
      hd?.dispose();
      throw error;
    }
  }

  public isDisposed(): boolean {
    return this.disposed;
  }

  public getMode(): RenderMode {
    return this.mode;
  }

  public setMode(mode: RenderMode): void {
    this.mode = mode;
  }

  public getDrawOrderMode(): DrawOrderMode {
    return this.drawOrderMode;
  }

  public setDrawOrderMode(mode: DrawOrderMode, orderingTable?: OrderingTableOptions): void {
    this.drawOrderMode = mode;
    if (orderingTable !== undefined) {
      this.orderingTable = orderingTable;
    }
  }

  public getLodIndex(): number {
    return this.lodIndex;
  }

  public getColorSlotIndex(): number {
    return this.colorSlotIndex;
  }

  public getPs1Pipeline(): Ps1Pipeline {
    return this.ps1Pipeline;
  }

  public getHdPipeline(): HdPipeline {
    return this.hdPipeline;
  }

  public getMesh(): CarRenderMesh | null {
    return this.mesh;
  }

  /**
   * Binds a loaded `CarModel` to GPU buffers and textures, cleanly disposing any previous car.
   */
  public setCar(carModel: CarModel, options: SetCarOptions = {}): void {
    if (this.disposed) {
      throw new Error('Cannot setCar on a disposed CarRenderer.');
    }

    const lodIndex = options.lodIndex ?? 0;
    const colorSlotIndex = options.colorSlotIndex ?? carModel.texture?.colorSlotIndex ?? 0;

    if (carModel.texture !== null) {
      getPaletteRowOffsetForSlot(colorSlotIndex, carModel.texture.source.colorCount);
    }

    const nextMesh = CarRenderMesh.fromCarModel(this.gl, carModel, lodIndex);
    let nextPs1Tex: IndexedTextureHandle | null = null;
    let nextHdTex: HdCarTextureArray | null = null;

    try {
      if (carModel.texture !== null) {
        const stacked = buildStackedCarPaletteImage(
          carModel.texture.source,
          carModel.texture.emptyEntryFallback,
        );
        nextPs1Tex = uploadIndexedTexture(this.gl, stacked, {
          transparencyMode: 'transparent-zero',
        });

        if (this.mode === 'hd') {
          nextHdTex = new HdCarTextureArray(
            this.gl,
            carModel.texture.source,
            colorSlotIndex,
            carModel.texture.emptyEntryFallback,
          );
        }
      }
    } catch (error) {
      nextMesh.dispose();
      nextPs1Tex?.dispose();
      nextHdTex?.dispose();
      throw error;
    }

    this.releaseCarResources();
    this.carModel = carModel;
    this.lodIndex = lodIndex;
    this.colorSlotIndex = colorSlotIndex;
    this.mesh = nextMesh;
    this.ps1Texture = nextPs1Tex;
    this.hdTexture = nextHdTex;
    this.hdTextureDirty = this.mode !== 'hd' && carModel.texture !== null;
  }

  /**
   * Switches LOD geometry without reloading or re-uploading textures.
   */
  public setLod(lodIndex: number): void {
    if (this.disposed) {
      throw new Error('Cannot setLod on a disposed CarRenderer.');
    }
    if (this.carModel === null) {
      throw new Error('Cannot setLod before setCar().');
    }
    if (lodIndex === this.lodIndex && this.mesh !== null) {
      return;
    }
    const nextMesh = CarRenderMesh.fromCarModel(this.gl, this.carModel, lodIndex);
    this.mesh?.dispose();
    this.mesh = nextMesh;
    this.lodIndex = lodIndex;
  }

  /**
   * Switches paint slot index without reloading VOL or rebuilding geometry/PS1 textures.
   */
  public setPaintSlot(colorSlotIndex: number): void {
    if (this.disposed) {
      throw new Error('Cannot setPaintSlot on a disposed CarRenderer.');
    }
    if (this.carModel === null || this.carModel.texture === null) {
      this.colorSlotIndex = colorSlotIndex;
      return;
    }

    getPaletteRowOffsetForSlot(colorSlotIndex, this.carModel.texture.source.colorCount);
    this.colorSlotIndex = colorSlotIndex;

    if (this.mode === 'hd') {
      this.syncHdTextureSlot();
    } else {
      this.hdTextureDirty = true;
    }
  }

  private syncHdTextureSlot(): void {
    const binding = this.carModel?.texture;
    if (binding === null || binding === undefined) {
      return;
    }
    if (this.hdTexture === null) {
      this.hdTexture = new HdCarTextureArray(
        this.gl,
        binding.source,
        this.colorSlotIndex,
        binding.emptyEntryFallback,
      );
      this.hdTextureDirty = false;
      return;
    }
    this.hdTexture.updatePaintSlot(
      binding.source,
      this.colorSlotIndex,
      binding.emptyEntryFallback,
    );
    this.hdTextureDirty = false;
  }

  public setPs1InternalResolution(width: number, height: number): void {
    this.ps1Pipeline.setInternalResolution(width, height);
  }

  public render(
    camera: OrbitCamera,
    viewportWidth: number,
    viewportHeight: number,
    options: { readonly wireframe?: boolean; readonly ps1?: Ps1RenderOptions } = {},
  ): void {
    if (this.disposed) {
      throw new Error('Cannot render with a disposed CarRenderer.');
    }
    if (this.mesh === null) {
      return;
    }

    const safeW = Math.max(1, Math.floor(viewportWidth));
    const safeH = Math.max(1, Math.floor(viewportHeight));

    if (this.mode === 'ps1') {
      const paletteRowOffset =
        this.carModel?.texture !== null && this.carModel?.texture !== undefined
          ? getPaletteRowOffsetForSlot(
              this.colorSlotIndex,
              this.carModel.texture.source.colorCount,
            )
          : 0;
      const ps1RenderOptions: Ps1RenderOptions = {
        ...options.ps1,
        drawOrderMode: options.ps1?.drawOrderMode ?? this.drawOrderMode,
        ...(options.ps1?.orderingTable !== undefined
          ? { orderingTable: options.ps1.orderingTable }
          : this.orderingTable !== undefined
            ? { orderingTable: this.orderingTable }
            : {}),
        paletteRowOffset,
        ...(options.wireframe !== undefined ? { wireframe: options.wireframe } : {}),
      };
      this.ps1Pipeline.render(
        this.mesh,
        this.ps1Texture,
        camera,
        safeW,
        safeH,
        ps1RenderOptions,
      );
      return;
    }

    if (this.carModel?.texture !== null && this.carModel?.texture !== undefined) {
      if (this.hdTexture === null || this.hdTextureDirty) {
        this.syncHdTextureSlot();
      }
    }

    this.hdPipeline.render(
      this.mesh,
      this.hdTexture,
      camera,
      safeW,
      safeH,
      options.wireframe !== undefined ? { wireframe: options.wireframe } : {},
    );
  }

  private releaseCarResources(): void {
    this.mesh?.dispose();
    this.mesh = null;
    this.ps1Texture?.dispose();
    this.ps1Texture = null;
    this.hdTexture?.dispose();
    this.hdTexture = null;
    this.hdTextureDirty = false;
  }

  public pollGlError(): GlErrorStatus {
    return pollGlError(this.gl as unknown as WebGL2ErrorContext);
  }

  public getResourceCounts(): GpuResourceCounts {
    if (this.disposed) {
      return EMPTY_GPU_RESOURCE_COUNTS;
    }
    return addResourceCounts(
      this.ps1Pipeline.getResourceCounts(),
      this.hdPipeline.getResourceCounts(),
      this.mesh?.getResourceCounts() ?? EMPTY_GPU_RESOURCE_COUNTS,
      this.ps1Texture?.getResourceCounts() ?? EMPTY_GPU_RESOURCE_COUNTS,
      this.hdTexture?.getResourceCounts() ?? EMPTY_GPU_RESOURCE_COUNTS,
    );
  }

  /**
   * Releases JS references to invalidated GPU handles immediately upon `webglcontextlost`
   * without issuing `gl.delete*` calls on a lost WebGL2 context (`M7.9`).
   */
  public invalidateOnContextLost(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.mesh = null;
    this.ps1Texture = null;
    this.hdTexture = null;
    this.hdTextureDirty = false;
    this.carModel = null;
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.releaseCarResources();
    this.carModel = null;
    this.ps1Pipeline.dispose();
    this.hdPipeline.dispose();
  }
}
