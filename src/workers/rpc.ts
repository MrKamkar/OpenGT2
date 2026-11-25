/**
 * Minimal message event contract compatible with Web Worker / MessagePort / test mocks.
 */
export interface RpcMessageEventLike {
  readonly data: unknown;
}

/**
 * Minimal error event contract compatible with Web Worker ErrorEvent / test mocks.
 */
export interface RpcErrorEventLike {
  readonly message?: string;
  readonly error?: unknown;
}

/**
 * Minimal message transport used by worker RPC servers and clients.
 * Decoupled from DOM/window so it can be tested directly in Node/Vitest.
 */
export interface RpcMessageTransport {
  postMessage(message: unknown): void;
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: RpcMessageEventLike) => void): void;
  removeEventListener(type: 'message', listener: (event: RpcMessageEventLike) => void): void;
  terminate?(): void;
}

/**
 * Full worker-side endpoint contract (adds worker error event handling to RpcMessageTransport).
 * Directly satisfied by standard Web `Worker`.
 */
export interface RpcEndpoint extends RpcMessageTransport {
  addEventListener(type: 'message', listener: (event: RpcMessageEventLike) => void): void;
  addEventListener(type: 'error', listener: (event: RpcErrorEventLike) => void): void;
  removeEventListener(type: 'message', listener: (event: RpcMessageEventLike) => void): void;
  removeEventListener(type: 'error', listener: (event: RpcErrorEventLike) => void): void;
}

/**
 * Schema constraint satisfied by both `interface` and `type` procedure maps.
 */
export type RpcMethodMap<T> = {
  [K in keyof T]: {
    readonly params: unknown;
    readonly result: unknown;
  };
};

export interface SerializedRpcError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly code?: string;
}

export interface RpcRequestMessage {
  readonly kind: 'rpc:request';
  readonly id: number;
  readonly method: string;
  readonly params: unknown;
}

export interface RpcCancelMessage {
  readonly kind: 'rpc:cancel';
  readonly id: number;
}

export interface RpcSuccessResponseMessage {
  readonly kind: 'rpc:response';
  readonly id: number;
  readonly ok: true;
  readonly result: unknown;
}

export interface RpcErrorResponseMessage {
  readonly kind: 'rpc:response';
  readonly id: number;
  readonly ok: false;
  readonly error: SerializedRpcError;
}

export type RpcResponseMessage = RpcSuccessResponseMessage | RpcErrorResponseMessage;
export type RpcWireMessage = RpcRequestMessage | RpcCancelMessage | RpcResponseMessage;

export interface RpcCallOptions {
  readonly signal?: AbortSignal;
  readonly transfer?: Transferable[];
}

export interface RpcHandlerContext {
  readonly signal: AbortSignal;
}

const RPC_TRANSFER_BRAND = Symbol('OpenGT2.RpcTransferResult');

export interface RpcTransferResult<T> {
  readonly [RPC_TRANSFER_BRAND]: true;
  readonly value: T;
  readonly transfer: Transferable[];
}

/**
 * Wraps a worker handler return value along with Transferable objects (e.g. ArrayBuffer)
 * to transfer ownership back to the main thread without copying or SharedArrayBuffer.
 */
export function withTransfer<T>(value: T, transfer: Transferable[]): RpcTransferResult<T> {
  return {
    [RPC_TRANSFER_BRAND]: true,
    value,
    transfer,
  };
}

export function isRpcTransferResult<T>(value: unknown): value is RpcTransferResult<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    RPC_TRANSFER_BRAND in value &&
    (value as { readonly [RPC_TRANSFER_BRAND]?: unknown })[RPC_TRANSFER_BRAND] === true
  );
}

/**
 * Error reconstructed on the caller side from a worker RPC failure,
 * preserving the original error message and name.
 */
export class RpcError extends Error {
  readonly remoteStack: string | undefined;
  readonly code: string | undefined;

  constructor(
    message: string,
    options?: {
      readonly name?: string;
      readonly remoteStack?: string;
      readonly code?: string;
    },
  ) {
    super(message);
    this.name = options?.name ?? 'RpcError';
    this.remoteStack = options?.remoteStack;
    this.code = options?.code;
  }
}

export function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }
  const message =
    typeof reason === 'string' && reason.length > 0 ? reason : 'The RPC request was aborted.';
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function serializeRpcError(error: unknown): SerializedRpcError {
  if (error instanceof Error) {
    const rawCode = (error as { readonly code?: unknown }).code;
    const base: SerializedRpcError = {
      name: error.name || 'Error',
      message: error.message,
      ...(typeof error.stack === 'string' ? { stack: error.stack } : {}),
      ...(typeof rawCode === 'string' ? { code: rawCode } : {}),
    };
    return base;
  }

  return {
    name: 'Error',
    message: typeof error === 'string' ? error : String(error),
  };
}

function deserializeRpcError(serialized: SerializedRpcError): RpcError {
  return new RpcError(serialized.message, {
    name: serialized.name,
    ...(serialized.stack !== undefined ? { remoteStack: serialized.stack } : {}),
    ...(serialized.code !== undefined ? { code: serialized.code } : {}),
  });
}

function postMessageWithOptionalTransfer(
  transport: RpcMessageTransport,
  message: unknown,
  transfer?: Transferable[],
): void {
  if (transfer !== undefined && transfer.length > 0) {
    transport.postMessage(message, transfer);
  } else {
    transport.postMessage(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isRpcResponseMessage(value: unknown): value is RpcResponseMessage {
  if (!isRecord(value) || value['kind'] !== 'rpc:response' || typeof value['id'] !== 'number') {
    return false;
  }
  if (value['ok'] === true) {
    return true;
  }
  if (value['ok'] === false && isRecord(value['error'])) {
    return (
      typeof value['error']['name'] === 'string' && typeof value['error']['message'] === 'string'
    );
  }
  return false;
}

function isRpcRequestMessage(value: unknown): value is RpcRequestMessage {
  return (
    isRecord(value) &&
    value['kind'] === 'rpc:request' &&
    typeof value['id'] === 'number' &&
    typeof value['method'] === 'string'
  );
}

function isRpcCancelMessage(value: unknown): value is RpcCancelMessage {
  return isRecord(value) && value['kind'] === 'rpc:cancel' && typeof value['id'] === 'number';
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly cleanupAbort: (() => void) | undefined;
}

/**
 * Typed RPC client communicating over a minimal RpcEndpoint / RpcMessageTransport.
 */
export class RpcClient<TSchema extends RpcMethodMap<TSchema>> {
  private readonly endpoint: RpcEndpoint;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private disposed = false;

  private readonly handleMessage = (event: RpcMessageEventLike): void => {
    const data = event.data;
    if (!isRpcResponseMessage(data)) {
      return;
    }

    const entry = this.pending.get(data.id);
    if (entry === undefined) {
      return;
    }

    this.pending.delete(data.id);
    entry.cleanupAbort?.();

    if (data.ok) {
      entry.resolve(data.result);
    } else {
      entry.reject(deserializeRpcError(data.error));
    }
  };

  private readonly handleError = (event: RpcErrorEventLike): void => {
    const message =
      typeof event.message === 'string' && event.message.length > 0
        ? event.message
        : event.error instanceof Error
          ? event.error.message
          : 'Worker error occurred during RPC call.';
    const error = new RpcError(message, { name: 'RpcWorkerError' });
    this.rejectAllPending(error);
  };

  constructor(endpoint: RpcEndpoint) {
    this.endpoint = endpoint;
    this.endpoint.addEventListener('message', this.handleMessage);
    this.endpoint.addEventListener('error', this.handleError);
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  call<K extends keyof TSchema & string>(
    method: K,
    params: TSchema[K]['params'],
    options?: RpcCallOptions,
  ): Promise<TSchema[K]['result']> {
    if (this.disposed) {
      return Promise.reject(new RpcError('RPC client has been disposed.'));
    }

    const signal = options?.signal;
    if (signal?.aborted) {
      return Promise.reject(createAbortError(signal.reason));
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise<TSchema[K]['result']>((resolve, reject) => {
      let cleanupAbort: (() => void) | undefined;

      if (signal !== undefined) {
        const onAbort = (): void => {
          const entry = this.pending.get(id);
          if (entry === undefined) {
            return;
          }
          this.pending.delete(id);
          const cancelMsg: RpcCancelMessage = { kind: 'rpc:cancel', id };
          try {
            this.endpoint.postMessage(cancelMsg);
          } catch {
            // Endpoint may already be closed; caller still rejects with AbortError.
          }
          reject(createAbortError(signal.reason));
        };

        signal.addEventListener('abort', onAbort, { once: true });
        cleanupAbort = (): void => {
          signal.removeEventListener('abort', onAbort);
        };
      }

      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        cleanupAbort,
      });

      const request: RpcRequestMessage = {
        kind: 'rpc:request',
        id,
        method,
        params,
      };

      try {
        postMessageWithOptionalTransfer(this.endpoint, request, options?.transfer);
      } catch (postError) {
        this.pending.delete(id);
        cleanupAbort?.();
        reject(postError);
      }
    });
  }

  dispose(terminateEndpoint = false): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.endpoint.removeEventListener('message', this.handleMessage);
    this.endpoint.removeEventListener('error', this.handleError);
    this.rejectAllPending(new RpcError('RPC client was disposed.'));
    if (terminateEndpoint) {
      this.endpoint.terminate?.();
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id);
      entry.cleanupAbort?.();
      entry.reject(error);
    }
  }
}

export type RpcHandler<TParams, TResult> = (
  params: TParams,
  context: RpcHandlerContext,
) => Promise<TResult | RpcTransferResult<TResult>> | TResult | RpcTransferResult<TResult>;

export type RpcHandlers<TSchema extends RpcMethodMap<TSchema>> = {
  readonly [K in keyof TSchema & string]: RpcHandler<TSchema[K]['params'], TSchema[K]['result']>;
};

export interface RpcServerHandle {
  dispose(): void;
}

/**
 * Binds typed RPC handlers on the worker side of an RpcMessageTransport.
 */
export function bindRpcServer<TSchema extends RpcMethodMap<TSchema>>(
  transport: RpcMessageTransport,
  handlers: RpcHandlers<TSchema>,
): RpcServerHandle {
  const inFlight = new Map<number, AbortController>();
  let disposed = false;

  const handleMessage = (event: RpcMessageEventLike): void => {
    if (disposed) {
      return;
    }

    const data = event.data;

    if (isRpcCancelMessage(data)) {
      const controller = inFlight.get(data.id);
      if (controller !== undefined) {
        controller.abort();
      }
      return;
    }

    if (!isRpcRequestMessage(data)) {
      return;
    }

    const { id, method, params } = data;
    if (!Object.prototype.hasOwnProperty.call(handlers, method)) {
      const response: RpcErrorResponseMessage = {
        kind: 'rpc:response',
        id,
        ok: false,
        error: {
          name: 'RpcMethodNotFoundError',
          message: `Unknown RPC method: ${method}`,
        },
      };
      transport.postMessage(response);
      return;
    }

    const handler = handlers[method as keyof TSchema & string] as RpcHandler<unknown, unknown>;
    const controller = new AbortController();
    inFlight.set(id, controller);

    void Promise.resolve()
      .then(() => handler(params, { signal: controller.signal }))
      .then(
        (rawResult) => {
          inFlight.delete(id);
          if (disposed || controller.signal.aborted) {
            return;
          }

          if (isRpcTransferResult(rawResult)) {
            const response: RpcSuccessResponseMessage = {
              kind: 'rpc:response',
              id,
              ok: true,
              result: rawResult.value,
            };
            postMessageWithOptionalTransfer(transport, response, rawResult.transfer);
          } else {
            const response: RpcSuccessResponseMessage = {
              kind: 'rpc:response',
              id,
              ok: true,
              result: rawResult,
            };
            transport.postMessage(response);
          }
        },
        (error: unknown) => {
          inFlight.delete(id);
          if (disposed || controller.signal.aborted) {
            return;
          }

          const response: RpcErrorResponseMessage = {
            kind: 'rpc:response',
            id,
            ok: false,
            error: serializeRpcError(error),
          };
          transport.postMessage(response);
        },
      );
  };

  transport.addEventListener('message', handleMessage);

  return {
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      transport.removeEventListener('message', handleMessage);
      for (const controller of inFlight.values()) {
        controller.abort();
      }
      inFlight.clear();
    },
  };
}
