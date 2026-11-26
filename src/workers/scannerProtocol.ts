import { gunzip } from '../formats/gzip';
import { BlobByteSource, type BlobLike, BufferByteSource, type ByteSource } from '../io';
import {
  type ScanProgress,
  type ScanResult,
  parseHexPattern,
  scanByteSource,
} from '../tools/scanner';
import {
  bindRpcServer,
  type RpcCallOptions,
  RpcClient,
  type RpcEndpoint,
  type RpcMessageTransport,
  type RpcServerHandle,
} from './rpc';

export interface ScanBlobRangeParams {
  readonly blob: BlobLike;
  readonly start: number;
  readonly end: number;
  readonly decompress: boolean;
  readonly pattern: string;
  readonly chunkSize?: number;
  readonly maxHits?: number;
}

export interface ScannerRpcSchema {
  scanBlobRange: {
    readonly params: ScanBlobRangeParams;
    readonly result: ScanResult;
  };
}

export interface BindScannerRpcOptions {
  readonly createSource?: (blob: BlobLike) => ByteSource;
}

export interface ScannerCallOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ScanProgress) => void;
}

/**
 * Binds streaming signature scanning onto a worker-side `RpcMessageTransport`.
 * Reads directly from the supplied `BlobLike` range inside the worker so raw file
 * payloads never pass through the main thread.
 */
export function bindScannerRpcServer(
  transport: RpcMessageTransport,
  options: BindScannerRpcOptions = {},
): RpcServerHandle {
  const createSource = options.createSource ?? ((blob: BlobLike) => new BlobByteSource(blob));

  return bindRpcServer<ScannerRpcSchema>(transport, {
    scanBlobRange: async (params, context) => {
      const compiled = parseHexPattern(params.pattern);
      const source = createSource(params.blob);
      const safeStart = Math.max(0, Math.min(Math.trunc(params.start), source.size));
      const safeEnd = Math.max(safeStart, Math.min(Math.trunc(params.end), source.size));
      const entrySlice = source.slice(safeStart, safeEnd);

      const scanTarget: ByteSource = params.decompress
        ? new BufferByteSource(await gunzip(await entrySlice.read(0, entrySlice.size)))
        : entrySlice;

      return scanByteSource(scanTarget, compiled, {
        ...(params.chunkSize !== undefined ? { chunkSize: params.chunkSize } : {}),
        ...(params.maxHits !== undefined ? { maxHits: params.maxHits } : {}),
        signal: context.signal,
        onProgress(progress) {
          context.reportProgress?.(progress);
        },
      });
    },
  });
}

/**
 * Typed main-thread client for the dedicated signature scanner worker.
 */
export class ScannerRpcClient {
  private readonly rpc: RpcClient<ScannerRpcSchema>;

  constructor(endpoint: RpcEndpoint) {
    this.rpc = new RpcClient<ScannerRpcSchema>(endpoint);
  }

  scanBlobRange(
    params: ScanBlobRangeParams,
    options: ScannerCallOptions = {},
  ): Promise<ScanResult> {
    const rpcOptions: RpcCallOptions = {
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      ...(options.onProgress !== undefined
        ? {
            onProgress: (raw: unknown) => {
              options.onProgress?.(raw as ScanProgress);
            },
          }
        : {}),
    };
    return this.rpc.call('scanBlobRange', params, rpcOptions);
  }

  dispose(terminateEndpoint = false): void {
    this.rpc.dispose(terminateEndpoint);
  }
}
