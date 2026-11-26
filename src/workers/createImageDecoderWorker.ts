export function createImageDecoderWorker(): Worker {
  return new Worker(new URL('./imageDecoder.worker.ts', import.meta.url), {
    type: 'module',
  });
}
