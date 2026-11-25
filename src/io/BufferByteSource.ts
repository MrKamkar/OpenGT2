import { type ByteSource, validateByteRange } from './ByteSource';

/**
 * In-memory ByteSource backed by a Uint8Array or ArrayBuffer.
 * Primarily used in unit tests and for already-decompressed small entries.
 */
export class BufferByteSource implements ByteSource {
  readonly size: number;
  private readonly view: Uint8Array;

  constructor(data: Uint8Array | ArrayBuffer) {
    this.view = data instanceof Uint8Array ? data : new Uint8Array(data);
    this.size = this.view.byteLength;
  }

  async read(start: number, end: number): Promise<Uint8Array> {
    validateByteRange(start, end, this.size);
    if (start === end) {
      return new Uint8Array(0);
    }
    // Copy only the requested range so caller mutations or Transferable detachments
    // cannot corrupt or detach the backing buffer.
    return this.view.slice(start, end);
  }

  slice(start: number, end: number): ByteSource {
    validateByteRange(start, end, this.size);
    // Zero-copy view over the same underlying ArrayBuffer.
    return new BufferByteSource(this.view.subarray(start, end));
  }
}
