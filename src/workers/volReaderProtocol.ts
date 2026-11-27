import {
  type CarModel,
  type CarTextureVariant,
  buildCarModel,
  parseCdo,
  parseCdp,
} from '../formats/car';
import {
  type CarCatalogEntry,
  buildCarCatalogFromBuffers,
  parseUnistrdb,
} from '../formats/gtdb';
import { gunzip, isGzipMagic } from '../formats/gzip';
import {
  type TrackModel,
  buildTrackModel,
  parseTro,
  parseTrp,
} from '../formats/track';
import {
  type VolEntry,
  VolError,
  type VolInfo,
  VolReader,
  type VolReaderOpenOptions,
} from '../formats/vol';
import {
  BlobByteSource,
  type BlobLike,
  type ByteSource,
  type CachedByteSourceOptions,
} from '../io';
import {
  bindRpcServer,
  type RpcCallOptions,
  RpcClient,
  type RpcEndpoint,
  type RpcMessageTransport,
  type RpcServerHandle,
  createAbortError,
  withTransfer,
} from './rpc';

export interface VolReaderOpenParams {
  readonly blob: BlobLike;
  readonly lastModified?: number;
  readonly cacheOptions?: CachedByteSourceOptions;
}

export interface VolReaderListParams {
  readonly dir?: string;
}

export interface VolReaderPathParams {
  readonly path: string;
}

export interface VolReaderRangeParams {
  readonly path: string;
  readonly start: number;
  readonly end: number;
}

export interface VolReaderRangeResult {
  readonly totalSize: number;
  readonly offset: number;
  readonly bytes: Uint8Array;
}

export interface VolReaderLoadCarCatalogParams {
  readonly gtmodeDataPath: string;
  readonly unistrdbPath?: string;
  readonly region?: string | null;
}

export interface VolReaderCarCatalogResult {
  readonly region: string | null;
  readonly entries: readonly CarCatalogEntry[];
  readonly stringCount: number | null;
}

export interface VolReaderLoadCarResourcesParams {
  readonly modelPath: string;
  readonly texturePath?: string;
  readonly variant: CarTextureVariant;
}

export interface VolReaderCarResourcesResult {
  readonly carModel: CarModel;
}

export interface VolReaderLoadTrackResourcesParams {
  readonly troPath: string;
  readonly trpPath?: string;
  readonly includeCollision?: boolean;
  readonly includeLod1?: boolean;
}

export type VolReaderTrackLoadStage =
  | 'reading-tro'
  | 'reading-trp'
  | 'parsing'
  | 'building-model'
  | 'complete';

export interface VolReaderTrackLoadProgress {
  readonly stage: VolReaderTrackLoadStage;
  readonly progress: number;
  readonly label: string;
}

export interface VolReaderTrackResourcesResult {
  readonly trackModel: TrackModel;
}

export interface VolReaderRpcSchema {
  open: {
    readonly params: VolReaderOpenParams;
    readonly result: VolInfo;
  };
  list: {
    readonly params: VolReaderListParams;
    readonly result: readonly VolEntry[];
  };
  stat: {
    readonly params: VolReaderPathParams;
    readonly result: VolEntry | undefined;
  };
  read: {
    readonly params: VolReaderPathParams;
    readonly result: Uint8Array;
  };
  readRange: {
    readonly params: VolReaderRangeParams;
    readonly result: VolReaderRangeResult;
  };
  readDecompressed: {
    readonly params: VolReaderPathParams;
    readonly result: Uint8Array;
  };
  readDecompressedRange: {
    readonly params: VolReaderRangeParams;
    readonly result: VolReaderRangeResult;
  };
  loadCarCatalog: {
    readonly params: VolReaderLoadCarCatalogParams;
    readonly result: VolReaderCarCatalogResult;
  };
  loadCarResources: {
    readonly params: VolReaderLoadCarResourcesParams;
    readonly result: VolReaderCarResourcesResult;
  };
  loadTrackResources: {
    readonly params: VolReaderLoadTrackResourcesParams;
    readonly result: VolReaderTrackResourcesResult;
  };
  close: {
    readonly params: Record<string, never>;
    readonly result: void;
  };
}

export interface BindVolReaderRpcOptions {
  /** Optional source factory override (defaults to `new BlobByteSource(blob)`). */
  readonly createSource?: (blob: BlobLike) => ByteSource;
}

/**
 * Copies `bytes` into a dedicated, unshared `ArrayBuffer` of exact `bytes.byteLength`
 * so transferring it back from a worker can never detach cached windows in `CachedByteSource`.
 */
export function toOwnedTransferUint8Array(bytes: Uint8Array): {
  readonly bytes: Uint8Array;
  readonly buffer: ArrayBuffer;
} {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return {
    bytes: copy,
    buffer: copy.buffer,
  };
}

/**
 * Returns an unshared, exact-length `ArrayBuffer` view suitable for `withTransfer`.
 * Avoids copying when `bytes` already owns its `ArrayBuffer` (e.g. fresh `gunzip()` output).
 */
export function toTransferableDecompressedUint8Array(bytes: Uint8Array): {
  readonly bytes: Uint8Array;
  readonly buffer: ArrayBuffer;
} {
  if (
    bytes.buffer instanceof ArrayBuffer &&
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength
  ) {
    return {
      bytes,
      buffer: bytes.buffer,
    };
  }
  return toOwnedTransferUint8Array(bytes);
}

function normalizeEntryPath(path: string): string {
  return path.replace(/^\/+|\/+$/g, '');
}

function clampRange(
  start: number,
  end: number,
  totalSize: number,
): { readonly offset: number; readonly end: number } {
  const safeStart = Number.isFinite(start) ? Math.trunc(start) : 0;
  const safeEnd = Number.isFinite(end) ? Math.trunc(end) : safeStart;
  const offset = Math.min(Math.max(0, safeStart), totalSize);
  const clampedEnd = Math.min(Math.max(offset, safeEnd), totalSize);
  return { offset, end: clampedEnd };
}

function addOwnedBuffer(set: Set<ArrayBuffer>, view: ArrayBufferView): void {
  if (
    view.buffer instanceof ArrayBuffer &&
    view.byteOffset === 0 &&
    view.byteLength === view.buffer.byteLength
  ) {
    set.add(view.buffer);
  }
}

/**
 * Collects unique, unshared `ArrayBuffer`s inside a decoded `CarModel` so worker `postMessage`
 * transfers them zero-copy without `DataCloneError` on shared views (e.g. `indices`).
 */
export function collectCarModelTransferables(carModel: CarModel): Transferable[] {
  const buffers = new Set<ArrayBuffer>();

  for (const lod of carModel.lods) {
    addOwnedBuffer(buffers, lod.rawVerticesInt16);
    addOwnedBuffer(buffers, lod.positionsMeters);
    addOwnedBuffer(buffers, lod.normals);
  }
  addOwnedBuffer(buffers, carModel.shadow.rawVerticesXZ);

  const texture = carModel.texture;
  if (texture !== null) {
    addOwnedBuffer(buffers, texture.source.colorIds);
    addOwnedBuffer(buffers, texture.source.indices);
    for (const slot of texture.source.colorSlots) {
      for (const pal of slot.palettes) {
        addOwnedBuffer(buffers, pal);
      }
      addOwnedBuffer(buffers, slot.emptyEntryMasks);
      addOwnedBuffer(buffers, slot.stpEntryMasks);
      addOwnedBuffer(buffers, slot.illuminationMasks);
      addOwnedBuffer(buffers, slot.paintMasks);
    }
    addOwnedBuffer(buffers, texture.indexedImage.indices);
    for (const pal of texture.indexedImage.palettes) {
      addOwnedBuffer(buffers, pal);
    }
  }

  return Array.from(buffers);
}

/**
 * Collects unique, unshared `ArrayBuffer`s inside a decoded `TrackModel` so worker `postMessage`
 * transfers them zero-copy without `DataCloneError` on shared views (`M8.9`).
 */
export function collectTrackModelTransferables(trackModel: TrackModel): Transferable[] {
  const buffers = new Set<ArrayBuffer>();

  for (const part of trackModel.render) {
    addOwnedBuffer(buffers, part.positions);
    addOwnedBuffer(buffers, part.uvs);
    addOwnedBuffer(buffers, part.colors);
    addOwnedBuffer(buffers, part.paletteIndices);
    addOwnedBuffer(buffers, part.indices);
  }
  for (const part of trackModel.lod1Render) {
    addOwnedBuffer(buffers, part.positions);
    addOwnedBuffer(buffers, part.uvs);
    addOwnedBuffer(buffers, part.colors);
    addOwnedBuffer(buffers, part.paletteIndices);
    addOwnedBuffer(buffers, part.indices);
  }
  if (trackModel.textureAtlas !== null) {
    for (const page of trackModel.textureAtlas.pages) {
      addOwnedBuffer(buffers, page.indices);
    }
    for (const pal of trackModel.textureAtlas.palettes) {
      addOwnedBuffer(buffers, pal.colors);
    }
  }
  if (trackModel.collision !== undefined) {
    addOwnedBuffer(buffers, trackModel.collision.vertices);
    addOwnedBuffer(buffers, trackModel.collision.normals);
    addOwnedBuffer(buffers, trackModel.collision.surfaceTypes);
    if (trackModel.collision.groundMaterials !== undefined) {
      addOwnedBuffer(buffers, trackModel.collision.groundMaterials);
    }
    addOwnedBuffer(buffers, trackModel.collision.segmentIndices);
  }

  return Array.from(buffers);
}

/**
 * Binds `VolReader` operations onto a worker-side `RpcMessageTransport`.
 */
export function bindVolReaderRpcServer(
  transport: RpcMessageTransport,
  reader = new VolReader(),
  options: BindVolReaderRpcOptions = {},
): RpcServerHandle {
  const createSource = options.createSource ?? ((blob: BlobLike) => new BlobByteSource(blob));
  let decompressedCache: { readonly path: string; readonly bytes: Uint8Array } | null = null;

  const getDecompressed = async (rawPath: string): Promise<Uint8Array> => {
    const normalized = normalizeEntryPath(rawPath);
    if (decompressedCache !== null && decompressedCache.path === normalized) {
      return decompressedCache.bytes;
    }
    const raw = await reader.read(normalized);
    const unpacked = await gunzip(raw);
    decompressedCache = { path: normalized, bytes: unpacked };
    return unpacked;
  };

  const readMaybeGunzip = async (rawPath: string): Promise<Uint8Array> => {
    const raw = await reader.read(normalizeEntryPath(rawPath));
    return isGzipMagic(raw) ? gunzip(raw) : raw;
  };

  const server = bindRpcServer<VolReaderRpcSchema>(transport, {
    open: (params) => {
      decompressedCache = null;
      const source = createSource(params.blob);
      const openOptions: VolReaderOpenOptions = {
        ...(params.lastModified !== undefined ? { lastModified: params.lastModified } : {}),
        ...(params.cacheOptions !== undefined ? { cacheOptions: params.cacheOptions } : {}),
      };
      return reader.open(source, openOptions);
    },
    list: (params) => reader.list(params.dir),
    stat: (params) => reader.stat(params.path),
    read: async (params) => {
      const data = await reader.read(params.path);
      const owned = toOwnedTransferUint8Array(data);
      return withTransfer(owned.bytes, [owned.buffer]);
    },
    readRange: async (params) => {
      const normalized = normalizeEntryPath(params.path);
      const entry = await reader.stat(normalized);
      if (entry === undefined) {
        throw new VolError(VolError.EntryNotFound, `File not found in VOL: "${normalized}"`);
      }
      if (entry.kind !== 'file') {
        throw new VolError(VolError.NotAFile, `Cannot read directory entry as file: "${normalized}"`);
      }
      const { offset, end } = clampRange(params.start, params.end, entry.size);
      const slice = await reader.readRange(normalized, offset, end);
      const owned = toOwnedTransferUint8Array(slice);
      return withTransfer(
        {
          totalSize: entry.size,
          offset,
          bytes: owned.bytes,
        },
        [owned.buffer],
      );
    },
    readDecompressed: async (params) => {
      const unpacked = await getDecompressed(params.path);
      // Always copy so the 1-slot decompressedCache buffer is never detached on transfer.
      const owned = toOwnedTransferUint8Array(unpacked);
      return withTransfer(owned.bytes, [owned.buffer]);
    },
    readDecompressedRange: async (params) => {
      const unpacked = await getDecompressed(params.path);
      const { offset, end } = clampRange(params.start, params.end, unpacked.byteLength);
      const owned = toOwnedTransferUint8Array(unpacked.subarray(offset, end));
      return withTransfer(
        {
          totalSize: unpacked.byteLength,
          offset,
          bytes: owned.bytes,
        },
        [owned.buffer],
      );
    },
    loadCarCatalog: async (params) => {
      const gtmodeBytes = await readMaybeGunzip(params.gtmodeDataPath);
      const unistrBytes =
        params.unistrdbPath !== undefined ? await readMaybeGunzip(params.unistrdbPath) : null;
      const stringCount = unistrBytes !== null ? parseUnistrdb(unistrBytes).count : null;
      const catalog = buildCarCatalogFromBuffers(
        gtmodeBytes,
        unistrBytes,
        params.region ?? null,
      );
      return {
        region: catalog.region,
        entries: catalog.listCars(),
        stringCount,
      };
    },
    loadCarResources: async (params) => {
      const modelBytes = await readMaybeGunzip(params.modelPath);
      const cdo = parseCdo(modelBytes);
      let carModel: CarModel;
      if (params.texturePath !== undefined) {
        const textureBytes = await readMaybeGunzip(params.texturePath);
        const cdp = parseCdp(textureBytes);
        carModel = buildCarModel(cdo, {
          texture: cdp,
          variant: params.variant,
        });
      } else {
        carModel = buildCarModel(cdo, {
          variant: params.variant,
        });
      }
      return withTransfer({ carModel }, collectCarModelTransferables(carModel));
    },
    loadTrackResources: async (params, context) => {
      const checkAborted = (): void => {
        if (context.signal.aborted) {
          throw createAbortError(context.signal.reason);
        }
      };

      const emit = (stage: VolReaderTrackLoadStage, progress: number, label: string): void => {
        context.reportProgress?.({ stage, progress, label });
      };

      checkAborted();
      emit('reading-tro', 0.1, 'Reading and decompressing track geometry (.tro)…');
      const troBytes = await readMaybeGunzip(params.troPath);
      checkAborted();

      let trpBytes: Uint8Array | null = null;
      if (params.trpPath !== undefined) {
        emit('reading-trp', 0.35, 'Reading and decompressing track textures (.trp)…');
        trpBytes = await readMaybeGunzip(params.trpPath);
        checkAborted();
      }

      emit('parsing', 0.65, 'Parsing track segments and PS1 VRAM textures…');
      const tro = parseTro(troBytes);
      const trp = trpBytes !== null ? parseTrp(trpBytes) : undefined;
      checkAborted();

      emit('building-model', 0.85, 'Building normalized TrackModel geometry…');
      const trackModel = buildTrackModel(tro, trp, {
        includeLod1: params.includeLod1 ?? false,
        includeCollision: params.includeCollision ?? false,
      });
      checkAborted();

      emit('complete', 1.0, 'Track ready.');
      return withTransfer({ trackModel }, collectTrackModelTransferables(trackModel));
    },
    close: () => {
      decompressedCache = null;
      reader.close();
    },
  });

  return {
    dispose(): void {
      decompressedCache = null;
      server.dispose();
    },
  };
}

/**
 * Typed main-thread client communicating with a `VolReader` worker over `RpcClient`.
 */
export class VolReaderRpcClient {
  private readonly rpc: RpcClient<VolReaderRpcSchema>;

  constructor(endpoint: RpcEndpoint) {
    this.rpc = new RpcClient<VolReaderRpcSchema>(endpoint);
  }

  open(
    blob: BlobLike,
    options: VolReaderOpenOptions = {},
    rpcOptions?: RpcCallOptions,
  ): Promise<VolInfo> {
    const params: VolReaderOpenParams = {
      blob,
      ...(options.lastModified !== undefined ? { lastModified: options.lastModified } : {}),
      ...(options.cacheOptions !== undefined ? { cacheOptions: options.cacheOptions } : {}),
    };
    return this.rpc.call('open', params, rpcOptions);
  }

  list(dir?: string, rpcOptions?: RpcCallOptions): Promise<readonly VolEntry[]> {
    const params: VolReaderListParams = dir !== undefined ? { dir } : {};
    return this.rpc.call('list', params, rpcOptions);
  }

  stat(path: string, rpcOptions?: RpcCallOptions): Promise<VolEntry | undefined> {
    return this.rpc.call('stat', { path }, rpcOptions);
  }

  read(path: string, rpcOptions?: RpcCallOptions): Promise<Uint8Array> {
    return this.rpc.call('read', { path }, rpcOptions);
  }

  readRange(
    path: string,
    start: number,
    end: number,
    rpcOptions?: RpcCallOptions,
  ): Promise<VolReaderRangeResult> {
    return this.rpc.call('readRange', { path, start, end }, rpcOptions);
  }

  readDecompressed(path: string, rpcOptions?: RpcCallOptions): Promise<Uint8Array> {
    return this.rpc.call('readDecompressed', { path }, rpcOptions);
  }

  readDecompressedRange(
    path: string,
    start: number,
    end: number,
    rpcOptions?: RpcCallOptions,
  ): Promise<VolReaderRangeResult> {
    return this.rpc.call('readDecompressedRange', { path, start, end }, rpcOptions);
  }

  loadCarCatalog(
    params: VolReaderLoadCarCatalogParams,
    rpcOptions?: RpcCallOptions,
  ): Promise<VolReaderCarCatalogResult> {
    return this.rpc.call('loadCarCatalog', params, rpcOptions);
  }

  loadCarResources(
    params: VolReaderLoadCarResourcesParams,
    rpcOptions?: RpcCallOptions,
  ): Promise<VolReaderCarResourcesResult> {
    return this.rpc.call('loadCarResources', params, rpcOptions);
  }

  loadTrackResources(
    params: VolReaderLoadTrackResourcesParams,
    rpcOptions?: RpcCallOptions,
  ): Promise<VolReaderTrackResourcesResult> {
    return this.rpc.call('loadTrackResources', params, rpcOptions);
  }

  close(rpcOptions?: RpcCallOptions): Promise<void> {
    return this.rpc.call('close', {}, rpcOptions);
  }

  dispose(terminateEndpoint = false): void {
    this.rpc.dispose(terminateEndpoint);
  }
}
