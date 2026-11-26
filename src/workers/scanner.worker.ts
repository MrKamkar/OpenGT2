import { type RpcMessageTransport } from './rpc';
import { bindScannerRpcServer } from './scannerProtocol';

const isWorkerContext =
  typeof document === 'undefined' &&
  typeof globalThis.addEventListener === 'function' &&
  typeof globalThis.postMessage === 'function';

if (isWorkerContext) {
  const scope = globalThis as unknown as RpcMessageTransport;
  bindScannerRpcServer(scope);
}
