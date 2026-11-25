import {
  type RpcCallOptions,
  RpcClient,
  type RpcEndpoint,
  RpcError,
  type RpcErrorEventLike,
  type RpcMethodMap,
  createAbortError,
} from './rpc';

/** Minimum number of decoder workers in the pool (ROADMAP M1.4). */
export const MIN_WORKER_POOL_SIZE = 1;

/** Maximum number of decoder workers in the pool (ROADMAP M1.4). */
export const MAX_WORKER_POOL_SIZE = 4;

/** Fallback core count used when `navigator.hardwareConcurrency` is unavailable or invalid. */
export const FALLBACK_HARDWARE_CONCURRENCY = 2;

export const TaskPriority = {
  Low: 0,
  Normal: 1,
  High: 2,
  Critical: 3,
} as const;

export type TaskPriorityLevel = (typeof TaskPriority)[keyof typeof TaskPriority];

/**
 * Computes the default decoder worker pool size according to M1.4:
 * `Math.min(4, Math.max(1, (hardwareConcurrency || 2) - 1))`.
 */
export function computeWorkerPoolSize(hardwareConcurrency?: number): number {
  const detected =
    hardwareConcurrency !== undefined
      ? hardwareConcurrency
      : typeof globalThis.navigator !== 'undefined'
        ? globalThis.navigator.hardwareConcurrency
        : undefined;

  const cores =
    typeof detected === 'number' && Number.isFinite(detected) && detected >= 1
      ? Math.floor(detected)
      : FALLBACK_HARDWARE_CONCURRENCY;

  return Math.min(MAX_WORKER_POOL_SIZE, Math.max(MIN_WORKER_POOL_SIZE, cores - 1));
}

export interface WorkerPoolOptions {
  /** Factory creating a new worker endpoint on demand (e.g. `() => new Worker(...)` or test mock). */
  readonly createWorker: () => RpcEndpoint;
  /** Optional explicit max worker count. Defaults to `computeWorkerPoolSize()`. */
  readonly size?: number;
}

export interface WorkerPoolTaskOptions {
  /** Higher numeric priority executes first; ties break FIFO. Defaults to `TaskPriority.Normal`. */
  readonly priority?: number;
  readonly signal?: AbortSignal;
  readonly transfer?: Transferable[];
}

export interface WorkerPoolStats {
  readonly maxWorkers: number;
  readonly spawnedWorkers: number;
  readonly busyWorkers: number;
  readonly queuedTasks: number;
  readonly disposed: boolean;
}

interface QueuedTask {
  readonly id: number;
  readonly priority: number;
  readonly sequence: number;
  readonly method: string;
  readonly params: unknown;
  readonly signal: AbortSignal | undefined;
  readonly transfer: Transferable[] | undefined;
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly cleanupQueueAbort: (() => void) | undefined;
}

interface PoolSlot<TSchema extends RpcMethodMap<TSchema>> {
  readonly endpoint: RpcEndpoint;
  readonly client: RpcClient<TSchema>;
  readonly onFatalError: (event: RpcErrorEventLike) => void;
  busy: boolean;
  dead: boolean;
}

/**
 * Binary max-heap ordered by `(priority DESC, sequence ASC)` so higher-priority tasks
 * dequeue first and equal-priority tasks preserve FIFO ordering.
 */
class PriorityTaskQueue {
  private readonly heap: QueuedTask[] = [];

  get length(): number {
    return this.heap.length;
  }

  push(task: QueuedTask): void {
    this.heap.push(task);
    this.siftUp(this.heap.length - 1);
  }

  pop(): QueuedTask | undefined {
    const top = this.heap[0];
    if (top === undefined) {
      return undefined;
    }
    const last = this.heap.pop();
    if (this.heap.length > 0 && last !== undefined) {
      this.heap[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  removeById(id: number): QueuedTask | undefined {
    const index = this.heap.findIndex((item) => item.id === id);
    if (index === -1) {
      return undefined;
    }
    const removed = this.heap[index];
    const last = this.heap.pop();
    if (index < this.heap.length && last !== undefined) {
      this.heap[index] = last;
      this.siftUp(index);
      this.siftDown(index);
    }
    return removed;
  }

  drain(): QueuedTask[] {
    const items = [...this.heap];
    this.heap.length = 0;
    return items;
  }

  private hasHigherPriority(a: QueuedTask, b: QueuedTask): boolean {
    if (a.priority !== b.priority) {
      return a.priority > b.priority;
    }
    return a.sequence < b.sequence;
  }

  private siftUp(startIndex: number): void {
    let index = startIndex;
    while (index > 0) {
      const parentIndex = Math.floor((index - 1) / 2);
      const current = this.heap[index];
      const parent = this.heap[parentIndex];
      if (current === undefined || parent === undefined) {
        break;
      }
      if (!this.hasHigherPriority(current, parent)) {
        break;
      }
      this.heap[index] = parent;
      this.heap[parentIndex] = current;
      index = parentIndex;
    }
  }

  private siftDown(startIndex: number): void {
    let index = startIndex;
    const count = this.heap.length;

    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let best = index;

      const bestTask = this.heap[best];
      const leftTask = this.heap[left];
      if (left < count && leftTask !== undefined && bestTask !== undefined) {
        if (this.hasHigherPriority(leftTask, bestTask)) {
          best = left;
        }
      }

      const currentBest = this.heap[best];
      const rightTask = this.heap[right];
      if (right < count && rightTask !== undefined && currentBest !== undefined) {
        if (this.hasHigherPriority(rightTask, currentBest)) {
          best = right;
        }
      }

      if (best === index) {
        break;
      }

      const indexTask = this.heap[index];
      const swapTask = this.heap[best];
      if (indexTask === undefined || swapTask === undefined) {
        break;
      }
      this.heap[index] = swapTask;
      this.heap[best] = indexTask;
      index = best;
    }
  }
}

/**
 * Bounded pool of RPC worker endpoints with priority scheduling, AbortSignal cancellation,
 * Transferable forwarding, and automatic recovery from fatal worker crashes.
 */
export class WorkerPool<TSchema extends RpcMethodMap<TSchema>> {
  readonly maxWorkers: number;

  private readonly createWorker: () => RpcEndpoint;
  private readonly slots: PoolSlot<TSchema>[] = [];
  private readonly queue = new PriorityTaskQueue();
  private nextSequence = 1;
  private disposed = false;

  constructor(options: WorkerPoolOptions) {
    const resolvedSize = options.size ?? computeWorkerPoolSize();
    if (!Number.isSafeInteger(resolvedSize) || resolvedSize < 1) {
      throw new RangeError(
        `WorkerPool size must be a positive safe integer, got ${String(resolvedSize)}`,
      );
    }

    this.createWorker = options.createWorker;
    this.maxWorkers = resolvedSize;
  }

  exec<K extends keyof TSchema & string>(
    method: K,
    params: TSchema[K]['params'],
    options?: WorkerPoolTaskOptions,
  ): Promise<TSchema[K]['result']> {
    if (this.disposed) {
      return Promise.reject(new RpcError('WorkerPool has been disposed.'));
    }

    const priority = options?.priority ?? TaskPriority.Normal;
    if (typeof priority !== 'number' || !Number.isFinite(priority)) {
      return Promise.reject(
        new RangeError(`Task priority must be a finite number, got ${String(priority)}`),
      );
    }

    const signal = options?.signal;
    if (signal?.aborted) {
      return Promise.reject(createAbortError(signal.reason));
    }

    const id = this.nextSequence;
    this.nextSequence += 1;

    return new Promise<TSchema[K]['result']>((resolve, reject) => {
      let cleanupQueueAbort: (() => void) | undefined;

      if (signal !== undefined) {
        const onAbortWhileQueued = (): void => {
          const removed = this.queue.removeById(id);
          if (removed !== undefined) {
            reject(createAbortError(signal.reason));
          }
        };
        signal.addEventListener('abort', onAbortWhileQueued, { once: true });
        cleanupQueueAbort = (): void => {
          signal.removeEventListener('abort', onAbortWhileQueued);
        };
      }

      const task: QueuedTask = {
        id,
        priority,
        sequence: id,
        method,
        params,
        signal,
        transfer: options?.transfer,
        resolve: resolve as (value: unknown) => void,
        reject,
        cleanupQueueAbort,
      };

      this.queue.push(task);
      this.pump();
    });
  }

  getStats(): WorkerPoolStats {
    let busyWorkers = 0;
    for (const slot of this.slots) {
      if (slot.busy) {
        busyWorkers += 1;
      }
    }
    return {
      maxWorkers: this.maxWorkers,
      spawnedWorkers: this.slots.length,
      busyWorkers,
      queuedTasks: this.queue.length,
      disposed: this.disposed,
    };
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;

    const remaining = this.queue.drain();
    const disposeError = new RpcError('WorkerPool was disposed.');
    for (const task of remaining) {
      task.cleanupQueueAbort?.();
      task.reject(disposeError);
    }

    const activeSlots = [...this.slots];
    this.slots.length = 0;
    for (const slot of activeSlots) {
      slot.dead = true;
      slot.endpoint.removeEventListener('error', slot.onFatalError);
      slot.client.dispose(true);
    }
  }

  private pump(): void {
    if (this.disposed) {
      return;
    }

    while (this.queue.length > 0) {
      const slot = this.acquireIdleSlot();
      if (slot === undefined) {
        return;
      }

      const task = this.queue.pop();
      if (task === undefined) {
        return;
      }

      task.cleanupQueueAbort?.();

      if (task.signal?.aborted) {
        task.reject(createAbortError(task.signal.reason));
        continue;
      }

      this.runTaskOnSlot(slot, task);
    }
  }

  private acquireIdleSlot(): PoolSlot<TSchema> | undefined {
    for (const slot of this.slots) {
      if (!slot.busy && !slot.dead) {
        return slot;
      }
    }

    if (this.slots.length >= this.maxWorkers) {
      return undefined;
    }

    return this.spawnSlot();
  }

  private spawnSlot(): PoolSlot<TSchema> {
    const endpoint = this.createWorker();
    // Register RpcClient first so its error listener rejects active calls with the
    // original error message before the pool evicts and terminates the crashed slot.
    const client = new RpcClient<TSchema>(endpoint);

    const slot: PoolSlot<TSchema> = {
      endpoint,
      client,
      onFatalError: (): void => {
        if (slot.dead) {
          return;
        }
        slot.dead = true;
        slot.busy = false;
        endpoint.removeEventListener('error', slot.onFatalError);
        const idx = this.slots.indexOf(slot);
        if (idx !== -1) {
          this.slots.splice(idx, 1);
        }
        client.dispose(true);
        this.pump();
      },
      busy: false,
      dead: false,
    };

    endpoint.addEventListener('error', slot.onFatalError);
    this.slots.push(slot);
    return slot;
  }

  private runTaskOnSlot(slot: PoolSlot<TSchema>, task: QueuedTask): void {
    slot.busy = true;

    const callOptions: RpcCallOptions = {
      ...(task.signal !== undefined ? { signal: task.signal } : {}),
      ...(task.transfer !== undefined ? { transfer: task.transfer } : {}),
    };

    void slot.client
      .call(
        task.method as keyof TSchema & string,
        task.params as TSchema[keyof TSchema & string]['params'],
        callOptions,
      )
      .then(
        (result) => {
          task.resolve(result);
        },
        (error: unknown) => {
          task.reject(error);
        },
      )
      .finally(() => {
        if (!slot.dead && !this.disposed) {
          slot.busy = false;
          this.pump();
        }
      });
  }
}
