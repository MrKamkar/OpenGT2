import { describe, expect, it, vi } from 'vitest';
import {
  BufferByteSource,
  FINGERPRINT_SAMPLE_BYTES,
  SlicedByteSource,
  fingerprint,
  formatShortFingerprint,
  type ByteSource,
} from '../../src/io';

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

class VirtualLargeByteSource implements ByteSource {
  readonly size: number;
  readonly readRanges: Array<readonly [number, number]> = [];
  private readonly overrides: ReadonlyMap<number, number>;

  constructor(size: number, overrides: ReadonlyMap<number, number> = new Map()) {
    this.size = size;
    this.overrides = overrides;
  }

  async read(start: number, end: number): Promise<Uint8Array> {
    this.readRanges.push([start, end]);
    const length = end - start;
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) {
      const absOffset = start + i;
      const custom = this.overrides.get(absOffset);
      out[i] = custom !== undefined ? custom : (absOffset * 31 + 17) & 0xff;
    }
    return out;
  }

  slice(start: number, end: number): ByteSource {
    return new SlicedByteSource(this, start, end);
  }
}

describe('fingerprint (M1.5)', () => {
  it('is deterministic for identical content, size, and lastModified', async () => {
    const bytes = new Uint8Array(4096);
    for (let i = 0; i < bytes.length; i += 1) {
      bytes[i] = (i * 13 + 7) & 0xff;
    }

    const sourceA = new BufferByteSource(bytes);
    const sourceB = new BufferByteSource(bytes.slice());

    const hashA = await fingerprint(sourceA, { lastModified: 1_700_000_000_000 });
    const hashB = await fingerprint(sourceB, { lastModified: 1_700_000_000_000 });

    expect(hashA).toMatch(SHA256_HEX_PATTERN);
    expect(hashA).toBe(hashB);
  });

  it('handles empty files and files smaller than 1 MiB and between 1 MiB and 2 MiB cleanly', async () => {
    const emptySource = new VirtualLargeByteSource(0);
    const emptyHash = await fingerprint(emptySource);
    expect(emptyHash).toMatch(SHA256_HEX_PATTERN);
    expect(emptySource.readRanges).toEqual([]);

    const smallSource = new VirtualLargeByteSource(512);
    const smallHash = await fingerprint(smallSource, { sampleBytes: 1024 });
    expect(smallHash).toMatch(SHA256_HEX_PATTERN);
    expect(smallSource.readRanges).toEqual([[0, 512]]);

    const midSource = new VirtualLargeByteSource(1500);
    const midHash = await fingerprint(midSource, { sampleBytes: 1024 });
    expect(midHash).toMatch(SHA256_HEX_PATTERN);
    expect(midSource.readRanges).toEqual([
      [0, 1024],
      [1024, 1500],
    ]);

    expect(new Set([emptyHash, smallHash, midHash]).size).toBe(3);
  });

  it('changes hash when head bytes, tail bytes, size, or lastModified change', async () => {
    const sampleBytes = 1024;
    const baseSize = 8192;

    const baseSource = new VirtualLargeByteSource(baseSize);
    const headChanged = new VirtualLargeByteSource(baseSize, new Map([[42, 0xaa]]));
    const tailChanged = new VirtualLargeByteSource(baseSize, new Map([[baseSize - 17, 0xbb]]));
    const sizeChanged = new VirtualLargeByteSource(baseSize + 1);

    const baseHash = await fingerprint(baseSource, { sampleBytes, lastModified: 1000 });
    const headHash = await fingerprint(headChanged, { sampleBytes, lastModified: 1000 });
    const tailHash = await fingerprint(tailChanged, { sampleBytes, lastModified: 1000 });
    const sizeHash = await fingerprint(sizeChanged, { sampleBytes, lastModified: 1000 });
    const mtimeHash = await fingerprint(baseSource, { sampleBytes, lastModified: 2000 });
    const noMtimeHash = await fingerprint(baseSource, { sampleBytes });

    expect(headHash).not.toBe(baseHash);
    expect(tailHash).not.toBe(baseHash);
    expect(sizeHash).not.toBe(baseHash);
    expect(mtimeHash).not.toBe(baseHash);
    expect(noMtimeHash).not.toBe(baseHash);
  });

  it('reads only head and tail 1 MiB fragments on a huge virtual ByteSource without touching the middle', async () => {
    // 640 MiB virtual source (typical CD-ROM archive size) without allocating 640 MiB RAM.
    const virtualSize = 640 * 1024 * 1024;
    const virtualSource = new VirtualLargeByteSource(virtualSize);
    const readSpy = vi.spyOn(virtualSource, 'read');

    const hash = await fingerprint(virtualSource);

    expect(hash).toMatch(SHA256_HEX_PATTERN);
    expect(readSpy).toHaveBeenCalledTimes(2);
    expect(virtualSource.readRanges).toEqual([
      [0, FINGERPRINT_SAMPLE_BYTES],
      [virtualSize - FINGERPRINT_SAMPLE_BYTES, virtualSize],
    ]);

    // Verify middle bytes are untouched and mutating the middle does not alter sampled fingerprint.
    const middleOffset = Math.floor(virtualSize / 2);
    const middleMutated = new VirtualLargeByteSource(
      virtualSize,
      new Map([[middleOffset, 0xff]]),
    );
    const middleMutatedHash = await fingerprint(middleMutated);
    expect(middleMutatedHash).toBe(hash);
  });

  it('validates invalid sampleBytes and lastModified arguments', async () => {
    const source = new BufferByteSource(new Uint8Array([1, 2, 3]));

    await expect(fingerprint(source, { sampleBytes: 0 })).rejects.toThrow(RangeError);
    await expect(fingerprint(source, { sampleBytes: -16 })).rejects.toThrow(RangeError);
    await expect(fingerprint(source, { sampleBytes: 1.5 })).rejects.toThrow(RangeError);
    await expect(fingerprint(source, { lastModified: Number.NaN })).rejects.toThrow(RangeError);
    await expect(
      fingerprint(source, { lastModified: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow(RangeError);
  });

  it('formats short fingerprints cleanly for UI display', () => {
    const full = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
    expect(formatShortFingerprint(full)).toBe('01234567…cdef');
    expect(formatShortFingerprint('abcd1234', 12)).toBe('abcd1234');
    expect(formatShortFingerprint(full, 4)).toBe('0123');
    expect(() => formatShortFingerprint(full, 0)).toThrow(RangeError);
  });
});
