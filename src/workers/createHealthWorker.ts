export function createHealthWorker(): Worker {
  return new Worker(new URL('./health.worker.ts', import.meta.url), {
    type: 'module',
  });
}
