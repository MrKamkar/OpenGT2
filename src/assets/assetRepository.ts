import { type CarModel, type CarTextureVariant } from '../formats/car';
import { CarAssetIndex } from '../formats/gtdb';
import type { TrackModel } from '../formats/track';
import type { VolEntry, VolInfo } from '../formats/vol';
import { BufferByteSource, type ByteSource } from '../io';
import type {
  VolReaderCarResourcesResult,
  VolReaderLoadCarResourcesParams,
  VolReaderLoadTrackResourcesParams,
  VolReaderTrackLoadProgress,
  VolReaderTrackResourcesResult,
} from '../workers/volReaderProtocol';
import { TrackAssetIndex } from './trackAssetIndex';

/** Default maximum decoded `CarModel` entries kept in the main-thread LRU cache. */
export const DEFAULT_CAR_CACHE_MAX_ENTRIES = 16;

/** Default maximum decoded `TrackModel` entries kept in the main-thread LRU cache (`M8.9`). */
export const DEFAULT_TRACK_CACHE_MAX_ENTRIES = 4;

export interface AssetRepositoryWorkerBackend {
  list(dir?: string, options?: { readonly signal?: AbortSignal }): Promise<readonly VolEntry[]>;
  read(path: string, options?: { readonly signal?: AbortSignal }): Promise<Uint8Array>;
  readDecompressed(path: string, options?: { readonly signal?: AbortSignal }): Promise<Uint8Array>;
  loadCarResources(
    params: VolReaderLoadCarResourcesParams,
    options?: { readonly signal?: AbortSignal },
  ): Promise<VolReaderCarResourcesResult>;
  loadTrackResources?(
    params: VolReaderLoadTrackResourcesParams,
    options?: {
      readonly signal?: AbortSignal;
      readonly onProgress?: (progress: unknown) => void;
    },
  ): Promise<VolReaderTrackResourcesResult>;
}

export interface AssetRepositoryOptions {
  readonly volInfo: VolInfo;
  readonly entries: readonly VolEntry[];
  readonly backend: AssetRepositoryWorkerBackend;
  readonly maxCarEntries?: number;
  readonly maxTrackEntries?: number;
}

export interface AssetRepositoryCacheStats {
  readonly size: number;
  readonly maxEntries: number;
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
  readonly workerLoads: number;
}

export interface GetCarModelOptions {
  readonly signal?: AbortSignal;
}

export interface GetTrackModelOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: VolReaderTrackLoadProgress) => void;
  readonly includeCollision?: boolean;
}

/**
 * Deterministic LRU cache key combining archive fingerprint, 5-character body code,
 * and day/night texture variant (`M7.7`).
 */
export function buildCarModelCacheKey(
  fingerprint: string,
  bodyCode: string,
  variant: CarTextureVariant,
): string {
  return `${fingerprint}:${bodyCode.trim().toLowerCase()}:${variant}`;
}

/**
 * Deterministic LRU cache key combining archive fingerprint and `.tro` stem (`M8.9`).
 */
export function buildTrackModelCacheKey(fingerprint: string, stem: string): string {
  return `${fingerprint}:track:${stem.trim().toLowerCase()}`;
}

function createAbortError(reason: unknown): Error {
  const message =
    typeof reason === 'string' && reason.length > 0 ? reason : 'Asset request was aborted.';
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

function awaitWithAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(createAbortError(signal.reason));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(createAbortError(signal.reason));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function isTrackLoadProgress(value: unknown): value is VolReaderTrackLoadProgress {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<VolReaderTrackLoadProgress>;
  return (
    typeof candidate.stage === 'string' &&
    typeof candidate.progress === 'number' &&
    typeof candidate.label === 'string'
  );
}

interface InflightTrackRequest {
  readonly promise: Promise<TrackModel>;
  readonly listeners: Set<(progress: VolReaderTrackLoadProgress) => void>;
}

/**
 * Main-thread repository combining VOL metadata, `CarAssetIndex`, `TrackAssetIndex`,
 * worker-backed decompression/parsing, and in-memory LRU caches for cars and tracks
 * (`ROADMAP §4.2`, `M7.7`, `M8.9`).
 */
export class AssetRepository {
  public readonly volInfo: VolInfo;
  public readonly carAssetIndex: CarAssetIndex;
  public readonly trackAssetIndex: TrackAssetIndex;

  private readonly backend: AssetRepositoryWorkerBackend;
  private readonly maxCarEntries: number;
  private readonly maxTrackEntries: number;
  private readonly carCache = new Map<string, CarModel>();
  private readonly inflightCars = new Map<string, Promise<CarModel>>();
  private readonly trackCache = new Map<string, TrackModel>();
  private readonly inflightTracks = new Map<string, InflightTrackRequest>();

  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private workerLoads = 0;

  private trackHits = 0;
  private trackMisses = 0;
  private trackEvictions = 0;
  private trackWorkerLoads = 0;
  private disposed = false;

  public constructor(options: AssetRepositoryOptions) {
    const maxCarEntries = options.maxCarEntries ?? DEFAULT_CAR_CACHE_MAX_ENTRIES;
    if (!Number.isInteger(maxCarEntries) || maxCarEntries < 1) {
      throw new RangeError(
        `maxCarEntries must be a positive integer, got ${String(maxCarEntries)}.`,
      );
    }
    const maxTrackEntries = options.maxTrackEntries ?? DEFAULT_TRACK_CACHE_MAX_ENTRIES;
    if (!Number.isInteger(maxTrackEntries) || maxTrackEntries < 1) {
      throw new RangeError(
        `maxTrackEntries must be a positive integer, got ${String(maxTrackEntries)}.`,
      );
    }

    this.volInfo = options.volInfo;
    this.carAssetIndex = new CarAssetIndex(options.entries);
    this.trackAssetIndex = new TrackAssetIndex(options.entries);
    this.backend = options.backend;
    this.maxCarEntries = maxCarEntries;
    this.maxTrackEntries = maxTrackEntries;
  }

  public isDisposed(): boolean {
    return this.disposed;
  }

  public async list(dir?: string): Promise<VolEntry[]> {
    this.assertNotDisposed();
    const entries = await this.backend.list(dir);
    return [...entries];
  }

  public async open(path: string, signal?: AbortSignal): Promise<ByteSource> {
    this.assertNotDisposed();
    const bytes = await this.backend.read(path, signal !== undefined ? { signal } : undefined);
    return new BufferByteSource(bytes);
  }

  public async openDecompressed(path: string, signal?: AbortSignal): Promise<ByteSource> {
    this.assertNotDisposed();
    const bytes = await this.backend.readDecompressed(
      path,
      signal !== undefined ? { signal } : undefined,
    );
    return new BufferByteSource(bytes);
  }

  /**
   * Synchronously looks up an already-decoded `CarModel` in the LRU cache (refreshing recency),
   * or returns `null` when absent. Used by `M7.9` context recovery without re-reading `GT2.VOL`.
   */
  public getCachedCarModel(bodyCode: string, variant: CarTextureVariant): CarModel | null {
    if (this.disposed) {
      return null;
    }
    const key = buildCarModelCacheKey(this.volInfo.fingerprint, bodyCode, variant);
    const cached = this.carCache.get(key);
    if (cached === undefined) {
      return null;
    }
    this.carCache.delete(key);
    this.carCache.set(key, cached);
    return cached;
  }

  /**
   * Loads a decoded `CarModel` (with bound `CdpTexture`) for `bodyCode` and `variant`
   * (`'day'` or `'night'`) from the LRU cache or via the `VolReader` worker.
   */
  public async getCarModel(
    bodyCode: string,
    variant: CarTextureVariant,
    options: GetCarModelOptions = {},
  ): Promise<CarModel> {
    this.assertNotDisposed();
    if (options.signal?.aborted === true) {
      throw createAbortError(options.signal.reason);
    }

    const normalizedCode = bodyCode.trim().toLowerCase();
    const key = buildCarModelCacheKey(this.volInfo.fingerprint, normalizedCode, variant);

    const cached = this.getCachedCarModel(normalizedCode, variant);
    if (cached !== null) {
      this.hits += 1;
      return cached;
    }

    this.misses += 1;

    const existingInflight = this.inflightCars.get(key);
    if (existingInflight !== undefined) {
      return awaitWithAbort(existingInflight, options.signal);
    }

    const resolved = this.carAssetIndex.resolveByCode(normalizedCode);
    const modelEntry = variant === 'day' ? resolved.dayModel : resolved.nightModel;
    const textureEntry = variant === 'day' ? resolved.dayTexture : resolved.nightTexture;

    if (modelEntry === null) {
      throw new Error(
        `Missing ${variant === 'day' ? '.cdo' : '.cno'} model for body "${normalizedCode}".`,
      );
    }

    this.workerLoads += 1;
    const params: VolReaderLoadCarResourcesParams = {
      modelPath: modelEntry.path,
      ...(textureEntry !== null ? { texturePath: textureEntry.path } : {}),
      variant,
    };

    const loadPromise = this.backend
      .loadCarResources(params)
      .then((result) => {
        if (!this.disposed) {
          this.insertCarLru(key, result.carModel);
        }
        return result.carModel;
      })
      .finally(() => {
        if (this.inflightCars.get(key) === loadPromise) {
          this.inflightCars.delete(key);
        }
      });

    this.inflightCars.set(key, loadPromise);
    return awaitWithAbort(loadPromise, options.signal);
  }

  /**
   * Synchronously looks up an already-decoded `TrackModel` in the LRU cache (refreshing recency),
   * or returns `null` when absent. Used by `M8.9` context recovery without re-reading `GT2.VOL`.
   */
  public getCachedTrackModel(stem: string): TrackModel | null {
    if (this.disposed) {
      return null;
    }
    const key = buildTrackModelCacheKey(this.volInfo.fingerprint, stem);
    const cached = this.trackCache.get(key);
    if (cached === undefined) {
      return null;
    }
    this.trackCache.delete(key);
    this.trackCache.set(key, cached);
    return cached;
  }

  /**
   * Streams and decodes a `TrackModel` for `stem` from the LRU cache or via the `VolReader` worker,
   * forwarding progress updates (`reading-tro` → `complete`) and isolating caller `AbortSignal`s.
   */
  public async getTrackModel(
    stem: string,
    options: GetTrackModelOptions = {},
  ): Promise<TrackModel> {
    this.assertNotDisposed();
    if (options.signal?.aborted === true) {
      throw createAbortError(options.signal.reason);
    }

    const normalizedStem = stem.trim().toLowerCase();
    const requireCollision = options.includeCollision ?? false;
    const key = buildTrackModelCacheKey(this.volInfo.fingerprint, normalizedStem);
    const inflightKey = `${key}:${requireCollision ? 'col' : 'nocol'}`;

    const cached = this.getCachedTrackModel(normalizedStem);
    if (cached !== null && (!requireCollision || cached.collision !== undefined)) {
      this.trackHits += 1;
      options.onProgress?.({
        stage: 'complete',
        progress: 1.0,
        label: 'Loaded track from cache.',
      });
      return cached;
    }

    this.trackMisses += 1;

    let inflight = this.inflightTracks.get(inflightKey);
    if (inflight === undefined) {
      const entry = this.trackAssetIndex.getTrack(normalizedStem);
      if (entry === null) {
        throw new Error(`Track "${normalizedStem}" was not found in crsobj/.`);
      }
      if (typeof this.backend.loadTrackResources !== 'function') {
        throw new Error('Worker backend does not implement loadTrackResources.');
      }

      this.trackWorkerLoads += 1;
      const listeners = new Set<(progress: VolReaderTrackLoadProgress) => void>();
      const params: VolReaderLoadTrackResourcesParams = {
        troPath: entry.troEntry.path,
        ...(entry.trpEntry !== null ? { trpPath: entry.trpEntry.path } : {}),
        includeCollision: requireCollision,
        includeLod1: false,
      };

      const loadPromise = this.backend
        .loadTrackResources(params, {
          onProgress: (rawProgress) => {
            if (isTrackLoadProgress(rawProgress)) {
              for (const listener of listeners) {
                listener(rawProgress);
              }
            }
          },
        })
        .then((result) => {
          if (!this.disposed) {
            const existing = this.trackCache.get(key);
            if (existing === undefined || existing.collision === undefined || result.trackModel.collision !== undefined) {
              this.insertTrackLru(key, result.trackModel);
            }
          }
          return result.trackModel;
        })
        .finally(() => {
          const active = this.inflightTracks.get(inflightKey);
          if (active?.promise === loadPromise) {
            this.inflightTracks.delete(inflightKey);
          }
        });

      inflight = { promise: loadPromise, listeners };
      this.inflightTracks.set(inflightKey, inflight);
    }

    const onProgress = options.onProgress;
    if (onProgress !== undefined) {
      inflight.listeners.add(onProgress);
    }

    try {
      return await awaitWithAbort(inflight.promise, options.signal);
    } finally {
      if (onProgress !== undefined) {
        inflight.listeners.delete(onProgress);
      }
    }
  }

  public getCacheStats(): AssetRepositoryCacheStats {
    return {
      size: this.carCache.size,
      maxEntries: this.maxCarEntries,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      workerLoads: this.workerLoads,
    };
  }

  public getTrackCacheStats(): AssetRepositoryCacheStats {
    return {
      size: this.trackCache.size,
      maxEntries: this.maxTrackEntries,
      hits: this.trackHits,
      misses: this.trackMisses,
      evictions: this.trackEvictions,
      workerLoads: this.trackWorkerLoads,
    };
  }

  public clearCache(): void {
    this.carCache.clear();
    this.trackCache.clear();
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.carCache.clear();
    this.inflightCars.clear();
    this.trackCache.clear();
    this.inflightTracks.clear();
  }

  private insertCarLru(key: string, model: CarModel): void {
    if (this.carCache.has(key)) {
      this.carCache.delete(key);
    }
    while (this.carCache.size >= this.maxCarEntries) {
      const oldestKey = this.carCache.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.carCache.delete(oldestKey);
      this.evictions += 1;
    }
    this.carCache.set(key, model);
  }

  private insertTrackLru(key: string, model: TrackModel): void {
    if (this.trackCache.has(key)) {
      this.trackCache.delete(key);
    }
    while (this.trackCache.size >= this.maxTrackEntries) {
      const oldestKey = this.trackCache.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.trackCache.delete(oldestKey);
      this.trackEvictions += 1;
    }
    this.trackCache.set(key, model);
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error('AssetRepository has been disposed.');
    }
  }
}
