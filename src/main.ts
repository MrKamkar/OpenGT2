import './ui/styles.css';
import { AppStateMachine } from './app/appState';
import {
  WEBGL2_UNSUPPORTED_MESSAGE,
  detectCapabilities,
  getBlockingCapabilityError,
} from './app/capabilities';
import { AssetRepository } from './assets';
import {
  InputManager,
  attachDomInputBridge,
  installInputDebugHook,
  isDebugMode,
} from './core/input';
import { findGtdbEntries, pairGtdbRegionVariants } from './formats/gtdb';
import {
  CarViewerSession,
  DriveSession,
  GlContext,
  TrackViewerSession,
  WebGL2UnavailableError,
} from './renderer';
import {
  BlobByteSource,
  DEFAULT_IDB_CACHE_VERSION,
  FileHandleStore,
  IdbCache,
  fingerprint,
  pickVolFileWithHandle,
} from './io';
import { parseHexHash } from './tools/hexview';
import { type CarViewerHandle, installViewerDebugHook, mountCarViewer } from './ui/carViewer';
import {
  type TrackViewerHandle,
  installTrackViewerDebugHook,
  mountTrackViewer,
} from './ui/trackViewer';
import { type DriveViewHandle, installDriveDebugHook, mountDriveView } from './ui/drive';
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

function startInputUpdateLoop(
  inputManager: InputManager,
  isExternalUpdateActive: () => boolean,
): void {
  if (typeof requestAnimationFrame !== 'function') {
    return;
  }

  let lastTimestampMs: number | null = null;
  const tick = (timestampMs: number): void => {
    if (lastTimestampMs !== null && !isExternalUpdateActive()) {
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
  const debugMode = isDebugMode(window.location.search);
  installInputDebugHook(window, window.location.search, inputManager);

  const stateMachine = new AppStateMachine();
  const blockingError = getBlockingCapabilityError(capabilities);
  let glContext: GlContext | null = null;

  if (blockingError !== null) {
    root.dataset['webgl2'] = 'unavailable';
    stateMachine.dispatch({
      type: 'FAIL',
      message: blockingError,
    });
  } else {
    try {
      glContext = new GlContext(canvas, {
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
  let assetRepository: AssetRepository | null = null;
  let carViewerSession: CarViewerSession | null = null;
  let carViewerHandle: CarViewerHandle | null = null;
  let uninstallViewerDebugHook: (() => void) | null = null;
  let trackViewerSession: TrackViewerSession | null = null;
  let trackViewerHandle: TrackViewerHandle | null = null;
  let uninstallTrackViewerDebugHook: (() => void) | null = null;
  let driveSession: DriveSession | null = null;
  let driveHandle: DriveViewHandle | null = null;
  let uninstallDriveDebugHook: (() => void) | null = null;
  let hasActiveViewer = false;
  let hasActiveTrackViewer = false;
  let hasActiveDrive = false;

  const setActiveMode = (mode: 'loader' | 'viewer' | 'tracks' | 'drive' | 'inspector'): void => {
    carViewerSession?.pause();
    trackViewerSession?.pause();
    driveSession?.pause();
    carViewerHandle?.setVisible(false);
    trackViewerHandle?.setVisible(false);
    driveHandle?.setVisible(false);
    inputManager.releaseAll();

    const navState = {
      hasViewer: hasActiveViewer,
      hasTracks: hasActiveTrackViewer,
      hasDrive: hasActiveDrive,
    };

    if (mode === 'viewer' && hasActiveViewer && carViewerSession !== null && carViewerHandle !== null) {
      screen.setAppViewMode('viewer', navState);
      carViewerHandle.setVisible(true);
      inputManager.setContext('viewer');
      carViewerSession.start();
      carViewerSession.renderCurrentFrame();
      canvas.focus({ preventScroll: true });
      return;
    }

    if (mode === 'tracks' && hasActiveTrackViewer && trackViewerSession !== null && trackViewerHandle !== null) {
      screen.setAppViewMode('tracks', navState);
      trackViewerHandle.setVisible(true);
      inputManager.setContext('freecam');
      trackViewerSession.start();
      trackViewerHandle.ensureInitialTrackLoaded();
      trackViewerSession.renderCurrentFrame();
      canvas.focus({ preventScroll: true });
      return;
    }

    if (mode === 'drive' && hasActiveDrive && driveSession !== null && driveHandle !== null) {
      screen.setAppViewMode('drive', navState);
      driveHandle.setVisible(true);
      inputManager.setContext('race');
      driveSession.start();
      driveHandle.ensureInitialSessionLoaded();
      driveSession.renderCurrentFrame();
      canvas.focus({ preventScroll: true });
      return;
    }

    inputManager.setContext('menu');
    screen.setAppViewMode(
      mode === 'viewer' || mode === 'tracks' || mode === 'drive' ? 'inspector' : mode,
      navState,
    );
  };

  const closeViewerSession = (): void => {
    hasActiveViewer = false;
    hasActiveTrackViewer = false;
    hasActiveDrive = false;
    uninstallViewerDebugHook?.();
    uninstallViewerDebugHook = null;
    uninstallTrackViewerDebugHook?.();
    uninstallTrackViewerDebugHook = null;
    uninstallDriveDebugHook?.();
    uninstallDriveDebugHook = null;
    carViewerHandle?.dispose();
    carViewerHandle = null;
    carViewerSession?.dispose();
    carViewerSession = null;
    trackViewerHandle?.dispose();
    trackViewerHandle = null;
    trackViewerSession?.dispose();
    trackViewerSession = null;
    driveHandle?.dispose();
    driveHandle = null;
    driveSession?.dispose();
    driveSession = null;
    assetRepository?.dispose();
    assetRepository = null;
    glContext?.clear();
    inputManager.releaseAll();
    inputManager.setContext('menu');
  };

  const closeVolSession = (): void => {
    closeViewerSession();
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
    screen.setAppViewMode('loader');
    const panel = archivePanel;
    if (panel === null) {
      return;
    }
    panel.showLoading(file.name);

    if (typeof Worker === 'undefined') {
      panel.showError('This browser does not support Web Workers — archive inspector is unavailable.');
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
              return Promise.reject(new Error('This browser does not support Web Workers.'));
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
                return Promise.reject(new Error('This browser does not support Web Workers.'));
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
          loadCarCatalog: (params, signal) =>
            client.loadCarCatalog(params, signal !== undefined ? { signal } : undefined),
        });

        const carVariants = pairGtdbRegionVariants(findGtdbEntries(entries));
        const repo = new AssetRepository({
          volInfo: info,
          entries,
          backend: client,
        });
        assetRepository = repo;

        const canViewCars =
          glContext !== null && carVariants.length > 0 && repo.carAssetIndex.indexedBodyCount > 0;
        const canViewTracks = glContext !== null && repo.trackAssetIndex.trackCount > 0;
        const canDrive = canViewCars && canViewTracks;

        if (canViewCars && glContext !== null) {
          let viewerHandleRef: CarViewerHandle | null = null;
          const viewerSession = new CarViewerSession({
            glContext,
            canvas,
            inputManager,
            assetRepository: repo,
            initialMode: 'hd',
            onStateChange(snapshot): void {
              viewerHandleRef?.updateState(snapshot);
            },
            onStatsUpdate(stats): void {
              viewerHandleRef?.updateDebugStats(stats);
            },
          });
          viewerHandleRef = mountCarViewer({
            container: root,
            canvas,
            fileName: file.name,
            variants: carVariants,
            loadCarCatalog: (params, signal) =>
              client.loadCarCatalog(params, signal !== undefined ? { signal } : undefined),
            assetRepository: repo,
            session: viewerSession,
            debugMode,
            hasTrackViewer: canViewTracks,
            hasDrive: canDrive,
            onSwitchToTracks(): void {
              setActiveMode('tracks');
            },
            onSwitchToDrive(): void {
              setActiveMode('drive');
            },
            onSwitchToInspector(): void {
              setActiveMode('inspector');
            },
            onResetFile: resetLoadedArchive,
          });
          carViewerSession = viewerSession;
          carViewerHandle = viewerHandleRef;
          uninstallViewerDebugHook = installViewerDebugHook(
            window,
            window.location.search,
            viewerSession,
          );
          hasActiveViewer = true;
        } else {
          hasActiveViewer = false;
        }

        if (canViewTracks && glContext !== null) {
          let trackHandleRef: TrackViewerHandle | null = null;
          const tSession = new TrackViewerSession({
            glContext,
            canvas,
            inputManager,
            assetRepository: repo,
            initialMode: 'hd',
            onStateChange(snapshot): void {
              trackHandleRef?.updateState(snapshot);
            },
            onStatsUpdate(stats): void {
              trackHandleRef?.updateDebugStats(stats);
            },
          });
          trackHandleRef = mountTrackViewer({
            container: root,
            canvas,
            fileName: file.name,
            assetRepository: repo,
            session: tSession,
            debugMode,
            hasCarViewer: hasActiveViewer,
            hasDrive: canDrive,
            onSwitchToCarViewer(): void {
              setActiveMode('viewer');
            },
            onSwitchToDrive(): void {
              setActiveMode('drive');
            },
            onSwitchToInspector(): void {
              setActiveMode('inspector');
            },
            onResetFile: resetLoadedArchive,
          });
          trackViewerSession = tSession;
          trackViewerHandle = trackHandleRef;
          uninstallTrackViewerDebugHook = installTrackViewerDebugHook(
            window,
            window.location.search,
            tSession,
          );
          hasActiveTrackViewer = true;
        } else {
          hasActiveTrackViewer = false;
        }

        if (canDrive && glContext !== null) {
          let driveHandleRef: DriveViewHandle | null = null;
          const dSession = new DriveSession({
            glContext,
            canvas,
            debugMode,
            inputManager,
            assetRepository: repo,
            initialMode: 'hd',
            onStateChange(snapshot): void {
              driveHandleRef?.updateState(snapshot);
            },
            onTelemetryUpdate(telemetry): void {
              driveHandleRef?.updateTelemetry(telemetry);
            },
            onStatsUpdate(stats): void {
              driveHandleRef?.updateDebugStats(stats);
            },
          });
          driveHandleRef = mountDriveView({
            container: root,
            canvas,
            fileName: file.name,
            variants: carVariants,
            loadCarCatalog: (params, signal) =>
              client.loadCarCatalog(params, signal !== undefined ? { signal } : undefined),
            assetRepository: repo,
            session: dSession,
            debugMode,
            onSwitchToCarViewer(): void {
              setActiveMode('viewer');
            },
            onSwitchToTrackViewer(): void {
              setActiveMode('tracks');
            },
            onSwitchToInspector(): void {
              setActiveMode('inspector');
            },
            onResetFile: resetLoadedArchive,
          });
          driveSession = dSession;
          driveHandle = driveHandleRef;
          uninstallDriveDebugHook = installDriveDebugHook(
            window,
            window.location.search,
            dSession,
          );
          hasActiveDrive = true;
        } else {
          hasActiveDrive = false;
        }

        const startInInspector = parseHexHash(window.location.hash) !== null;
        if (startInInspector) {
          setActiveMode('inspector');
        } else if (hasActiveViewer) {
          setActiveMode('viewer');
        } else if (hasActiveTrackViewer) {
          setActiveMode('tracks');
        } else {
          setActiveMode('inspector');
        }
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
            ? `Failed to compute file fingerprint: ${error.message}`
            : 'Failed to compute file fingerprint.';
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

  const resetLoadedArchive = (): void => {
    selectionGeneration += 1;
    closeVolSession();
    archivePanel?.clear();
    screen.setAppViewMode('loader');
    stateMachine.dispatch({ type: 'RESET' });
  };

  const screen = mountFileLoaderScreen({
    container: root,
    stateMachine,
    capabilities,
    onFileSelected: openFile,
    onReset: resetLoadedArchive,
    onSwitchToViewer(): void {
      setActiveMode('viewer');
    },
    onSwitchToTracks(): void {
      setActiveMode('tracks');
    },
    onSwitchToDrive(): void {
      setActiveMode('drive');
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
              note: 'Permission to reopen file was denied — select the file manually.',
            });
            break;
          case 'prompt':
            screen.setRememberedFile({
              name: result.handle.name,
              note: 'Browser permission is required to read the file.',
            });
            break;
          case 'error':
            screen.setRememberedFile({
              name: result.handle.name,
              note: 'Failed to reopen remembered file — please select it again.',
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

  window.addEventListener('hashchange', () => {
    if (
      (hasActiveViewer || hasActiveTrackViewer || hasActiveDrive) &&
      parseHexHash(window.location.hash) !== null
    ) {
      setActiveMode('inspector');
    }
  });

  attachDomInputBridge({
    inputManager,
    canvas,
  });
  startInputUpdateLoop(inputManager, () => driveSession?.getSnapshot().running === true);

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
