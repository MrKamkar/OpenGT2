export interface HealthPingMessage {
  readonly type: 'ping';
}

export interface HealthPongMessage {
  readonly type: 'pong';
}

export function createHealthPong(message: HealthPingMessage): HealthPongMessage {
  if (message.type !== 'ping') {
    throw new Error(`Unsupported health message type: ${String(message.type)}`);
  }
  return { type: 'pong' };
}

interface WorkerScopeLike {
  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<HealthPingMessage>) => void,
  ): void;
  postMessage(message: HealthPongMessage): void;
}

const isWorkerContext =
  typeof document === 'undefined' &&
  typeof globalThis.addEventListener === 'function' &&
  typeof globalThis.postMessage === 'function';

if (isWorkerContext) {
  const scope = globalThis as unknown as WorkerScopeLike;
  scope.addEventListener('message', (event: MessageEvent<HealthPingMessage>) => {
    if (event.data.type === 'ping') {
      scope.postMessage(createHealthPong(event.data));
    }
  });
}
