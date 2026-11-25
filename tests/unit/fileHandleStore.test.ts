import { describe, expect, it, vi } from 'vitest';
import {
  FileHandleStore,
  createIndexedDbFileHandleBackend,
  ensureFileHandleReadPermission,
  isFileSystemAccessApiAvailable,
  pickVolFileWithHandle,
  type FileHandleKeyValueBackend,
  type FileHandlePermissionState,
  type FileSystemFileHandleLike,
} from '../../src/io';

function createMemoryHandleBackend(): FileHandleKeyValueBackend {
  const map = new Map<string, FileSystemFileHandleLike>();
  return {
    async get(key: string): Promise<FileSystemFileHandleLike | null> {
      return map.get(key) ?? null;
    },
    async set(key: string, value: FileSystemFileHandleLike): Promise<void> {
      map.set(key, value);
    },
    async delete(key: string): Promise<void> {
      map.delete(key);
    },
  };
}

function createFakeFile(name: string): File {
  return {
    name,
    size: 1024,
    lastModified: 1_700_000_000_000,
  } as unknown as File;
}

interface FakeHandleConfig {
  readonly name?: string;
  readonly queryState?: FileHandlePermissionState;
  readonly requestState?: FileHandlePermissionState;
  readonly omitPermissionMethods?: boolean;
  readonly getFileError?: Error;
}

function createFakeHandle(config: FakeHandleConfig = {}): {
  handle: FileSystemFileHandleLike;
  file: File;
  querySpy: ReturnType<typeof vi.fn>;
  requestSpy: ReturnType<typeof vi.fn>;
  getFileSpy: ReturnType<typeof vi.fn>;
} {
  const name = config.name ?? 'GT2.VOL';
  const file = createFakeFile(name);
  const querySpy = vi.fn(async () => config.queryState ?? 'granted');
  const requestSpy = vi.fn(async () => config.requestState ?? 'granted');
  const getFileSpy = vi.fn(async () => {
    if (config.getFileError !== undefined) {
      throw config.getFileError;
    }
    return file;
  });

  const handle: FileSystemFileHandleLike = config.omitPermissionMethods
    ? {
        kind: 'file',
        name,
        getFile: getFileSpy,
      }
    : {
        kind: 'file',
        name,
        getFile: getFileSpy,
        queryPermission: querySpy,
        requestPermission: requestSpy,
      };

  return { handle, file, querySpy, requestSpy, getFileSpy };
}

describe('FileHandleStore (M1.6)', () => {
  it('saves, loads, and clears a FileSystemFileHandle through its persistence backend', async () => {
    const backend = createMemoryHandleBackend();
    const store = new FileHandleStore({ backend, isSupported: () => true });
    const { handle } = createFakeHandle({ name: 'MY_GT2.VOL' });

    expect(await store.loadHandle()).toBeNull();
    expect(await store.saveHandle(handle)).toBe(true);
    expect(await store.loadHandle()).toBe(handle);

    await store.clearHandle();
    expect(await store.loadHandle()).toBeNull();
  });

  it('reopens stored file immediately when queryPermission returns granted', async () => {
    const backend = createMemoryHandleBackend();
    const store = new FileHandleStore({ backend, isSupported: () => true });
    const { handle, file, querySpy, requestSpy, getFileSpy } = createFakeHandle({
      queryState: 'granted',
    });

    await store.saveHandle(handle);
    const result = await store.reopenStoredFile({ requestPermission: true });

    expect(result).toEqual({ status: 'opened', file, handle });
    expect(querySpy).toHaveBeenCalledWith({ mode: 'read' });
    expect(requestSpy).not.toHaveBeenCalled();
    expect(getFileSpy).toHaveBeenCalledTimes(1);
  });

  it('requests permission when status is prompt and opens file after user grants consent', async () => {
    const backend = createMemoryHandleBackend();
    const store = new FileHandleStore({ backend, isSupported: () => true });
    const { handle, file, querySpy, requestSpy } = createFakeHandle({
      queryState: 'prompt',
      requestState: 'granted',
    });

    await store.saveHandle(handle);

    // Without requesting (e.g. passive check on startup), stays in prompt without calling requestPermission.
    const passive = await store.reopenStoredFile({ requestPermission: false });
    expect(passive).toEqual({ status: 'prompt', handle });
    expect(requestSpy).not.toHaveBeenCalled();

    // With user gesture (requestPermission: true), requests and opens.
    const active = await store.reopenStoredFile({ requestPermission: true });
    expect(active).toEqual({ status: 'opened', file, handle });
    expect(querySpy).toHaveBeenCalledTimes(2);
    expect(requestSpy).toHaveBeenCalledWith({ mode: 'read' });
  });

  it('reports denied cleanly when user refuses permission or permission is already denied', async () => {
    const backend = createMemoryHandleBackend();
    const store = new FileHandleStore({ backend, isSupported: () => true });

    const promptDenied = createFakeHandle({
      queryState: 'prompt',
      requestState: 'denied',
    });
    await store.saveHandle(promptDenied.handle);
    expect(await store.reopenStoredFile({ requestPermission: true })).toEqual({
      status: 'denied',
      handle: promptDenied.handle,
    });
    expect(promptDenied.getFileSpy).not.toHaveBeenCalled();

    const alreadyDenied = createFakeHandle({ queryState: 'denied' });
    await store.saveHandle(alreadyDenied.handle);
    expect(await store.reopenStoredFile({ requestPermission: true })).toEqual({
      status: 'denied',
      handle: alreadyDenied.handle,
    });
    expect(alreadyDenied.requestSpy).not.toHaveBeenCalled();
  });

  it('degrades cleanly when File System Access API or permission methods are unavailable', async () => {
    const backend = createMemoryHandleBackend();
    const unsupportedStore = new FileHandleStore({ backend, isSupported: () => false });
    const { handle } = createFakeHandle();

    expect(unsupportedStore.isSupported()).toBe(false);
    expect(await unsupportedStore.saveHandle(handle)).toBe(false);
    expect(await unsupportedStore.loadHandle()).toBeNull();
    expect(await unsupportedStore.reopenStoredFile()).toEqual({ status: 'unsupported' });

    const noPermHandle = createFakeHandle({ omitPermissionMethods: true });
    expect(await ensureFileHandleReadPermission(noPermHandle.handle)).toEqual({
      status: 'unsupported',
    });

    // Default IndexedDB backend degrades cleanly to no-op when indexedDB is absent.
    const idbMissingBackend = createIndexedDbFileHandleBackend({ indexedDB: undefined });
    await expect(idbMissingBackend.set('k', handle)).resolves.toBeUndefined();
    await expect(idbMissingBackend.get('k')).resolves.toBeNull();
    await expect(idbMissingBackend.delete('k')).resolves.toBeUndefined();
  });

  it('returns empty when no handle is saved and error when getFile throws', async () => {
    const backend = createMemoryHandleBackend();
    const store = new FileHandleStore({ backend, isSupported: () => true });

    expect(await store.reopenStoredFile()).toEqual({ status: 'empty' });

    const broken = createFakeHandle({
      queryState: 'granted',
      getFileError: new Error('File moved or deleted'),
    });
    await store.saveHandle(broken.handle);
    expect(await store.reopenStoredFile()).toEqual({
      status: 'error',
      message: 'File moved or deleted',
      handle: broken.handle,
    });
  });

  it('handles showOpenFilePicker detection, pick, cancel (AbortError), and missing API', async () => {
    expect(isFileSystemAccessApiAvailable({})).toBe(false);
    expect(await pickVolFileWithHandle({})).toEqual({ status: 'unsupported' });

    const { handle, file } = createFakeHandle({ name: 'DISC1.VOL' });
    const hostSuccess = {
      showOpenFilePicker: vi.fn(async () => [handle]),
    };
    expect(isFileSystemAccessApiAvailable(hostSuccess)).toBe(true);
    expect(await pickVolFileWithHandle(hostSuccess)).toEqual({
      status: 'picked',
      file,
      handle,
    });

    const abortError = new Error('User aborted request');
    abortError.name = 'AbortError';
    const hostCancel = {
      showOpenFilePicker: vi.fn(async () => {
        throw abortError;
      }),
    };
    expect(await pickVolFileWithHandle(hostCancel)).toEqual({ status: 'cancelled' });
  });
});
