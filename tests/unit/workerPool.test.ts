import { describe, expect, it, vi } from 'vitest';
import {
  bindRpcServer,
  computeWorkerPoolSize,
  type RpcEndpoint,
  type RpcErrorEventLike,
  type RpcHandlers,
  type RpcMessageEventLike,
  type RpcMessageTransport,
  type RpcMethodMap,
  TaskPriority,
  withTransfer,
  WorkerPool,
} from '../../src/workers';

interface MockWorkerController {
  readonly endpoint: RpcEndpoint;
  readonly mainTransfers: Transferable[][];
  emitError(message: string): void;
  isTerminated(): boolean;
}

function createMockWorker<TSchema extends RpcMethodMap<TSchema>>(
  handlers: RpcHandlers<TSchema>,
): MockWorkerController {
  const mainMessageListeners = new Set<(event: RpcMessageEventLike) => void>();
  const mainErrorListeners = new Set<(event: RpcErrorEventLike) => void>();
  const workerMessageListeners = new Set<(event: RpcMessageEventLike) => void>();
  const mainTransfers: Transferable[][] = [];
  let terminated = false;

  const endpoint: RpcEndpoint = {
    postMessage(message: unknown, transfer?: Transferable[]): void {
      if (terminated) {
        throw new Error('Mock worker terminated');
      }
      mainTransfers.push(transfer ? [...transfer] : []);
      queueMicrotask(() => {
        if (terminated) {
          return;
        }
        for (const listener of workerMessageListeners) {
          listener({ data: message });
        }
      });
    },
    addEventListener(
      type: 'message' | 'error',
      listener: ((event: RpcMessageEventLike) => void) | ((event: RpcErrorEventLike) => void),
    ): void {
      if (type === 'message') {
        mainMessageListeners.add(listener as (event: RpcMessageEventLike) => void);
      } else {
        mainErrorListeners.add(listener as (event: RpcErrorEventLike) => void);
      }
    },
    removeEventListener(
      type: 'message' | 'error',
      listener: ((event: RpcMessageEventLike) => void) | ((event: RpcErrorEventLike) => void),
    ): void {
      if (type === 'message') {
        mainMessageListeners.delete(listener as (event: RpcMessageEventLike) => void);
      } else {
        mainErrorListeners.delete(listener as (event: RpcErrorEventLike) => void);
      }
    },
    terminate(): void {
      terminated = true;
      server.dispose();
    },
  };

  const workerTransport: RpcMessageTransport = {
    postMessage(message: unknown): void {
      if (terminated) {
        return;
      }
      queueMicrotask(() => {
        if (terminated) {
          return;
        }
        for (const listener of mainMessageListeners) {
          listener({ data: message });
        }
      });
    },
    addEventListener(_type: 'message', listener: (event: RpcMessageEventLike) => void): void {
      workerMessageListeners.add(listener);
    },
    removeEventListener(_type: 'message', listener: (event: RpcMessageEventLike) => void): void {
      workerMessageListeners.delete(listener);
    },
  };

  const server = bindRpcServer<TSchema>(workerTransport, handlers);

  return {
    endpoint,
    mainTransfers,
    emitError(message: string): void {
      for (const listener of [...mainErrorListeners]) {
        listener({ message });
      }
    },
    isTerminated(): boolean {
      return terminated;
    },
  };
}

interface DecoderSchema {
  decode: {
    readonly params: { readonly id: string; readonly fail?: boolean };
    readonly result: string;
  };
  echoBuffer: {
    readonly params: { readonly buffer: ArrayBuffer };
    readonly result: { readonly buffer: ArrayBuffer };
  };
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function createDeferred(): Deferred {
  let resolveFn: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolveFn = resolve;
  });
  return {
    promise,
    resolve: (): void => {
      resolveFn?.();
    },
  };
}

describe('computeWorkerPoolSize (M1.4)', () => {
  it('follows Math.min(4, Math.max(1, (hardwareConcurrency || 2) - 1))', () => {
    expect(computeWorkerPoolSize(0)).toBe(1);
    expect(computeWorkerPoolSize(Number.NaN)).toBe(1);
    expect(computeWorkerPoolSize(-4)).toBe(1);
    expect(computeWorkerPoolSize(1)).toBe(1);
    expect(computeWorkerPoolSize(2)).toBe(1);
    expect(computeWorkerPoolSize(3)).toBe(2);
    expect(computeWorkerPoolSize(4)).toBe(3);
    expect(computeWorkerPoolSize(5)).toBe(4);
    expect(computeWorkerPoolSize(16)).toBe(4);
  });
});

describe('WorkerPool (M1.4)', () => {
  it('rejects invalid pool size or priority options', async () => {
    expect(
      () =>
        new WorkerPool<DecoderSchema>({
          createWorker: () =>
            createMockWorker<DecoderSchema>({
              decode: ({ id }) => id,
              echoBuffer: ({ buffer }) => ({ buffer }),
            }).endpoint,
          size: 0,
        }),
    ).toThrow(RangeError);

    const pool = new WorkerPool<DecoderSchema>({
      createWorker: () =>
        createMockWorker<DecoderSchema>({
          decode: ({ id }) => id,
          echoBuffer: ({ buffer }) => ({ buffer }),
        }).endpoint,
      size: 1,
    });

    await expect(pool.exec('decode', { id: 'bad' }, { priority: Number.NaN })).rejects.toThrow(
      RangeError,
    );
    pool.dispose();
  });

  it('executes queued tasks in strict priority order with FIFO tie-breaking', async () => {
    const executionOrder: string[] = [];
    const gate = createDeferred();

    const pool = new WorkerPool<DecoderSchema>({
      size: 1,
      createWorker: () =>
        createMockWorker<DecoderSchema>({
          decode: async ({ id }) => {
            executionOrder.push(id);
            if (id === 'blocker') {
              await gate.promise;
            }
            return `ok:${id}`;
          },
          echoBuffer: ({ buffer }) => ({ buffer }),
        }).endpoint,
    });

    // Occupy the single worker so subsequent tasks wait in the priority queue.
    const pBlocker = pool.exec('decode', { id: 'blocker' }, { priority: TaskPriority.Normal });
    const pLow1 = pool.exec('decode', { id: 'low-1' }, { priority: TaskPriority.Low });
    const pNormal1 = pool.exec('decode', { id: 'normal-1' }, { priority: TaskPriority.Normal });
    const pHigh1 = pool.exec('decode', { id: 'high-1' }, { priority: TaskPriority.High });
    const pNormal2 = pool.exec('decode', { id: 'normal-2' }, { priority: TaskPriority.Normal });
    const pCritical = pool.exec('decode', { id: 'critical' }, { priority: TaskPriority.Critical });
    const pHigh2 = pool.exec('decode', { id: 'high-2' }, { priority: TaskPriority.High });
    const pLow2 = pool.exec('decode', { id: 'low-2' }, { priority: TaskPriority.Low });

    expect(pool.getStats()).toEqual({
      maxWorkers: 1,
      spawnedWorkers: 1,
      busyWorkers: 1,
      queuedTasks: 7,
      disposed: false,
    });

    gate.resolve();

    const results = await Promise.all([
      pBlocker,
      pLow1,
      pNormal1,
      pHigh1,
      pNormal2,
      pCritical,
      pHigh2,
      pLow2,
    ]);

    expect(results).toEqual([
      'ok:blocker',
      'ok:low-1',
      'ok:normal-1',
      'ok:high-1',
      'ok:normal-2',
      'ok:critical',
      'ok:high-2',
      'ok:low-2',
    ]);
    expect(executionOrder).toEqual([
      'blocker',
      'critical',
      'high-1',
      'high-2',
      'normal-1',
      'normal-2',
      'low-1',
      'low-2',
    ]);

    pool.dispose();
  });

  it('caps concurrent workers at maxWorkers and reuses idle workers', async () => {
    let spawned = 0;
    let inFlight = 0;
    let peakConcurrency = 0;
    const gates: Deferred[] = [];

    const pool = new WorkerPool<DecoderSchema>({
      size: 2,
      createWorker: () => {
        spawned += 1;
        return createMockWorker<DecoderSchema>({
          decode: async ({ id }) => {
            inFlight += 1;
            peakConcurrency = Math.max(peakConcurrency, inFlight);
            const d = createDeferred();
            gates.push(d);
            await d.promise;
            inFlight -= 1;
            return id;
          },
          echoBuffer: ({ buffer }) => ({ buffer }),
        }).endpoint;
      },
    });

    const promises = ['a', 'b', 'c', 'd'].map((id) => pool.exec('decode', { id }));

    // Let microtasks dispatch the first 2 tasks to the 2 workers.
    await Promise.resolve();
    await Promise.resolve();

    expect(spawned).toBe(2);
    expect(pool.getStats()).toMatchObject({
      maxWorkers: 2,
      spawnedWorkers: 2,
      busyWorkers: 2,
      queuedTasks: 2,
    });

    // Release first wave, then second wave.
    gates.splice(0).forEach((g) => g.resolve());
    await new Promise((resolve) => setTimeout(resolve, 10));
    gates.splice(0).forEach((g) => g.resolve());

    expect(await Promise.all(promises)).toEqual(['a', 'b', 'c', 'd']);
    expect(peakConcurrency).toBe(2);
    expect(spawned).toBe(2);
    expect(pool.getStats().busyWorkers).toBe(0);

    pool.dispose();
  });

  it('cancels queued tasks via AbortSignal without dispatching them and forwards Transferables', async () => {
    const executed: string[] = [];
    const gate = createDeferred();
    const workers: MockWorkerController[] = [];

    const pool = new WorkerPool<DecoderSchema>({
      size: 1,
      createWorker: () => {
        const mock = createMockWorker<DecoderSchema>({
          decode: async ({ id }) => {
            executed.push(id);
            if (id === 'hold') {
              await gate.promise;
            }
            return id;
          },
          echoBuffer: ({ buffer }) => withTransfer({ buffer }, [buffer]),
        });
        workers.push(mock);
        return mock.endpoint;
      },
    });

    const pHold = pool.exec('decode', { id: 'hold' });
    const cancelController = new AbortController();
    const pCancelled = pool.exec(
      'decode',
      { id: 'never-runs' },
      { priority: TaskPriority.High, signal: cancelController.signal },
    );
    const buf = new Uint8Array([1, 2, 3, 4]).buffer;
    const pTransfer = pool.exec('echoBuffer', { buffer: buf }, { transfer: [buf] });

    cancelController.abort('skip queued task');
    await expect(pCancelled).rejects.toThrow('skip queued task');
    expect(pool.getStats().queuedTasks).toBe(1);

    gate.resolve();
    expect(await pHold).toBe('hold');
    const echoed = await pTransfer;
    expect(new Uint8Array(echoed.buffer)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(executed).toEqual(['hold']);
    expect(workers[0]?.mainTransfers).toContainEqual([buf]);

    pool.dispose();
  });

  it('preserves worker reuse on handler errors and replaces crashed workers on fatal error events', async () => {
    const workers: MockWorkerController[] = [];
    const createWorker = vi.fn(() => {
      const mock = createMockWorker<DecoderSchema>({
        decode: async ({ id, fail }) => {
          if (fail) {
            throw new Error(`Decode failed for ${id}`);
          }
          if (id === 'hang-then-crash') {
            return new Promise<string>(() => {});
          }
          return `decoded:${id}`;
        },
        echoBuffer: ({ buffer }) => ({ buffer }),
      });
      workers.push(mock);
      return mock.endpoint;
    });

    const pool = new WorkerPool<DecoderSchema>({
      size: 1,
      createWorker,
    });

    // Recoverable RPC handler error must NOT kill the worker.
    await expect(pool.exec('decode', { id: 'bad-entry', fail: true })).rejects.toThrow(
      'Decode failed for bad-entry',
    );
    expect(await pool.exec('decode', { id: 'good-entry' })).toBe('decoded:good-entry');
    expect(createWorker).toHaveBeenCalledTimes(1);

    // Fatal worker crash rejects the running task, terminates the crashed worker,
    // and automatically spawns a fresh replacement for queued work.
    const crashingTask = pool.exec('decode', { id: 'hang-then-crash' });
    const queuedFollowUp = pool.exec('decode', { id: 'after-crash' });

    await Promise.resolve();
    await Promise.resolve();

    workers[0]?.emitError('Out of memory in worker');
    await expect(crashingTask).rejects.toThrow('Out of memory in worker');
    expect(workers[0]?.isTerminated()).toBe(true);
    expect(await queuedFollowUp).toBe('decoded:after-crash');
    expect(createWorker).toHaveBeenCalledTimes(2);

    pool.dispose();
    expect(workers[1]?.isTerminated()).toBe(true);
  });

  it('rejects queued tasks and future calls when disposed', async () => {
    const gate = createDeferred();
    const workers: MockWorkerController[] = [];

    const pool = new WorkerPool<DecoderSchema>({
      size: 1,
      createWorker: () => {
        const mock = createMockWorker<DecoderSchema>({
          decode: async ({ id }) => {
            await gate.promise;
            return id;
          },
          echoBuffer: ({ buffer }) => ({ buffer }),
        });
        workers.push(mock);
        return mock.endpoint;
      },
    });

    const running = pool.exec('decode', { id: 'running' });
    const queued = pool.exec('decode', { id: 'queued' });

    pool.dispose();

    await expect(running).rejects.toThrow('RPC client was disposed.');
    await expect(queued).rejects.toThrow('WorkerPool was disposed.');
    await expect(pool.exec('decode', { id: 'after' })).rejects.toThrow(
      'WorkerPool has been disposed.',
    );
    expect(workers[0]?.isTerminated()).toBe(true);
    expect(pool.getStats().disposed).toBe(true);
  });
});
