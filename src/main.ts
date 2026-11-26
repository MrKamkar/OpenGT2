import './ui/styles.css';
import { AppStateMachine } from './app/appState';
import {
  WEBGL2_UNSUPPORTED_MESSAGE,
  detectCapabilities,
  getBlockingCapabilityError,
} from './app/capabilities';
import {
  InputManager,
  attachDomInputBridge,
  installInputDebugHook,
} from './core/input';
import { GlContext, WebGL2UnavailableError } from './renderer/GlContext';
import {
  BlobByteSource,
  DEFAULT_IDB_CACHE_VERSION,
  FileHandleStore,
  IdbCache,
  fingerprint,
  pickVolFileWithHandle,
} from './io';
import { extractFileMeta, mountFileLoaderScreen } from './ui/fileLoaderScreen';
import { type ArchivePanelHandle, mountArchivePanel } from './ui/explorer/explorerView';
import { describeVolOpenError, loadAllVolEntries } from './app/volArchiveSession';
import { createHealthWorker } from './workers/createHealthWorker';
import { createImageDecoderWorker } from './workers/createImageDecoderWorker';
import { createScannerWorker } from './workers/createScannerWorker';
import { createVolReaderWorker } from './workers/createVolReaderWorker';
import type { ImageDecoderRpcSchema } from './workers/imageDecoderProtocol';
import { ScannerRpcClient } from './workers/scannerProtocol';
import { VolReaderRpcClient } from './workers/volReaderProtocol';
import { TaskPriority, WorkerPool } from './workers/WorkerPool';
import type { HealthPingMessage, HealthPongMessage } from './workers/health.worker';

const MAX_INPUT_DT_SECONDS = 0.1;

function startInputUpdateLoop(inputManager: InputManager): void {
  if (typeof requestAnimationFrame !== 'function') {
    return;
  }

  let lastTimestampMs: number | null = null;
  const tick = (timestampMs: number): void => {
    if (lastTimestampMs !== null) {
      const dtSeconds = Math.min(MAX_INPUT_DT_SECONDS, Math.max(0, (timestampMs - lastTimestampMs) / 1000));
      inputManager.update(dtSeconds);
    }
    lastTimestampMs = timestampMs;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export function initApp(): void {
  const root = document.getElementById('app');
  if (root === null) {
    return;
  }
  root.dataset['engine'] = 'opengt2';

  const capabilities = detectCapabilities();
  root.dataset['capWebgl2'] = String(capabilities.webgl2);
  root.dataset['capGzip'] = String(capabilities.gzipDecompressionStream);
  root.dataset['capModuleWorker'] = String(capabilities.moduleWorker);
  root.dataset['capFilePicker'] = String(capabilities.showOpenFilePicker);

  const canvas = document.createElement('canvas');
  canvas.className = 'ogt2-canvas';
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', 'OpenGT2 WebGL2 viewport');
  root.append(canvas);

  const inputManager = new InputManager({ initialContext: 'menu' });
  installInputDebugHook(window, window.location.search, inputManager);

  const stateMachine = new AppStateMachine();
  const blockingError = getBlockingCapabilityError(capabilities);

  if (blockingError !== null) {
    root.dataset['webgl2'] = 'unavailable';
    stateMachine.dispatch({
      type: 'FAIL',
      message: blockingError,
    });
  } else {
    try {
      new GlContext(canvas, {
        onContextLost(): void {
          root.dataset['webgl2'] = 'lost';
        },
        onContextRestored(): void {
          root.dataset['webgl2'] = 'ready';
        },
      });
      root.dataset['webgl2'] = 'ready';
    } catch (error: unknown) {
      root.dataset['webgl2'] = 'unavailable';
      if (error instanceof WebGL2UnavailableError) {
        stateMachine.dispatch({
          type: 'FAIL',
          message: WEBGL2_UNSUPPORTED_MESSAGE,
        });
      } else {
        throw error;
      }
    }
  }

  let selectionGeneration = 0;
  let volSession: VolReaderRpcClient | null = null;
  let scannerSession: ScannerRpcClient | null = null;
  let imageDecoderPool: WorkerPool<ImageDecoderRpcSchema> | null = null;
  let archivePanel: ArchivePanelHandle | null = null;

  const closeVolSession = (): void => {
    if (volSession !== null) {
      volSession.dispose(true);
      volSession = null;
    }
    if (scannerSession !== null) {
      scannerSession.dispose(true);
      scannerSession = null;
    }
    if (imageDecoderPool !== null) {
      imageDecoderPool.dispose();
      imageDecoderPool = null;
    }
  };

  const ensureScannerSession = (): ScannerRpcClient => {
    if (scannerSession === null) {
      scannerSession = new ScannerRpcClient(createScannerWorker());
    }
    return scannerSession;
  };

  const ensureImageDecoderPool = (): WorkerPool<ImageDecoderRpcSchema> => {
    if (imageDecoderPool === null) {
      imageDecoderPool = new WorkerPool<ImageDecoderRpcSchema>({
        createWorker: createImageDecoderWorker,
      });
    }
    return imageDecoderPool;
  };

  /**
   * Opens the selected archive in a fresh `VolReader` worker (M2.8). The `File` object is
   * posted to the worker as a Blob reference; its contents are only range-read there.
   */
  const openVolArchive = (file: File, generation: number): void => {
    closeVolSession();
    const panel = archivePanel;
    if (panel === null) {
      return;
    }
    panel.showLoading(file.name);

    if (typeof Worker === 'undefined') {
      panel.showError('Ta przeglądarka nie obsługuje Web Workerów — eksplorator archiwum jest niedostępny.');
      return;
    }

    let client: VolReaderRpcClient;
    try {
      client = new VolReaderRpcClient(createVolReaderWorker());
    } catch (error: unknown) {
      panel.showError(describeVolOpenError(error));
      return;
    }
    volSession = client;

    const isCurrent = (): boolean => generation === selectionGeneration && volSession === client;

    void client
      .open(file, { lastModified: file.lastModified })
      .then(async (info) => {
        const entries = await loadAllVolEntries((dir) => client.list(dir));
        return { info, entries };
      })
      .then(({ info, entries }) => {
        if (!isCurrent()) {
          return;
        }
        panel.showArchive(info, entries, {
          stat: (path, signal) => client.stat(path, { signal }),
          readRaw: (path, signal) => client.read(path, signal !== undefined ? { signal } : undefined),
          readRange: (path, start, end, signal) =>
            client.readRange(path, start, end, signal !== undefined ? { signal } : undefined),
          readDecompressed: (path, signal) =>
            client.readDecompressed(path, signal !== undefined ? { signal } : undefined),
          readDecompressedRange: (path, start, end, signal) =>
            client.readDecompressedRange(path, start, end, signal !== undefined ? { signal } : undefined),
          scanEntry: (entry, scanOptions) => {
            if (typeof Worker === 'undefined') {
              return Promise.reject(new Error('Przeglądarka nie obsługuje Web Workerów.'));
            }
            return ensureScannerSession().scanBlobRange(
              {
                blob: file,
                start: entry.address,
                end: entry.address + entry.size,
                decompress: scanOptions.decompress,
                pattern: scanOptions.pattern,
                ...(scanOptions.maxHits !== undefined ? { maxHits: scanOptions.maxHits } : {}),
              },
              {
                ...(scanOptions.signal !== undefined ? { signal: scanOptions.signal } : {}),
                ...(scanOptions.onProgress !== undefined
                  ? { onProgress: scanOptions.onProgress }
                  : {}),
              },
            );
          },
          imageDecoder: {
            decodeImage: (entry, idxCandidates, decodeOptions) => {
              if (typeof Worker === 'undefined') {
                return Promise.reject(new Error('Przeglądarka nie obsługuje Web Workerów.'));
              }
              return ensureImageDecoderPool().exec(
                'decodeImage',
                {
                  blob: file,
                  entry: { path: entry.path, address: entry.address, size: entry.size },
                  idxCandidates,
                  ...(decodeOptions?.entryIndex !== undefined
                    ? { entryIndex: decodeOptions.entryIndex }
                    : {}),
                  ...(decodeOptions?.paletteIndex !== undefined
                    ? { paletteIndex: decodeOptions.paletteIndex }
                    : {}),
                  ...(decodeOptions?.transparencyMode !== undefined
                    ? { transparencyMode: decodeOptions.transparencyMode }
                    : {}),
                  ...(decodeOptions?.viewMode !== undefined
                    ? { viewMode: decodeOptions.viewMode }
                    : {}),
                  ...(decodeOptions?.maxThumbDimension !== undefined
                    ? { maxThumbDimension: decodeOptions.maxThumbDimension }
                    : {}),
                },
                {
                  priority: decodeOptions?.priority ?? TaskPriority.Normal,
                  ...(decodeOptions?.signal !== undefined
                    ? { signal: decodeOptions.signal }
                    : {}),
                },
              );
            },
          },
        });
      })
      .catch((error: unknown) => {
        if (!isCurrent()) {
          return;
        }
        closeVolSession();
        panel.showError(describeVolOpenError(error));
      });
  };

  const openFile = (file: File): void => {
    selectionGeneration += 1;
    const activeGeneration = selectionGeneration;

    const meta = extractFileMeta(file);
    stateMachine.dispatch({
      type: 'FILE_SELECTED',
      file: meta,
    });

    openVolArchive(file, activeGeneration);

    const source = new BlobByteSource(file);
    void fingerprint(source, { lastModified: file.lastModified })
      .then((fileFingerprint) => {
        if (activeGeneration !== selectionGeneration) {
          return;
        }
        if (stateMachine.getState().kind !== 'Loading') {
          return;
        }
        stateMachine.dispatch({
          type: 'LOAD_SUCCEEDED',
          fingerprint: fileFingerprint,
        });
      })
      .catch((error: unknown) => {
        if (activeGeneration !== selectionGeneration) {
          return;
        }
        if (stateMachine.getState().kind !== 'Loading') {
          return;
        }
        const message =
          error instanceof Error
            ? `Nie udało się obliczyć odcisku pliku: ${error.message}`
            : 'Nie udało się obliczyć odcisku pliku.';
        stateMachine.dispatch({
          type: 'LOAD_FAILED',
          message,
        });
      });
  };

  const fileHandleStore = new FileHandleStore({
    isSupported: () => capabilities.showOpenFilePicker,
  });
  const idbCache = new IdbCache({
    version: DEFAULT_IDB_CACHE_VERSION,
  });

  const screen = mountFileLoaderScreen({
    container: root,
    stateMachine,
    capabilities,
    onFileSelected: openFile,
    onReset(): void {
      selectionGeneration += 1;
      closeVolSession();
      archivePanel?.clear();
      stateMachine.dispatch({ type: 'RESET' });
    },
    async onClearData(): Promise<void> {
      await Promise.all([idbCache.clear(), fileHandleStore.clearHandle()]);
      screen.setRememberedFile(null);
    },
    async onPickFileWithHandle(): Promise<boolean> {
      try {
        const picked = await pickVolFileWithHandle(window);
        if (picked.status === 'unsupported') {
          return false;
        }
        if (picked.status === 'cancelled') {
          return true;
        }
        try {
          const saved = await fileHandleStore.saveHandle(picked.handle);
          if (saved) {
            screen.setRememberedFile({ name: picked.handle.name });
          }
        } catch {
          // Storage may be unavailable (e.g. restricted private mode); continue opening the file cleanly.
        }
        openFile(picked.file);
        return true;
      } catch {
        return false;
      }
    },
    async onReopenRememberedFile(): Promise<void> {
      try {
        const result = await fileHandleStore.reopenStoredFile({ requestPermission: true });
        switch (result.status) {
          case 'opened':
            screen.setRememberedFile({ name: result.handle.name });
            openFile(result.file);
            break;
          case 'denied':
            screen.setRememberedFile({
              name: result.handle.name,
              note: 'Brak zgody na ponowny dostęp do pliku — wybierz plik ręcznie.',
            });
            break;
          case 'prompt':
            screen.setRememberedFile({
              name: result.handle.name,
              note: 'Wymagana zgoda przeglądarki na odczyt pliku.',
            });
            break;
          case 'error':
            screen.setRememberedFile({
              name: result.handle.name,
              note: 'Nie udało się ponownie otworzyć zapamiętanego pliku — wybierz go ponownie.',
            });
            break;
          case 'empty':
          case 'unsupported':
            screen.setRememberedFile(null);
            break;
        }
      } catch {
        screen.setRememberedFile(null);
      }
    },
  });

  archivePanel = mountArchivePanel({
    container: screen.archiveContainer,
    onVisibilityChange(_visible: boolean, state): void {
      screen.setWide(state === 'ready');
    },
  });

  if (capabilities.showOpenFilePicker) {
    void fileHandleStore
      .loadHandle()
      .then((handle) => {
        if (handle !== null) {
          screen.setRememberedFile({ name: handle.name });
        }
      })
      .catch(() => {
        // Ignore IndexedDB unavailability silently so browsers without storage emit zero console errors.
      });
  }

  attachDomInputBridge({
    inputManager,
    canvas,
  });
  startInputUpdateLoop(inputManager);

  if (typeof Worker === 'undefined') {
    return;
  }

  const worker = createHealthWorker();
  worker.addEventListener('message', (event: MessageEvent<HealthPongMessage>) => {
    if (event.data.type === 'pong') {
      root.dataset['worker'] = 'ready';
      worker.terminate();
    }
  });
  const ping: HealthPingMessage = { type: 'ping' };
  worker.postMessage(ping);
}

initApp();
