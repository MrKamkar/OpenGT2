export const DEFAULT_IDB_CACHE_DB_NAME = 'opengt2-cache';
export const DEFAULT_IDB_CACHE_STORE_NAME = 'entries';
export const DEFAULT_IDB_CACHE_MAX_BYTES = 64 * 1024 * 1024;
export const DEFAULT_IDB_CACHE_VERSION = '1';
const IDB_CACHE_DB_VERSION = 1;

export interface IdbCacheEntryMeta {
  readonly key: string;
  readonly version: string;
  readonly byteLength: number;
  readonly accessedAt: number;
  readonly seq: number;
}

export interface IdbCacheRecord extends IdbCacheEntryMeta {
  readonly value: ArrayBuffer;
}

/**
 * Persistence contract backing `IdbCache`.
 * Abstracted so unit tests can use an in-memory backend without browser IndexedDB.
 */
export interface IdbCacheBackend {
  get(key: string): Promise<IdbCacheRecord | null>;
  put(record: IdbCacheRecord): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  listMetadata(): Promise<readonly IdbCacheEntryMeta[]>;
}

export interface IndexedDbCacheBackendOptions {
  readonly dbName?: string;
  readonly storeName?: string;
  readonly indexedDB?: IDBFactory | undefined;
}

export interface IdbCacheOptions {
  /** Cache / decoder schema version. Entries with a different version are treated as stale and invalidated. */
  readonly version?: string;
  /** Maximum total payload bytes retained in cache before evicting oldest entries. */
  readonly maxBytes?: number;
  /** Optional storage backend override (defaults to IndexedDB). */
  readonly backend?: IdbCacheBackend;
  /** Optional clock override (ms since epoch) for deterministic tests. */
  readonly now?: () => number;
}

export interface IdbCacheStats {
  readonly entryCount: number;
  readonly totalBytes: number;
  readonly maxBytes: number;
  readonly version: string;
}

/**
 * Builds a canonical cache key scoped by decoder version, file fingerprint, and asset path (ROADMAP §4.4).
 */
export function buildCacheKey(
  fileFingerprint: string,
  assetPath: string,
  decoderVersion: string,
): string {
  return `${decoderVersion}:${fileFingerprint}:${assetPath}`;
}

function isValidCacheRecord(value: unknown): value is IdbCacheRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const rec = value as Record<string, unknown>;
  return (
    typeof rec['key'] === 'string' &&
    typeof rec['version'] === 'string' &&
    typeof rec['byteLength'] === 'number' &&
    typeof rec['accessedAt'] === 'number' &&
    typeof rec['seq'] === 'number' &&
    rec['value'] instanceof ArrayBuffer
  );
}

function toEntryMeta(record: IdbCacheRecord): IdbCacheEntryMeta {
  return {
    key: record.key,
    version: record.version,
    byteLength: record.byteLength,
    accessedAt: record.accessedAt,
    seq: record.seq,
  };
}

function resolveIndexedDb(explicit?: IDBFactory | undefined): IDBFactory | null {
  if (explicit !== undefined) {
    return explicit;
  }
  if (typeof globalThis === 'undefined' || !('indexedDB' in globalThis)) {
    return null;
  }
  const candidate = globalThis.indexedDB as IDBFactory | undefined;
  return candidate !== undefined && typeof candidate.open === 'function' ? candidate : null;
}

function openCacheDatabase(
  idb: IDBFactory,
  dbName: string,
  storeName: string,
): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = idb.open(dbName, IDB_CACHE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(storeName)) {
        db.createObjectStore(storeName, { keyPath: 'key' });
      }
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error(`Failed to open IndexedDB cache "${dbName}".`));
    };
    request.onblocked = () => {
      reject(new Error(`IndexedDB cache "${dbName}" open request was blocked.`));
    };
  });
}

async function runCacheTransaction<T>(
  idb: IDBFactory,
  dbName: string,
  storeName: string,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openCacheDatabase(idb, dbName, storeName);
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(storeName, mode);
      const store = tx.objectStore(storeName);
      let settled = false;
      let resultValue: T | undefined;
      let hasResult = false;

      const request = action(store);
      request.onsuccess = () => {
        resultValue = request.result;
        hasResult = true;
      };
      request.onerror = () => {
        if (!settled) {
          settled = true;
          reject(request.error ?? new Error('IndexedDB cache request failed.'));
        }
      };

      tx.oncomplete = () => {
        if (!settled) {
          settled = true;
          resolve((hasResult ? resultValue : undefined) as T);
        }
      };
      tx.onerror = () => {
        if (!settled) {
          settled = true;
          reject(tx.error ?? new Error('IndexedDB cache transaction failed.'));
        }
      };
      tx.onabort = () => {
        if (!settled) {
          settled = true;
          reject(tx.error ?? new Error('IndexedDB cache transaction was aborted.'));
        }
      };
    });
  } finally {
    db.close();
  }
}

/**
 * Creates an IndexedDB-backed cache storage adapter.
 * Degrades cleanly to no-op storage if `indexedDB` is unavailable.
 */
export function createIndexedDbCacheBackend(
  options: IndexedDbCacheBackendOptions = {},
): IdbCacheBackend {
  const dbName = options.dbName ?? DEFAULT_IDB_CACHE_DB_NAME;
  const storeName = options.storeName ?? DEFAULT_IDB_CACHE_STORE_NAME;
  const hasExplicitIdb = 'indexedDB' in options;

  const getIdb = (): IDBFactory | null =>
    hasExplicitIdb ? (options.indexedDB ?? null) : resolveIndexedDb();

  return {
    async get(key: string): Promise<IdbCacheRecord | null> {
      const idb = getIdb();
      if (idb === null) {
        return null;
      }
      const raw: unknown = await runCacheTransaction<unknown>(
        idb,
        dbName,
        storeName,
        'readonly',
        (store) => store.get(key) as IDBRequest<unknown>,
      );
      return isValidCacheRecord(raw) ? raw : null;
    },

    async put(record: IdbCacheRecord): Promise<void> {
      const idb = getIdb();
      if (idb === null) {
        return;
      }
      await runCacheTransaction<IDBValidKey>(idb, dbName, storeName, 'readwrite', (store) =>
        store.put(record),
      );
    },

    async delete(key: string): Promise<void> {
      const idb = getIdb();
      if (idb === null) {
        return;
      }
      await runCacheTransaction<undefined>(idb, dbName, storeName, 'readwrite', (store) =>
        store.delete(key),
      );
    },

    async clear(): Promise<void> {
      const idb = getIdb();
      if (idb === null) {
        return;
      }
      await runCacheTransaction<undefined>(idb, dbName, storeName, 'readwrite', (store) =>
        store.clear(),
      );
    },

    async listMetadata(): Promise<readonly IdbCacheEntryMeta[]> {
      const idb = getIdb();
      if (idb === null) {
        return [];
      }
      const rawAll: unknown = await runCacheTransaction<unknown>(
        idb,
        dbName,
        storeName,
        'readonly',
        (store) => store.getAll() as IDBRequest<unknown>,
      );
      if (!Array.isArray(rawAll)) {
        return [];
      }
      const result: IdbCacheEntryMeta[] = [];
      for (const item of rawAll) {
        if (isValidCacheRecord(item)) {
          result.push(toEntryMeta(item));
        }
      }
      return result;
    },
  };
}

/**
 * Lightweight in-memory backend implementing `IdbCacheBackend` (for unit tests and non-IDB environments).
 */
export function createMemoryIdbCacheBackend(): IdbCacheBackend {
  const entries = new Map<string, IdbCacheRecord>();

  return {
    async get(key: string): Promise<IdbCacheRecord | null> {
      const record = entries.get(key);
      if (record === undefined) {
        return null;
      }
      return {
        ...record,
        value: record.value.slice(0),
      };
    },

    async put(record: IdbCacheRecord): Promise<void> {
      entries.set(record.key, {
        ...record,
        value: record.value.slice(0),
      });
    },

    async delete(key: string): Promise<void> {
      entries.delete(key);
    },

    async clear(): Promise<void> {
      entries.clear();
    },

    async listMetadata(): Promise<readonly IdbCacheEntryMeta[]> {
      const result: IdbCacheEntryMeta[] = [];
      for (const record of entries.values()) {
        result.push(toEntryMeta(record));
      }
      return result;
    },
  };
}

function compareOldestFirst(a: IdbCacheEntryMeta, b: IdbCacheEntryMeta): number {
  if (a.accessedAt !== b.accessedAt) {
    return a.accessedAt - b.accessedAt;
  }
  if (a.seq !== b.seq) {
    return a.seq - b.seq;
  }
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Versioned, size-bounded binary cache (`key -> ArrayBuffer`) backed by IndexedDB (ROADMAP §4.4, M1.7).
 *
 * - Evicts oldest entries (LRU by `accessedAt`, tie-broken by monotonic `seq`) when `maxBytes` would be exceeded.
 * - Automatically invalidates entries written under an older/mismatched `version`.
 */
export class IdbCache {
  readonly version: string;
  readonly maxBytes: number;
  private readonly backend: IdbCacheBackend;
  private readonly now: () => number;
  private seqCounter = 0;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(options: IdbCacheOptions = {}) {
    const version = options.version ?? DEFAULT_IDB_CACHE_VERSION;
    if (version.trim().length === 0) {
      throw new RangeError('IdbCache version must be a non-empty string');
    }

    const maxBytes = options.maxBytes ?? DEFAULT_IDB_CACHE_MAX_BYTES;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
      throw new RangeError(
        `IdbCache maxBytes must be a non-negative safe integer, got ${String(maxBytes)}`,
      );
    }

    this.version = version;
    this.maxBytes = maxBytes;
    this.backend = options.backend ?? createIndexedDbCacheBackend();
    this.now = options.now ?? (() => Date.now());
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.operationQueue.then(task, task);
    this.operationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private nextSequence(existing: readonly IdbCacheEntryMeta[]): number {
    let maxExistingSeq = this.seqCounter;
    for (const item of existing) {
      if (item.seq > maxExistingSeq) {
        maxExistingSeq = item.seq;
      }
    }
    this.seqCounter = maxExistingSeq + 1;
    return this.seqCounter;
  }

  async get(key: string): Promise<ArrayBuffer | null> {
    return this.enqueue(async () => {
      const record = await this.backend.get(key);
      if (record === null) {
        return null;
      }
      if (record.version !== this.version) {
        await this.backend.delete(key);
        return null;
      }

      const nextSeq = Math.max(this.seqCounter, record.seq) + 1;
      this.seqCounter = nextSeq;

      await this.backend.put({
        ...record,
        accessedAt: this.now(),
        seq: nextSeq,
      });

      return record.value.slice(0);
    });
  }

  /**
   * Stores an `ArrayBuffer` under `key`, evicting oldest entries as needed to stay within `maxBytes`.
   * Returns `false` if the single payload exceeds `maxBytes` (without storing it).
   */
  async set(key: string, value: ArrayBuffer): Promise<boolean> {
    return this.enqueue(async () => {
      const payload = value.slice(0);
      const byteLength = payload.byteLength;
      const allMeta = await this.backend.listMetadata();

      // Invalidate any stale-version entries immediately so they never consume budget.
      const activeEntries: IdbCacheEntryMeta[] = [];
      for (const meta of allMeta) {
        if (meta.version !== this.version) {
          await this.backend.delete(meta.key);
        } else if (meta.key !== key) {
          activeEntries.push(meta);
        }
      }

      if (byteLength > this.maxBytes) {
        await this.backend.delete(key);
        return false;
      }

      let totalBytes = 0;
      for (const meta of activeEntries) {
        totalBytes += meta.byteLength;
      }

      if (totalBytes + byteLength > this.maxBytes) {
        activeEntries.sort(compareOldestFirst);
        for (const candidate of activeEntries) {
          if (totalBytes + byteLength <= this.maxBytes) {
            break;
          }
          await this.backend.delete(candidate.key);
          totalBytes -= candidate.byteLength;
        }
      }

      const record: IdbCacheRecord = {
        key,
        version: this.version,
        value: payload,
        byteLength,
        accessedAt: this.now(),
        seq: this.nextSequence(allMeta),
      };

      await this.backend.put(record);
      return true;
    });
  }

  async delete(key: string): Promise<void> {
    return this.enqueue(async () => {
      await this.backend.delete(key);
    });
  }

  /**
   * Removes all entries belonging to versions other than `this.version`.
   * Returns the number of purged entries.
   */
  async purgeStale(): Promise<number> {
    return this.enqueue(async () => {
      const allMeta = await this.backend.listMetadata();
      let purged = 0;
      for (const meta of allMeta) {
        if (meta.version !== this.version) {
          await this.backend.delete(meta.key);
          purged += 1;
        }
      }
      return purged;
    });
  }

  async clear(): Promise<void> {
    return this.enqueue(async () => {
      await this.backend.clear();
      this.seqCounter = 0;
    });
  }

  async getStats(): Promise<IdbCacheStats> {
    return this.enqueue(async () => {
      const allMeta = await this.backend.listMetadata();
      let entryCount = 0;
      let totalBytes = 0;
      for (const meta of allMeta) {
        if (meta.version === this.version) {
          entryCount += 1;
          totalBytes += meta.byteLength;
        }
      }
      return {
        entryCount,
        totalBytes,
        maxBytes: this.maxBytes,
        version: this.version,
      };
    });
  }
}
