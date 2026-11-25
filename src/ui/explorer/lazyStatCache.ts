import type { VolEntry } from '../../formats/vol';

/**
 * Lazy, deduplicated, cancellable `stat()` scheduler for the explorer (M2.8).
 *
 * Opening the archive never calls `stat()` for all files. Instead the virtualized list
 * reports its currently visible paths via `setVisible()`; only those are probed (2-byte gzip
 * magic read in the worker), results are cached, and requests for rows that scrolled out of
 * view are aborted. `ensure()` pins a single path (e.g. the selected file) so it is never
 * cancelled by scrolling.
 */

export type StatFn = (path: string, signal: AbortSignal) => Promise<VolEntry | undefined>;

export type GzipProbeState = 'unknown' | 'pending' | 'gzip' | 'plain' | 'error';

export interface LazyStatCacheOptions {
  readonly stat: StatFn;
  /** Maximum concurrent visibility-driven stat requests (defaults to 4). */
  readonly maxConcurrent?: number;
  /** Invoked after a path's state changes (result cached or failed). */
  readonly onUpdate?: (path: string) => void;
}

export interface LazyStatCacheStats {
  readonly started: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
}

interface InFlightStat {
  readonly controller: AbortController;
  readonly promise: Promise<VolEntry | undefined>;
  pinned: boolean;
}

export const DEFAULT_STAT_CONCURRENCY = 4;

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export class LazyStatCache {
  private readonly statFn: StatFn;
  private readonly maxConcurrent: number;
  private readonly onUpdate: ((path: string) => void) | undefined;
  private readonly results = new Map<string, VolEntry | undefined>();
  private readonly failures = new Map<string, unknown>();
  private readonly inFlight = new Map<string, InFlightStat>();
  private queue: string[] = [];
  private visible = new Set<string>();
  private disposed = false;
  private started = 0;
  private completed = 0;
  private failed = 0;
  private cancelled = 0;

  constructor(options: LazyStatCacheOptions) {
    this.statFn = options.stat;
    const max = options.maxConcurrent ?? DEFAULT_STAT_CONCURRENCY;
    if (!Number.isSafeInteger(max) || max < 1) {
      throw new RangeError(`maxConcurrent must be a positive integer, got ${String(max)}`);
    }
    this.maxConcurrent = max;
    this.onUpdate = options.onUpdate;
  }

  /** Cached stat result (`undefined` when not yet known or the entry does not exist). */
  get(path: string): VolEntry | undefined {
    return this.results.get(path);
  }

  has(path: string): boolean {
    return this.results.has(path);
  }

  getGzipState(path: string): GzipProbeState {
    if (this.results.has(path)) {
      return this.results.get(path)?.isGzip === true ? 'gzip' : 'plain';
    }
    if (this.failures.has(path)) {
      return 'error';
    }
    if (this.inFlight.has(path)) {
      return 'pending';
    }
    return 'unknown';
  }

  getStats(): LazyStatCacheStats {
    return {
      started: this.started,
      completed: this.completed,
      failed: this.failed,
      cancelled: this.cancelled,
    };
  }

  get inFlightCount(): number {
    return this.inFlight.size;
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  /**
   * Declares the set of currently visible file paths. Unknown ones are queued (deduplicated),
   * queued/in-flight paths that are no longer visible (and not pinned) are dropped/aborted.
   */
  setVisible(paths: readonly string[]): void {
    if (this.disposed) {
      return;
    }
    this.visible = new Set(paths);

    for (const [path, flight] of this.inFlight) {
      if (!flight.pinned && !this.visible.has(path)) {
        this.inFlight.delete(path);
        this.cancelled += 1;
        flight.controller.abort();
      }
    }

    const nextQueue: string[] = [];
    const queued = new Set<string>();
    for (const path of paths) {
      if (
        queued.has(path) ||
        this.results.has(path) ||
        this.failures.has(path) ||
        this.inFlight.has(path)
      ) {
        continue;
      }
      queued.add(path);
      nextQueue.push(path);
    }
    this.queue = nextQueue;
    this.pump();
  }

  /**
   * Resolves the stat result for `path`, starting a pinned request if needed (never cancelled
   * by `setVisible()`). Rejects with the underlying error if the stat call fails.
   */
  ensure(path: string): Promise<VolEntry | undefined> {
    if (this.results.has(path)) {
      return Promise.resolve(this.results.get(path));
    }
    const existing = this.inFlight.get(path);
    if (existing !== undefined) {
      existing.pinned = true;
      return existing.promise;
    }
    this.failures.delete(path);
    this.queue = this.queue.filter((queuedPath) => queuedPath !== path);
    return this.start(path, true);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.queue = [];
    for (const flight of this.inFlight.values()) {
      flight.controller.abort();
    }
    this.inFlight.clear();
  }

  private pump(): void {
    while (!this.disposed && this.queue.length > 0 && this.countUnpinned() < this.maxConcurrent) {
      const path = this.queue.shift();
      if (path === undefined) {
        break;
      }
      void this.start(path, false).catch(() => {
        // Visibility-driven failures are recorded in `failures` and surfaced via getGzipState().
      });
    }
  }

  private countUnpinned(): number {
    let count = 0;
    for (const flight of this.inFlight.values()) {
      if (!flight.pinned) {
        count += 1;
      }
    }
    return count;
  }

  private start(path: string, pinned: boolean): Promise<VolEntry | undefined> {
    if (this.disposed) {
      return Promise.reject(Object.assign(new Error('LazyStatCache disposed'), { name: 'AbortError' }));
    }
    const controller = new AbortController();
    this.started += 1;

    const promise = this.statFn(path, controller.signal).then(
      (result) => {
        if (this.inFlight.get(path)?.controller === controller) {
          this.inFlight.delete(path);
        }
        if (!controller.signal.aborted && !this.disposed) {
          this.results.set(path, result);
          this.completed += 1;
          this.onUpdate?.(path);
        }
        this.pump();
        return result;
      },
      (error: unknown) => {
        if (this.inFlight.get(path)?.controller === controller) {
          this.inFlight.delete(path);
        }
        if (!controller.signal.aborted && !this.disposed && !isAbortError(error)) {
          this.failures.set(path, error);
          this.failed += 1;
          this.onUpdate?.(path);
        }
        this.pump();
        throw error;
      },
    );

    this.inFlight.set(path, { controller, promise, pinned });
    return promise;
  }
}
