import { type CarModel, type CarTextureVariant } from '../formats/car';
import { CarAssetIndex } from '../formats/gtdb';
import type { VolEntry, VolInfo } from '../formats/vol';
import { BufferByteSource, type ByteSource } from '../io';
import type {
  VolReaderCarResourcesResult,
  VolReaderLoadCarResourcesParams,
} from '../workers/volReaderProtocol';

/** Default maximum decoded `CarModel` entries kept in the main-thread LRU cache. */
export const DEFAULT_CAR_CACHE_MAX_ENTRIES = 16;

export interface AssetRepositoryWorkerBackend {
  list(dir?: string, options?: { readonly signal?: AbortSignal }): Promise<readonly VolEntry[]>;
  read(path: string, options?: { readonly signal?: AbortSignal }): Promise<Uint8Array>;
  readDecompressed(path: string, options?: { readonly signal?: AbortSignal }): Promise<Uint8Array>;
  loadCarResources(
    params: VolReaderLoadCarResourcesParams,
    options?: { readonly signal?: AbortSignal },
  ): Promise<VolReaderCarResourcesResult>;
}

export interface AssetRepositoryOptions {
  readonly volInfo: VolInfo;
  readonly entries: readonly VolEntry[];
  readonly backend: AssetRepositoryWorkerBackend;
  readonly maxCarEntries?: number;
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

/**
 * Main-thread repository combining VOL metadata, `CarAssetIndex`, worker-backed
 * decompression/parsing, and an in-memory LRU cache of decoded `(CarModel, CdpTexture)`
 * pairs keyed by `fingerprint + bodyCode + timeOfDay` (`ROADMAP §4.2`, `M7.7`).
 */
export class AssetRepository {
  public readonly volInfo: VolInfo;
  public readonly carAssetIndex: CarAssetIndex;

  private readonly backend: AssetRepositoryWorkerBackend;
  private readonly maxCarEntries: number;
  private readonly carCache = new Map<string, CarModel>();
  private readonly inflightCars = new Map<string, Promise<CarModel>>();

  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private workerLoads = 0;
  private disposed = false;

  public constructor(options: AssetRepositoryOptions) {
    const maxEntries = options.maxCarEntries ?? DEFAULT_CAR_CACHE_MAX_ENTRIES;
    if (!Number.isInteger(maxEntries) || maxEntries < 1) {
      throw new RangeError(`maxCarEntries must be a positive integer, got ${String(maxEntries)}.`);
    }
    this.volInfo = options.volInfo;
    this.carAssetIndex = new CarAssetIndex(options.entries);
    this.backend = options.backend;
    this.maxCarEntries = maxEntries;
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
    // Refresh LRU order: delete and re-insert at the most-recently-used tail.
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
          this.insertLru(key, result.carModel);
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

  public clearCache(): void {
    this.carCache.clear();
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.carCache.clear();
    this.inflightCars.clear();
  }

  private insertLru(key: string, model: CarModel): void {
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

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error('AssetRepository has been disposed.');
    }
  }
}
