import { type ByteSource, validateByteRange, validateByteSize } from './ByteSource';

/**
 * Minimal structural subset of Web Blob / File needed for streaming range reads.
 * Keeps BlobByteSource decoupled from DOM / window globals.
 */
export interface BlobLike {
  readonly size: number;
  slice(start?: number, end?: number): BlobLike;
  arrayBuffer(): Promise<ArrayBuffer>;
}

/**
 * Streaming ByteSource backed by a File or Blob.
 * Never loads the entire Blob into RAM; every read slices only [start, end).
 */
export class BlobByteSource implements ByteSource {
  readonly size: number;
  private readonly blob: BlobLike;
  private readonly baseOffset: number;

  constructor(blob: BlobLike, baseOffset = 0, length?: number) {
    validateByteSize(blob.size, 'blob.size');
    const resolvedLength = length ?? blob.size - baseOffset;
    validateByteSize(baseOffset, 'baseOffset');
    validateByteSize(resolvedLength, 'length');
    validateByteRange(baseOffset, baseOffset + resolvedLength, blob.size);

    this.blob = blob;
    this.baseOffset = baseOffset;
    this.size = resolvedLength;
  }

  async read(start: number, end: number): Promise<Uint8Array> {
    validateByteRange(start, end, this.size);
    const expectedLength = end - start;
    if (expectedLength === 0) {
      return new Uint8Array(0);
    }

    const absStart = this.baseOffset + start;
    const absEnd = this.baseOffset + end;
    const chunk = this.blob.slice(absStart, absEnd);
    const buffer = await chunk.arrayBuffer();
    const bytes = new Uint8Array(buffer);

    if (bytes.byteLength !== expectedLength) {
      throw new RangeError(
        `Short read from BlobByteSource: expected ${String(expectedLength)} bytes, got ${String(bytes.byteLength)}`,
      );
    }

    return bytes;
  }

  slice(start: number, end: number): ByteSource {
    validateByteRange(start, end, this.size);
    return new BlobByteSource(this.blob, this.baseOffset + start, end - start);
  }
}
