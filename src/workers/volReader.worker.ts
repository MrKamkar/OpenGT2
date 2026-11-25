import { VolReader } from '../formats/vol';
import { type RpcMessageTransport } from './rpc';
import { bindVolReaderRpcServer } from './volReaderProtocol';

const isWorkerContext =
  typeof document === 'undefined' &&
  typeof globalThis.addEventListener === 'function' &&
  typeof globalThis.postMessage === 'function';

if (isWorkerContext) {
  const scope = globalThis as unknown as RpcMessageTransport;
  bindVolReaderRpcServer(scope, new VolReader());
}
