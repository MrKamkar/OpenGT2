import './ui/styles.css';
import { AppStateMachine } from './app/appState';
import { mountFileLoaderScreen, type FileMetaReadable } from './ui/fileLoaderScreen';
import { createHealthWorker } from './workers/createHealthWorker';
import type { HealthPingMessage, HealthPongMessage } from './workers/health.worker';

export function initApp(): void {
  const root = document.getElementById('app');
  if (root === null) {
    return;
  }
  root.dataset['engine'] = 'opengt2';

  const stateMachine = new AppStateMachine();

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
