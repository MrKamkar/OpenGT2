export function createVolReaderWorker(): Worker {
  return new Worker(new URL('./volReader.worker.ts', import.meta.url), {
    type: 'module',
  });
}
