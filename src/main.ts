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
import { mountFileLoaderScreen, type FileMetaReadable } from './ui/fileLoaderScreen';
import { createHealthWorker } from './workers/createHealthWorker';
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

  mountFileLoaderScreen({
    container: root,
    stateMachine,
    capabilities,
    onFileSelected(file: FileMetaReadable): void {
      stateMachine.dispatch({
        type: 'FILE_SELECTED',
        file: { name: file.name, size: file.size },
      });
      stateMachine.dispatch({ type: 'LOAD_SUCCEEDED' });
    },
    onReset(): void {
      stateMachine.dispatch({ type: 'RESET' });
    },
  });

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
