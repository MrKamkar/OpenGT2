export const DEFAULT_FILE_HANDLE_DB_NAME = 'opengt2-file-handles';
export const DEFAULT_FILE_HANDLE_STORE_NAME = 'handles';
export const DEFAULT_FILE_HANDLE_KEY = 'last-vol-handle';
const FILE_HANDLE_DB_VERSION = 1;

export type FileHandlePermissionMode = 'read' | 'readwrite';
export type FileHandlePermissionState = 'granted' | 'denied' | 'prompt';

export interface FileHandlePermissionDescriptor {
  readonly mode?: FileHandlePermissionMode;
}

/**
 * Minimal structural contract matching the File System Access API `FileSystemFileHandle`.
 */
export interface FileSystemFileHandleLike {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<File>;
  queryPermission?(
    descriptor?: FileHandlePermissionDescriptor,
  ): Promise<FileHandlePermissionState>;
  requestPermission?(
    descriptor?: FileHandlePermissionDescriptor,
  ): Promise<FileHandlePermissionState>;
}

export interface OpenFilePickerAcceptType {
  readonly description?: string;
  readonly accept: Readonly<Record<string, readonly string[]>>;
}

export interface OpenFilePickerOptionsLike {
  readonly multiple?: boolean;
  readonly excludeAcceptAllOption?: boolean;
  readonly types?: readonly OpenFilePickerAcceptType[];
}

export type ShowOpenFilePickerFn = (
  options?: OpenFilePickerOptionsLike,
) => Promise<readonly FileSystemFileHandleLike[]>;

/**
 * Minimal key-value persistence backend for storing a single FileSystemFileHandle.
 * Abstracted so unit tests can mock storage without depending on browser IndexedDB.
 */
export interface FileHandleKeyValueBackend {
  get(key: string): Promise<FileSystemFileHandleLike | null>;
  set(key: string, value: FileSystemFileHandleLike): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface IndexedDbFileHandleBackendOptions {
  readonly dbName?: string;
  readonly storeName?: string;
  readonly indexedDB?: IDBFactory | undefined;
}

export type EnsurePermissionResult =
  | { readonly status: 'granted' }
  | { readonly status: 'prompt' }
  | { readonly status: 'denied' }
  | { readonly status: 'unsupported' };

export type ReopenStoredFileResult =
  | { readonly status: 'opened'; readonly file: File; readonly handle: FileSystemFileHandleLike }
  | { readonly status: 'empty' }
  | { readonly status: 'unsupported' }
  | { readonly status: 'prompt'; readonly handle: FileSystemFileHandleLike }
  | { readonly status: 'denied'; readonly handle: FileSystemFileHandleLike }
  | {
      readonly status: 'error';
      readonly message: string;
      readonly handle: FileSystemFileHandleLike;
    };

export type PickFileWithHandleResult =
  | { readonly status: 'picked'; readonly file: File; readonly handle: FileSystemFileHandleLike }
  | { readonly status: 'cancelled' }
  | { readonly status: 'unsupported' };

export interface FileHandleStoreOptions {
  readonly backend?: FileHandleKeyValueBackend;
  readonly key?: string;
  readonly isSupported?: () => boolean;
}

function isFileSystemFileHandleLike(value: unknown): value is FileSystemFileHandleLike {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate['kind'] === 'file' &&
    typeof candidate['name'] === 'string' &&
    typeof candidate['getFile'] === 'function'
  );
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

function openHandleDatabase(
  idb: IDBFactory,
  dbName: string,
  storeName: string,
): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = idb.open(dbName, FILE_HANDLE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(storeName)) {
        db.createObjectStore(storeName);
      }
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onerror = () => {
      reject(request.error ?? new Error(`Failed to open IndexedDB database "${dbName}".`));
    };
    request.onblocked = () => {
      reject(new Error(`IndexedDB database "${dbName}" open request was blocked.`));
    };
  });
}

async function runStoreTransaction<T>(
  idb: IDBFactory,
  dbName: string,
  storeName: string,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await openHandleDatabase(idb, dbName, storeName);
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
          reject(request.error ?? new Error('IndexedDB request failed.'));
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
          reject(tx.error ?? new Error('IndexedDB transaction failed.'));
        }
      };
      tx.onabort = () => {
        if (!settled) {
          settled = true;
          reject(tx.error ?? new Error('IndexedDB transaction was aborted.'));
        }
      };
    });
  } finally {
    db.close();
  }
}

/**
 * Creates an IndexedDB-backed key-value store for `FileSystemFileHandle`.
 * Degrades cleanly to no-op storage if `indexedDB` is unavailable.
 */
export function createIndexedDbFileHandleBackend(
  options: IndexedDbFileHandleBackendOptions = {},
): FileHandleKeyValueBackend {
  const dbName = options.dbName ?? DEFAULT_FILE_HANDLE_DB_NAME;
  const storeName = options.storeName ?? DEFAULT_FILE_HANDLE_STORE_NAME;
  const hasExplicitIdb = 'indexedDB' in options;

  const getIdb = (): IDBFactory | null =>
    hasExplicitIdb ? (options.indexedDB ?? null) : resolveIndexedDb();

  return {
    async get(key: string): Promise<FileSystemFileHandleLike | null> {
      const idb = getIdb();
      if (idb === null) {
        return null;
      }
      const raw: unknown = await runStoreTransaction<unknown>(
        idb,
        dbName,
        storeName,
        'readonly',
        (store) => store.get(key) as IDBRequest<unknown>,
      );
      return isFileSystemFileHandleLike(raw) ? raw : null;
    },

    async set(key: string, value: FileSystemFileHandleLike): Promise<void> {
      const idb = getIdb();
      if (idb === null) {
        return;
      }
      await runStoreTransaction<IDBValidKey>(idb, dbName, storeName, 'readwrite', (store) =>
        store.put(value, key),
      );
    },

    async delete(key: string): Promise<void> {
      const idb = getIdb();
      if (idb === null) {
        return;
      }
      await runStoreTransaction<undefined>(idb, dbName, storeName, 'readwrite', (store) =>
        store.delete(key),
      );
    },
  };
}

/**
 * Returns `showOpenFilePicker` from the provided host object if available, otherwise `null`.
 */
export function getShowOpenFilePicker(host: object = globalThis): ShowOpenFilePickerFn | null {
  const candidate = (host as { readonly showOpenFilePicker?: unknown }).showOpenFilePicker;
  if (typeof candidate !== 'function') {
    return null;
  }
  return (options?: OpenFilePickerOptionsLike) =>
    (candidate as ShowOpenFilePickerFn).call(host, options);
}

/**
 * Returns true when the File System Access API (`showOpenFilePicker`) is available on `host`.
 */
export function isFileSystemAccessApiAvailable(host: object = globalThis): boolean {
  return getShowOpenFilePicker(host) !== null;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { readonly name: unknown }).name === 'AbortError'
  );
}

/**
 * Checks (and optionally requests) read permission on a `FileSystemFileHandle`.
 */
export async function ensureFileHandleReadPermission(
  handle: FileSystemFileHandleLike,
  options: { readonly requestIfNeeded?: boolean } = {},
): Promise<EnsurePermissionResult> {
  const requestIfNeeded = options.requestIfNeeded ?? true;
  const descriptor: FileHandlePermissionDescriptor = { mode: 'read' };

  if (typeof handle.queryPermission !== 'function') {
    if (typeof handle.requestPermission !== 'function') {
      return { status: 'unsupported' };
    }
    if (!requestIfNeeded) {
      return { status: 'prompt' };
    }
    const requested = await handle.requestPermission(descriptor);
    return requested === 'granted' ? { status: 'granted' } : { status: 'denied' };
  }

  const current = await handle.queryPermission(descriptor);
  if (current === 'granted') {
    return { status: 'granted' };
  }
  if (current === 'denied') {
    return { status: 'denied' };
  }

  if (!requestIfNeeded) {
    return { status: 'prompt' };
  }

  if (typeof handle.requestPermission !== 'function') {
    return { status: 'unsupported' };
  }

  const requested = await handle.requestPermission(descriptor);
  return requested === 'granted' ? { status: 'granted' } : { status: 'denied' };
}

/**
 * Prompts the user to select a local `.VOL` archive via `showOpenFilePicker` when supported.
 */
export async function pickVolFileWithHandle(
  host: object = globalThis,
): Promise<PickFileWithHandleResult> {
  const picker = getShowOpenFilePicker(host);
  if (picker === null) {
    return { status: 'unsupported' };
  }

  let handles: readonly FileSystemFileHandleLike[];
  try {
    handles = await picker({
      multiple: false,
      types: [
        {
          description: 'Gran Turismo 2 Archive (GT2.VOL)',
          accept: {
            'application/octet-stream': ['.vol', '.VOL'],
          },
        },
      ],
    });
  } catch (error: unknown) {
    if (isAbortError(error)) {
      return { status: 'cancelled' };
    }
    throw error;
  }

  const handle = handles[0];
  if (handle === undefined) {
    return { status: 'cancelled' };
  }

  const file = await handle.getFile();
  return { status: 'picked', file, handle };
}

/**
 * Persists a single `FileSystemFileHandle` in IndexedDB (when File System Access API is available)
 * and manages permission-gated reopening (ROADMAP §4.4, M1.6).
 */
export class FileHandleStore {
  private readonly backend: FileHandleKeyValueBackend;
  private readonly key: string;
  private readonly supportCheck: () => boolean;

  constructor(options: FileHandleStoreOptions = {}) {
    this.backend = options.backend ?? createIndexedDbFileHandleBackend();
    this.key = options.key ?? DEFAULT_FILE_HANDLE_KEY;
    this.supportCheck = options.isSupported ?? (() => isFileSystemAccessApiAvailable());
  }

  isSupported(): boolean {
    return this.supportCheck();
  }

  async saveHandle(handle: FileSystemFileHandleLike): Promise<boolean> {
    if (!this.isSupported()) {
      return false;
    }
    await this.backend.set(this.key, handle);
    return true;
  }

  async loadHandle(): Promise<FileSystemFileHandleLike | null> {
    if (!this.isSupported()) {
      return null;
    }
    return this.backend.get(this.key);
  }

  async clearHandle(): Promise<void> {
    await this.backend.delete(this.key);
  }

  async reopenStoredFile(
    options: { readonly requestPermission?: boolean } = {},
  ): Promise<ReopenStoredFileResult> {
    if (!this.isSupported()) {
      return { status: 'unsupported' };
    }

    const handle = await this.loadHandle();
    if (handle === null) {
      return { status: 'empty' };
    }

    const permission = await ensureFileHandleReadPermission(handle, {
      requestIfNeeded: options.requestPermission ?? true,
    });

    if (permission.status === 'unsupported') {
      return { status: 'unsupported' };
    }
    if (permission.status === 'prompt') {
      return { status: 'prompt', handle };
    }
    if (permission.status === 'denied') {
      return { status: 'denied', handle };
    }

    try {
      const file = await handle.getFile();
      return { status: 'opened', file, handle };
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : 'Unable to reopen the remembered archive file.';
      return { status: 'error', message, handle };
    }
  }
}
