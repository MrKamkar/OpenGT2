import { describe, expect, it, vi } from 'vitest';
import {
  BlobByteSource,
  type BlobLike,
  BufferByteSource,
  type ByteSource,
  SlicedByteSource,
  validateByteRange,
} from '../../src/io';

/**
 * Virtual ByteSource representing a > 2 GiB archive without allocating backing RAM.
 * Generates deterministic bytes as a function of the 64-bit-safe JS offset.
 */
class VirtualPatternByteSource implements ByteSource {
  readonly size: number;
  readonly readLog: Array<{ start: number; end: number }> = [];

  constructor(size: number) {
    this.size = size;
  }

  async read(start: number, end: number): Promise<Uint8Array> {
    validateByteRange(start, end, this.size);
    this.readLog.push({ start, end });
    const length = end - start;
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) {
      out[i] = VirtualPatternByteSource.byteAt(start + i);
    }
    return out;
  }

  slice(start: number, end: number): ByteSource {
    return new SlicedByteSource(this, start, end);
  }

  static byteAt(offset: number): number {
    // Deterministic byte function safe for offsets well past 2^32.
    const high = Math.floor(offset / 0x1_0000_0000);
    const low = offset - high * 0x1_0000_0000;
    return (low * 31 + high * 17 + 7) & 0xff;
  }
}

describe('BufferByteSource', () => {
  it('reads slices within bounds and supports empty ranges', async () => {
    const data = new Uint8Array([10, 20, 30, 40, 50]);
    const source = new BufferByteSource(data);

    expect(source.size).toBe(5);
    expect(await source.read(0, 5)).toEqual(new Uint8Array([10, 20, 30, 40, 50]));
    expect(await source.read(1, 4)).toEqual(new Uint8Array([20, 30, 40]));
    expect(await source.read(0, 0)).toEqual(new Uint8Array(0));
    expect(await source.read(3, 3)).toEqual(new Uint8Array(0));
    expect(await source.read(5, 5)).toEqual(new Uint8Array(0));
  });

  it('constructs from an ArrayBuffer and preserves offset when given a subarray', async () => {
    const raw = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    const fromArrayBuffer = new BufferByteSource(raw.buffer);
    expect(fromArrayBuffer.size).toBe(8);
    expect(await fromArrayBuffer.read(2, 5)).toEqual(new Uint8Array([2, 3, 4]));

    const sub = raw.subarray(3, 6);
    const fromSubarray = new BufferByteSource(sub);
    expect(fromSubarray.size).toBe(3);
    expect(await fromSubarray.read(0, 3)).toEqual(new Uint8Array([3, 4, 5]));
  });

  it('isolates returned read buffers from backing storage mutations', async () => {
    const data = new Uint8Array([1, 2, 3, 4]);
    const source = new BufferByteSource(data);

    const chunk = await source.read(1, 3);
    chunk[0] = 99;
    expect(await source.read(1, 3)).toEqual(new Uint8Array([2, 3]));
    expect(chunk.buffer.byteLength).toBe(2);
  });

  it('throws RangeError for negative, reversed, non-integer, and out-of-bounds ranges', async () => {
    const source = new BufferByteSource(new Uint8Array([1, 2, 3, 4]));

    await expect(source.read(-1, 2)).rejects.toThrow(RangeError);
    await expect(source.read(0, -1)).rejects.toThrow(RangeError);
    await expect(source.read(3, 2)).rejects.toThrow(RangeError);
    await expect(source.read(0, 5)).rejects.toThrow(RangeError);
    await expect(source.read(5, 5)).rejects.toThrow(RangeError);
    await expect(source.read(0.5, 2)).rejects.toThrow(RangeError);
    await expect(source.read(0, Number.NaN)).rejects.toThrow(RangeError);
    await expect(source.read(0, Number.POSITIVE_INFINITY)).rejects.toThrow(RangeError);

    expect(() => source.slice(-1, 2)).toThrow(RangeError);
    expect(() => source.slice(3, 2)).toThrow(RangeError);
    expect(() => source.slice(0, 5)).toThrow(RangeError);
    expect(() => source.slice(1.2, 3)).toThrow(RangeError);
  });

  it('creates zero-copy nested slices sharing the same backing memory', async () => {
    const backing = new Uint8Array([10, 20, 30, 40, 50, 60]);
    const source = new BufferByteSource(backing);

    const firstSlice = source.slice(1, 5);
    expect(firstSlice.size).toBe(4);
    expect(await firstSlice.read(0, 4)).toEqual(new Uint8Array([20, 30, 40, 50]));

    const nestedSlice = firstSlice.slice(1, 3);
    expect(nestedSlice.size).toBe(2);
    expect(await nestedSlice.read(0, 2)).toEqual(new Uint8Array([30, 40]));

    // Mutating the underlying backing buffer is immediately visible through slices,
    // proving slice() did not copy the underlying data.
    backing[2] = 99;
    expect(await nestedSlice.read(0, 2)).toEqual(new Uint8Array([99, 40]));

    await expect(nestedSlice.read(0, 3)).rejects.toThrow(RangeError);
  });
});

describe('BlobByteSource', () => {
  it('reads ranges from a standard Blob without calling arrayBuffer() on the root Blob', async () => {
    const payload = new Uint8Array([0, 11, 22, 33, 44, 55, 66, 77]);
    const rootArrayBuffer = vi.fn(async () => {
      throw new Error('Root blob.arrayBuffer() must never be called');
    });
    const sliceSpy = vi.fn((start?: number, end?: number): BlobLike => {
      const sliced = payload.slice(start ?? 0, end ?? payload.byteLength);
      return {
        size: sliced.byteLength,
        slice: () => {
          throw new Error('Unexpected nested slice');
        },
        arrayBuffer: async () => sliced.buffer,
      };
    });

    const mockBlob: BlobLike = {
      size: payload.byteLength,
      slice: sliceSpy,
      arrayBuffer: rootArrayBuffer,
    };

    const source = new BlobByteSource(mockBlob);
    expect(source.size).toBe(8);

    // Empty read should not even slice the blob.
    expect(await source.read(3, 3)).toEqual(new Uint8Array(0));
    expect(sliceSpy).not.toHaveBeenCalled();

    const chunk = await source.read(2, 6);
    expect(chunk).toEqual(new Uint8Array([22, 33, 44, 55]));
    expect(sliceSpy).toHaveBeenCalledWith(2, 6);
    expect(rootArrayBuffer).not.toHaveBeenCalled();

    // Zero-copy slice translates offsets relative to the original blob.
    const sub = source.slice(3, 7).slice(1, 3);
    expect(sub.size).toBe(2);
    expect(await sub.read(0, 2)).toEqual(new Uint8Array([44, 55]));
    expect(sliceSpy).toHaveBeenLastCalledWith(4, 6);
  });

  it('works with native Node/Web Blob instances', async () => {
    const blob = new Blob([new Uint8Array([5, 6, 7, 8, 9])]);
    const source = new BlobByteSource(blob);

    expect(source.size).toBe(5);
    expect(await source.read(1, 4)).toEqual(new Uint8Array([6, 7, 8]));
    expect(await source.slice(2, 5).read(1, 3)).toEqual(new Uint8Array([8, 9]));
    await expect(source.read(0, 6)).rejects.toThrow(RangeError);
  });

  it('throws RangeError on short reads from a truncated Blob', async () => {
    const truncatedBlob: BlobLike = {
      size: 16,
      slice: () => ({
        size: 4,
        slice: () => truncatedBlob,
        arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
      }),
      arrayBuffer: async () => new ArrayBuffer(0),
    };

    const source = new BlobByteSource(truncatedBlob);
    await expect(source.read(0, 8)).rejects.toThrow(RangeError);
  });
});

describe('Large virtual ByteSource (> 2 GiB acceptance test)', () => {
  it('reads 16 bytes from an offset beyond 2 GiB without allocating 2 GiB of memory', async () => {
    const THREE_GIB = 3 * 1024 * 1024 * 1024; // 3,221,225,472 bytes (> 2 GiB)
    const offset = 2 * 1024 * 1024 * 1024 + 0x12345; // > 2 GiB
    const source = new VirtualPatternByteSource(THREE_GIB);

    const bytes = await source.read(offset, offset + 16);
    expect(bytes.byteLength).toBe(16);

    const expected = new Uint8Array(16);
    for (let i = 0; i < 16; i += 1) {
      expected[i] = VirtualPatternByteSource.byteAt(offset + i);
    }
    expect(bytes).toEqual(expected);

    // Also verify zero-copy slicing past 2 GiB.
    const highSlice = source.slice(offset - 64, offset + 64);
    expect(highSlice.size).toBe(128);
    expect(await highSlice.read(64, 80)).toEqual(expected);
    expect(source.readLog).toEqual([
      { start: offset, end: offset + 16 },
      { start: offset, end: offset + 16 },
    ]);
  });
});
