import { describe, expect, it } from 'vitest';
import { BufferByteSource, type ByteSource, SlicedByteSource } from '../../src/io';
import { parseVolHeader } from '../../src/formats/vol/header';
import { parseVolOffsets } from '../../src/formats/vol/offsets';
import { computeTocBounds, parseVolToc } from '../../src/formats/vol/toc';
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

describe('computeTocBounds & parseVolToc (M2.3)', () => {
  it('computes TOC bounds and reads only the TOC range via ByteSource', async () => {
    const fixture = createThreeLevelFixture();
    const header = await parseVolHeader(fixture.source);
    const offsets = await parseVolOffsets(fixture.source, header.files);

    const bounds = computeTocBounds(offsets, header.totalEntries, fixture.source.size);
    expect(bounds.tocAddress).toBe(fixture.built.tocAddress);
    expect(bounds.firstFileAddress).toBe(fixture.built.firstFileAddress);
    expect(bounds.tocLength).toBe(header.totalEntries * 32);

    const spy = new SpyByteSource(fixture.source);
    const entries = await parseVolToc(spy, offsets, header.totalEntries);

    expect(spy.reads).toEqual([
      { start: bounds.tocAddress, end: bounds.tocAddress + bounds.tocLength },
    ]);
    expect(entries.length).toBe(header.totalEntries);
    expect(entries[0]).toEqual({
      unixTime: 940_000_001,
      offsetIndex: 2,
      flags: 0x00,
      isDirectory: false,
      isLastInDirectory: false,
      name: 'readme.txt',
    });
    // Root last entry (`dirB`) has 0x81 = directory + last in directory
    expect(entries[4]).toEqual({
      unixTime: 940_000_060,
      offsetIndex: 1,
      flags: 0x81,
      isDirectory: true,
      isLastInDirectory: true,
      name: 'dirB',
    });
    // `emptyDir` has a single `..` entry with offsetIndex=0 and flags=0x81
    expect(entries[16]).toEqual({
      unixTime: 940_000_050,
      offsetIndex: 0,
      flags: 0x81,
      isDirectory: true,
      isLastInDirectory: true,
      name: '..',
    });
  });

  it('parses full 25-char names without NUL terminator, negative int32 times, and E0 flag bits', async () => {
    const maxName = 'abcdefghij1234567890ABCDE'; // exactly 25 ASCII chars
    const built = buildSyntheticVol(
      [
        {
          kind: 'dir',
          name: 'd1',
          children: [{ kind: 'file', name: maxName, data: new Uint8Array([42]), unixTime: -12345 }],
        },
        {
          kind: 'dir',
          name: 'd2',
          children: [{ kind: 'file', name: 'other.bin', data: new Uint8Array([1]) }],
        },
      ],
      {
        tocEntryOverrides: {
          3: { flags: 0x80 | 0x24 }, // E0 bits 0x24 + last-entry bit 0x80 on `maxName`
        },
      },
    );
    const source = new BufferByteSource(built.bytes);
    const header = await parseVolHeader(source);
    const offsets = await parseVolOffsets(source, header.files);
    const entries = await parseVolToc(source, offsets, header.totalEntries);

    expect(entries[3]).toEqual({
      unixTime: -12345,
      offsetIndex: 2,
      flags: 0xa4,
      isDirectory: false,
      isLastInDirectory: true,
      name: maxName,
    });
  });

  it('throws VolError.InvalidTocBounds when tocLength < totalEntries * 32 or firstFile < tocAddress', async () => {
    const fixture = createThreeLevelFixture();
    const header = await parseVolHeader(fixture.source);
    const offsets = await parseVolOffsets(fixture.source, header.files);

    // Shrink tocLength by increasing tocTail by 1 byte -> tocLength < totalEntries * 32.
    const tooSmallTailOffsets = [...offsets];
    tooSmallTailOffsets[1] = (tooSmallTailOffsets[1] ?? 0) + 1;
    expect(() =>
      computeTocBounds(tooSmallTailOffsets, header.totalEntries, fixture.source.size),
    ).toThrowError(expect.objectContaining({ name: 'VolError', code: VolError.InvalidTocBounds }));

    // Negative tocLength (firstFileAddress < tocAddress).
    const invertedOffsets = [...offsets];
    invertedOffsets[2] = 0x800;
    invertedOffsets[1] = 0x1000;
    expect(() =>
      computeTocBounds(invertedOffsets, header.totalEntries, fixture.source.size),
    ).toThrowError(expect.objectContaining({ name: 'VolError', code: VolError.InvalidTocBounds }));
  });

  it('throws VolError.TruncatedToc when TOC extends beyond archive size', async () => {
    const fixture = createThreeLevelFixture();
    const header = await parseVolHeader(fixture.source);
    const offsets = await parseVolOffsets(fixture.source, header.files);

    const truncatedSource = new BufferByteSource(
      fixture.built.bytes.subarray(0, fixture.built.tocAddress + 16),
    );
    await expect(parseVolToc(truncatedSource, offsets, header.totalEntries)).rejects.toMatchObject({
      name: 'VolError',
      code: VolError.TruncatedToc,
    });
  });
});
