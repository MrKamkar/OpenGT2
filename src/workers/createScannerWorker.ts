export function createScannerWorker(): Worker {
  return new Worker(new URL('./scanner.worker.ts', import.meta.url), {
    type: 'module',
  });
}
