import type { ByteSource } from '../../io';
import { createAbortError } from '../../workers/rpc';
import { type CompiledPattern, matchPatternAt } from './pattern';

export const DEFAULT_SCAN_CHUNK_SIZE = 256 * 1024;
export const MAX_SCAN_CONTEXT_BYTES = 64;
export const DEFAULT_MAX_HITS = 1000;

export interface ScanHit {
  readonly offset: number;
  readonly length: number;
  readonly contextOffset: number;
  readonly context: Uint8Array;
}

export interface ScanProgress {
  readonly bytesScanned: number;
  readonly totalBytes: number;
  readonly hitsFound: number;
}

export interface ScanResult {
  readonly hits: readonly ScanHit[];
  readonly bytesScanned: number;
  readonly totalBytes: number;
  readonly truncated: boolean;
}

export interface ScanStreamOptions {
  readonly chunkSize?: number;
  readonly maxHits?: number;
  readonly contextBytes?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ScanProgress) => void;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw createAbortError(signal.reason);
  }
}

function buildHitContextRange(
  hitOffset: number,
  patternLength: number,
  totalBytes: number,
  maxContextBytes: number,
): { readonly start: number; readonly end: number } {
  const cappedMax = Math.max(1, Math.min(MAX_SCAN_CONTEXT_BYTES, Math.trunc(maxContextBytes)));
  if (patternLength >= cappedMax) {
    const start = hitOffset;
    const end = Math.min(totalBytes, start + cappedMax);
    return { start, end };
  }
  const before = Math.min(16, Math.floor((cappedMax - patternLength) / 2));
  const start = Math.max(0, hitOffset - before);
  const end = Math.min(totalBytes, start + cappedMax);
  return { start, end };
}

/**
 * Streams through `source` in bounded windows with an explicit `pattern.length - 1` overlap
 * so signature matches straddling chunk boundaries are never missed or duplicated.
 */
export async function scanByteSource(
  source: ByteSource,
  pattern: CompiledPattern,
  options: ScanStreamOptions = {},
): Promise<ScanResult> {
  throwIfAborted(options.signal);

  const totalBytes = source.size;
  if (totalBytes < pattern.length) {
    options.onProgress?.({ bytesScanned: totalBytes, totalBytes, hitsFound: 0 });
    return {
      hits: [],
      bytesScanned: totalBytes,
      totalBytes,
      truncated: false,
    };
  }

  const rawChunkSize = options.chunkSize ?? DEFAULT_SCAN_CHUNK_SIZE;
  if (!Number.isSafeInteger(rawChunkSize) || rawChunkSize <= 0) {
    throw new RangeError(`chunkSize must be a positive integer, got ${String(rawChunkSize)}`);
  }

  const maxHits =
    options.maxHits !== undefined
      ? Math.max(1, Math.trunc(options.maxHits))
      : DEFAULT_MAX_HITS;
  const maxContextBytes = Math.min(
    MAX_SCAN_CONTEXT_BYTES,
    Math.max(1, Math.trunc(options.contextBytes ?? MAX_SCAN_CONTEXT_BYTES)),
  );

  // Guarantee forward progress even when caller passes a tiny chunkSize < pattern.length.
  const stepSize = Math.max(rawChunkSize, pattern.length);
  const overlap = pattern.length - 1;
  const hits: ScanHit[] = [];
  let cursor = 0;
  let bytesScanned = 0;
  let truncated = false;

  while (cursor < totalBytes) {
    throwIfAborted(options.signal);

    const newBytesEnd = Math.min(totalBytes, cursor + stepSize);
    const readEnd = Math.min(totalBytes, newBytesEnd + overlap);
    const windowBytes = await source.read(cursor, readEnd);

    throwIfAborted(options.signal);

    // Only check match start positions in [cursor, newBytesEnd) to avoid duplicates across windows.
    const maxLocalStart = Math.min(
      windowBytes.byteLength - pattern.length,
      newBytesEnd - cursor - 1,
    );

    for (let local = 0; local <= maxLocalStart; local += 1) {
      if (!matchPatternAt(windowBytes, local, pattern)) {
        continue;
      }
      const hitOffset = cursor + local;
      const ctxRange = buildHitContextRange(hitOffset, pattern.length, totalBytes, maxContextBytes);
      let context: Uint8Array;
      if (ctxRange.start >= cursor && ctxRange.end <= cursor + windowBytes.byteLength) {
        context = windowBytes.slice(ctxRange.start - cursor, ctxRange.end - cursor);
      } else {
        context = await source.read(ctxRange.start, ctxRange.end);
      }

      hits.push({
        offset: hitOffset,
        length: pattern.length,
        contextOffset: ctxRange.start,
        context,
      });

      if (hits.length >= maxHits) {
        truncated = true;
        break;
      }
    }

    bytesScanned = newBytesEnd;
    options.onProgress?.({
      bytesScanned,
      totalBytes,
      hitsFound: hits.length,
    });

    if (truncated) {
      break;
    }
    cursor = newBytesEnd;
  }

  return {
    hits,
    bytesScanned,
    totalBytes,
    truncated,
  };
}
