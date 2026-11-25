import { describe, expect, it } from 'vitest';
import { BufferByteSource, type ByteSource, SlicedByteSource } from '../../src/io';
import { parseVolHeader } from '../../src/formats/vol/header';
import { parseVolOffsets, splitOffset } from '../../src/formats/vol/offsets';
import { VolError } from '../../src/formats/vol/types';
import { buildSyntheticVol, createThreeLevelFixture } from '../fixtures/buildVol';

class SpyByteSource implements ByteSource {
  readonly size: number;
  readonly reads: Array<{ readonly start: number; readonly end: number }> = [];
  private readonly inner: ByteSource;

  constructor(inner: ByteSource) {
    this.inner = inner;
    this.size = inner.size;
  }

  async read(start: number, end: number): Promise<Uint8Array> {
    this.reads.push({ start, end });
    return this.inner.read(start, end);
  }

  slice(start: number, end: number): ByteSource {
    return new SlicedByteSource(this, start, end);
  }
}

describe('splitOffset & parseVolOffsets (M2.2)', () => {
  it('splits mangled uint32 offsets into unsigned sector address and 11-bit tail', () => {
    expect(splitOffset(0)).toEqual({ address: 0, tail: 0 });
    expect(splitOffset(0x800)).toEqual({ address: 0x800, tail: 0 });
    expect(splitOffset(0x1800 | 0x7ff)).toEqual({ address: 0x1800, tail: 0x7ff });
    // Bit 31 set: must stay unsigned (>= 0), never negative.
    expect(splitOffset(0x80001234)).toEqual({ address: 0x80001000, tail: 0x234 });
  });

  it('reads only [0x10, 0x10 + files * 4) and appends virtual archive size at offsets[files]', async () => {
    const fixture = createThreeLevelFixture();
    const header = await parseVolHeader(fixture.source);
    const spy = new SpyByteSource(fixture.source);

    const offsets = await parseVolOffsets(spy, header.files);

    expect(spy.reads).toEqual([{ start: 0x10, end: 0x10 + header.files * 4 }]);
    expect(offsets.length).toBe(header.files + 1);
    expect(offsets.slice(0, header.files)).toEqual(fixture.built.offsets);
    expect(offsets[header.files]).toBe(fixture.source.size);
  });

  it('throws VolError.InvalidOffsetCount when files < 2 or non-integer', async () => {
    const source = new BufferByteSource(new Uint8Array(64));

    for (const badFiles of [-1, 0, 1, 2.5, Number.NaN]) {
      await expect(parseVolOffsets(source, badFiles)).rejects.toMatchObject({
        name: 'VolError',
        code: VolError.InvalidOffsetCount,
      });
    }
  });

  it('throws VolError.TruncatedOffsetTable when archive ends before offset table completes', async () => {
    const built = buildSyntheticVol(
      [{ kind: 'file', name: 'a.bin', data: new Uint8Array([1, 2, 3]) }],
      { truncateToBytes: 0x10 + 3 * 4 - 1 },
    );
    const source = new BufferByteSource(built.bytes);

    await expect(parseVolOffsets(source, 3)).rejects.toMatchObject({
      name: 'VolError',
      code: VolError.TruncatedOffsetTable,
    });
  });
});
