import './ui/styles.css';
import { AppStateMachine } from './app/appState';
import { GlContext, WebGL2UnavailableError } from './renderer/GlContext';
import { mountFileLoaderScreen, type FileMetaReadable } from './ui/fileLoaderScreen';
import { createHealthWorker } from './workers/createHealthWorker';
import type { HealthPingMessage, HealthPongMessage } from './workers/health.worker';

export function initApp(): void {
  const root = document.getElementById('app');
  if (root === null) {
    return;
  }
  root.dataset['engine'] = 'opengt2';

  const canvas = document.createElement('canvas');
  canvas.className = 'ogt2-canvas';
  canvas.tabIndex = 0;
  canvas.setAttribute('aria-label', 'OpenGT2 WebGL2 viewport');
  root.append(canvas);

  const stateMachine = new AppStateMachine();

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
        message: error.message,
      });
    } else {
      throw error;
    }
  }

  mountFileLoaderScreen({
    container: root,
    stateMachine,
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
