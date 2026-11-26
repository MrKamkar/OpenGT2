import { bindImageDecoderRpcServer } from './imageDecoderProtocol';
import type { RpcMessageTransport } from './rpc';

const isWorkerContext =
  typeof document === 'undefined' &&
  typeof globalThis.addEventListener === 'function' &&
  typeof globalThis.postMessage === 'function';

if (isWorkerContext) {
  const scope = globalThis as unknown as RpcMessageTransport;
  bindImageDecoderRpcServer(scope);
}
