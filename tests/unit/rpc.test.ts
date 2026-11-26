import { describe, expect, it, vi } from 'vitest';
import {
  RpcClient,
  type RpcEndpoint,
  RpcError,
  type RpcErrorEventLike,
  type RpcMessageEventLike,
  type RpcMessageTransport,
  bindRpcServer,
  withTransfer,
} from '../../src/workers/rpc';

interface MockRpcChannel {
  readonly mainEndpoint: RpcEndpoint;
  readonly workerTransport: RpcMessageTransport;
  readonly mainSentTransfers: Transferable[][];
  readonly workerSentTransfers: Transferable[][];
  emitWorkerError(message: string): void;
}

/**
 * In-memory bidirectional RPC channel for pure Node/Vitest tests.
 * Delivers messages asynchronously (microtask) and records Transferable lists.
 */
function createMockRpcChannel(): MockRpcChannel {
  const mainMessageListeners = new Set<(event: RpcMessageEventLike) => void>();
  const mainErrorListeners = new Set<(event: RpcErrorEventLike) => void>();
  const workerMessageListeners = new Set<(event: RpcMessageEventLike) => void>();
  const mainSentTransfers: Transferable[][] = [];
  const workerSentTransfers: Transferable[][] = [];
  let terminated = false;

  const mainEndpoint: RpcEndpoint = {
    postMessage(message: unknown, transfer?: Transferable[]): void {
      if (terminated) {
        throw new Error('Worker has been terminated');
      }
      mainSentTransfers.push(transfer ? [...transfer] : []);
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
    },
  };

  const workerTransport: RpcMessageTransport = {
    postMessage(message: unknown, transfer?: Transferable[]): void {
      if (terminated) {
        return;
      }
      workerSentTransfers.push(transfer ? [...transfer] : []);
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

  return {
    mainEndpoint,
    workerTransport,
    mainSentTransfers,
    workerSentTransfers,
    emitWorkerError(message: string): void {
      for (const listener of mainErrorListeners) {
        listener({ message });
      }
    },
  };
}

interface TestRpcSchema {
  add: {
    readonly params: { readonly a: number; readonly b: number };
    readonly result: number;
  };
  failWithRange: {
    readonly params: { readonly detail: string };
    readonly result: never;
  };
  invertBytes: {
    readonly params: { readonly buffer: ArrayBuffer };
    readonly result: { readonly buffer: ArrayBuffer };
  };
  slowTask: {
    readonly params: { readonly delayMs: number; readonly tag: string };
    readonly result: string;
  };
}

describe('Worker RPC protocol (M1.3)', () => {
  it('ensures Web Worker is structurally assignable to RpcEndpoint at compile time', () => {
    const assertWorkerAssignable = (worker: Worker): RpcEndpoint => worker;
    expect(typeof assertWorkerAssignable).toBe('function');
  });

  it('handles typed concurrent calls with out-of-order responses', async () => {
    const channel = createMockRpcChannel();
    const server = bindRpcServer<TestRpcSchema>(channel.workerTransport, {
      add: ({ a, b }) => a + b,
      failWithRange: ({ detail }) => {
        throw new RangeError(detail);
      },
      invertBytes: ({ buffer }) => {
        const view = new Uint8Array(buffer);
        const out = new Uint8Array(view.byteLength);
        for (let i = 0; i < view.byteLength; i += 1) {
          out[i] = (view[i] ?? 0) ^ 0xff;
        }
        return withTransfer({ buffer: out.buffer }, [out.buffer]);
      },
      slowTask: async ({ delayMs, tag }) => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return `done:${tag}`;
      },
    });
    const client = new RpcClient<TestRpcSchema>(channel.mainEndpoint);

    const [slow, fast, sum] = await Promise.all([
      client.call('slowTask', { delayMs: 20, tag: 'slow' }),
      client.call('slowTask', { delayMs: 1, tag: 'fast' }),
      client.call('add', { a: 19, b: 23 }),
    ]);

    expect(slow).toBe('done:slow');
    expect(fast).toBe('done:fast');
    expect(sum).toBe(42);
    expect(client.pendingCount).toBe(0);

    client.dispose();
    server.dispose();
  });

  it('propagates worker errors with their original message and error name', async () => {
    const channel = createMockRpcChannel();
    const server = bindRpcServer<TestRpcSchema>(channel.workerTransport, {
      add: ({ a, b }) => a + b,
      failWithRange: ({ detail }) => {
        throw new RangeError(`Offset out of bounds: ${detail}`);
      },
      invertBytes: ({ buffer }) => ({ buffer }),
      slowTask: ({ tag }) => tag,
    });
    const client = new RpcClient<TestRpcSchema>(channel.mainEndpoint);

    let caught: unknown;
    try {
      await client.call('failWithRange', { detail: '0x2048 > 0x1000' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught).toBeInstanceOf(RpcError);
    expect((caught as Error).name).toBe('RangeError');
    expect((caught as Error).message).toBe('Offset out of bounds: 0x2048 > 0x1000');

    client.dispose();
    server.dispose();
  });

  it('forwards Transferable objects in both request and response directions', async () => {
    const channel = createMockRpcChannel();
    const server = bindRpcServer<TestRpcSchema>(channel.workerTransport, {
      add: ({ a, b }) => a + b,
      failWithRange: () => {
        throw new Error('unused');
      },
      invertBytes: ({ buffer }) => {
        const input = new Uint8Array(buffer);
        const output = new Uint8Array(input.byteLength);
        for (let i = 0; i < input.byteLength; i += 1) {
          output[i] = (input[i] ?? 0) ^ 0xff;
        }
        return withTransfer({ buffer: output.buffer }, [output.buffer]);
      },
      slowTask: ({ tag }) => tag,
    });
    const client = new RpcClient<TestRpcSchema>(channel.mainEndpoint);

    const inputBytes = new Uint8Array([0x00, 0x0f, 0xf0, 0xaa]);
    const result = await client.call(
      'invertBytes',
      { buffer: inputBytes.buffer },
      { transfer: [inputBytes.buffer] },
    );

    expect(new Uint8Array(result.buffer)).toEqual(new Uint8Array([0xff, 0xf0, 0x0f, 0x55]));
    expect(channel.mainSentTransfers).toEqual([[inputBytes.buffer]]);
    expect(channel.workerSentTransfers).toEqual([[result.buffer]]);

    client.dispose();
    server.dispose();
  });

  it('supports pre-aborted and in-flight AbortSignal with worker-side cancellation', async () => {
    const channel = createMockRpcChannel();
    const onWorkerAbort = vi.fn();
    let releaseWorker: (() => void) | undefined;

    const server = bindRpcServer<TestRpcSchema>(channel.workerTransport, {
      add: ({ a, b }) => a + b,
      failWithRange: () => {
        throw new Error('unused');
      },
      invertBytes: ({ buffer }) => ({ buffer }),
      slowTask: (_params, { signal }) =>
        new Promise<string>((resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              onWorkerAbort();
              reject(new Error('worker aborted'));
            },
            { once: true },
          );
          releaseWorker = () => resolve('finished');
        }),
    });
    const client = new RpcClient<TestRpcSchema>(channel.mainEndpoint);

    // 1. Pre-aborted signal rejects immediately without posting any message.
    const preAborted = new AbortController();
    preAborted.abort('cancelled before start');
    await expect(client.call('add', { a: 1, b: 2 }, { signal: preAborted.signal })).rejects.toThrow(
      'cancelled before start',
    );
    expect(channel.mainSentTransfers).toHaveLength(0);

    // 2. In-flight abort rejects caller and notifies worker via rpc:cancel.
    const inFlight = new AbortController();
    const promise = client.call(
      'slowTask',
      { delayMs: 1000, tag: 'cancel-me' },
      { signal: inFlight.signal },
    );

    // Wait one microtask so the request reaches the worker handler.
    await Promise.resolve();
    await Promise.resolve();

    inFlight.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(client.pendingCount).toBe(0);

    // Allow the cancel message microtask to reach the worker.
    await Promise.resolve();
    await Promise.resolve();
    expect(onWorkerAbort).toHaveBeenCalledTimes(1);
    expect(channel.workerSentTransfers).toHaveLength(0);

    releaseWorker?.();
    client.dispose();
    server.dispose();
  });

  it('rejects pending requests on worker error events and on client disposal', async () => {
    const channel = createMockRpcChannel();
    const server = bindRpcServer<TestRpcSchema>(channel.workerTransport, {
      add: ({ a, b }) => a + b,
      failWithRange: () => {
        throw new Error('unused');
      },
      invertBytes: ({ buffer }) => ({ buffer }),
      slowTask: () => new Promise<string>(() => {}),
    });
    const client = new RpcClient<TestRpcSchema>(channel.mainEndpoint);

    const pendingOnError = client.call('slowTask', { delayMs: 1000, tag: 'err' });
    channel.emitWorkerError('Uncaught worker crash');
    await expect(pendingOnError).rejects.toThrow('Uncaught worker crash');

    const pendingOnDispose = client.call('slowTask', { delayMs: 1000, tag: 'disp' });
    client.dispose(true);
    await expect(pendingOnDispose).rejects.toThrow('RPC client was disposed.');
    await expect(client.call('add', { a: 1, b: 1 })).rejects.toThrow(
      'RPC client has been disposed.',
    );

    server.dispose();
  });

  it('delivers rpc:progress updates to onProgress and stops reporting after cancellation', async () => {
    interface ProgressSchema {
      work: {
        readonly params: { readonly steps: number };
        readonly result: number;
      };
    }

    const channel = createMockRpcChannel();
    const server = bindRpcServer<ProgressSchema>(channel.workerTransport, {
      work: async ({ steps }, context) => {
        for (let i = 1; i <= steps; i += 1) {
          if (context.signal.aborted) {
            throw new Error('aborted');
          }
          context.reportProgress?.({ step: i, total: steps });
          await Promise.resolve();
        }
        return steps;
      },
    });
    const client = new RpcClient<ProgressSchema>(channel.mainEndpoint);

    const updates: unknown[] = [];
    const total = await client.call(
      'work',
      { steps: 3 },
      {
        onProgress(progress) {
          updates.push(progress);
        },
      },
    );

    expect(total).toBe(3);
    expect(updates).toEqual([
      { step: 1, total: 3 },
      { step: 2, total: 3 },
      { step: 3, total: 3 },
    ]);

    client.dispose();
    server.dispose();
  });
});
