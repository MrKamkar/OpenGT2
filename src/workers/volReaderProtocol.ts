import {
  type VolEntry,
  type VolInfo,
  VolReader,
  type VolReaderOpenOptions,
} from '../formats/vol';
import {
  BlobByteSource,
  type BlobLike,
  type ByteSource,
  type CachedByteSourceOptions,
} from '../io';
import {
  bindRpcServer,
  type RpcCallOptions,
  RpcClient,
  type RpcEndpoint,
  type RpcMessageTransport,
  type RpcServerHandle,
  withTransfer,
} from './rpc';

export interface VolReaderOpenParams {
  readonly blob: BlobLike;
  readonly lastModified?: number;
  readonly cacheOptions?: CachedByteSourceOptions;
}

export interface VolReaderListParams {
  readonly dir?: string;
}

export interface VolReaderPathParams {
  readonly path: string;
}

export interface VolReaderRpcSchema {
  open: {
    readonly params: VolReaderOpenParams;
    readonly result: VolInfo;
  };
  list: {
    readonly params: VolReaderListParams;
    readonly result: readonly VolEntry[];
  };
  stat: {
    readonly params: VolReaderPathParams;
    readonly result: VolEntry | undefined;
  };
  read: {
    readonly params: VolReaderPathParams;
    readonly result: Uint8Array;
  };
  close: {
    readonly params: Record<string, never>;
    readonly result: void;
  };
}

export interface BindVolReaderRpcOptions {
  /** Optional source factory override (defaults to `new BlobByteSource(blob)`). */
  readonly createSource?: (blob: BlobLike) => ByteSource;
}

/**
 * Copies `bytes` into a dedicated, unshared `ArrayBuffer` of exact `bytes.byteLength`
 * so transferring it back from a worker can never detach cached windows in `CachedByteSource`.
 */
export function toOwnedTransferUint8Array(bytes: Uint8Array): {
  readonly bytes: Uint8Array;
  readonly buffer: ArrayBuffer;
} {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return {
    bytes: copy,
    buffer: copy.buffer,
  };
}

/**
 * Binds `VolReader` operations onto a worker-side `RpcMessageTransport`.
 */
export function bindVolReaderRpcServer(
  transport: RpcMessageTransport,
  reader = new VolReader(),
  options: BindVolReaderRpcOptions = {},
): RpcServerHandle {
  const createSource = options.createSource ?? ((blob: BlobLike) => new BlobByteSource(blob));

  return bindRpcServer<VolReaderRpcSchema>(transport, {
    open: (params) => {
      const source = createSource(params.blob);
      const openOptions: VolReaderOpenOptions = {
        ...(params.lastModified !== undefined ? { lastModified: params.lastModified } : {}),
        ...(params.cacheOptions !== undefined ? { cacheOptions: params.cacheOptions } : {}),
      };
      return reader.open(source, openOptions);
    },
    list: (params) => reader.list(params.dir),
    stat: (params) => reader.stat(params.path),
    read: async (params) => {
      const data = await reader.read(params.path);
      const owned = toOwnedTransferUint8Array(data);
      return withTransfer(owned.bytes, [owned.buffer]);
    },
    close: () => {
      reader.close();
    },
  });
}

/**
 * Typed main-thread client communicating with a `VolReader` worker over `RpcClient`.
 */
export class VolReaderRpcClient {
  private readonly rpc: RpcClient<VolReaderRpcSchema>;

  constructor(endpoint: RpcEndpoint) {
    this.rpc = new RpcClient<VolReaderRpcSchema>(endpoint);
  }

  open(
    blob: BlobLike,
    options: VolReaderOpenOptions = {},
    rpcOptions?: RpcCallOptions,
  ): Promise<VolInfo> {
    const params: VolReaderOpenParams = {
      blob,
      ...(options.lastModified !== undefined ? { lastModified: options.lastModified } : {}),
      ...(options.cacheOptions !== undefined ? { cacheOptions: options.cacheOptions } : {}),
    };
    return this.rpc.call('open', params, rpcOptions);
  }

  list(dir?: string, rpcOptions?: RpcCallOptions): Promise<readonly VolEntry[]> {
    const params: VolReaderListParams = dir !== undefined ? { dir } : {};
    return this.rpc.call('list', params, rpcOptions);
  }

  stat(path: string, rpcOptions?: RpcCallOptions): Promise<VolEntry | undefined> {
    return this.rpc.call('stat', { path }, rpcOptions);
  }

  read(path: string, rpcOptions?: RpcCallOptions): Promise<Uint8Array> {
    return this.rpc.call('read', { path }, rpcOptions);
  }

  close(rpcOptions?: RpcCallOptions): Promise<void> {
    return this.rpc.call('close', {}, rpcOptions);
  }

  dispose(terminateEndpoint = false): void {
    this.rpc.dispose(terminateEndpoint);
  }
}
