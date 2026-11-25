import { describe, expect, it } from 'vitest';
import { BufferByteSource, type ByteSource, SlicedByteSource } from '../../src/io';
import { parseVolHeader } from '../../src/formats/vol/header';
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

describe('parseVolHeader (M2.1)', () => {
  it('parses valid header from synthetic VOL and reads only 16 bytes', async () => {
    const fixture = createThreeLevelFixture({ unk0x0c: 0x12345678 });
    const spy = new SpyByteSource(fixture.source);

    const header = await parseVolHeader(spy);
    expect(header).toEqual({
      files: fixture.built.files,
      totalEntries: fixture.built.totalEntries,
      unk_0x0C: 0x12345678,
    });
    expect(spy.reads).toEqual([{ start: 0, end: 16 }]);
  });

  it('throws VolError.TruncatedHeader when archive is smaller than 16 bytes', async () => {
    for (const length of [0, 8, 15]) {
      const source = new BufferByteSource(new Uint8Array(length));
      await expect(parseVolHeader(source)).rejects.toMatchObject({
        name: 'VolError',
        code: VolError.TruncatedHeader,
      });
    }
  });

  it('throws VolError.BadMagic on non-GTFS headers', async () => {
    const wrongMagic = buildSyntheticVol(
      [{ kind: 'file', name: 'a.bin', data: new Uint8Array([1]) }],
      { magicOverride: new Uint8Array([0x47, 0x54, 0x32, 0x4b, 0, 0, 0, 0]) },
    );
    await expect(parseVolHeader(new BufferByteSource(wrongMagic.bytes))).rejects.toMatchObject({
      name: 'VolError',
      code: VolError.BadMagic,
    });

    const badTrailingNull = buildSyntheticVol(
      [{ kind: 'file', name: 'a.bin', data: new Uint8Array([1]) }],
      { magicOverride: new Uint8Array([0x47, 0x54, 0x46, 0x53, 0, 0, 0, 1]) },
    );
    await expect(parseVolHeader(new BufferByteSource(badTrailingNull.bytes))).rejects.toMatchObject({
      name: 'VolError',
      code: VolError.BadMagic,
    });
  });

  it('throws VolError.InvalidHeaderCounts when files/totalEntries invariants fail', async () => {
    const cases: Array<{ readonly filesOverride: number; readonly totalEntriesOverride: number }> = [
      { filesOverride: 0, totalEntriesOverride: 5 },
      { filesOverride: -1, totalEntriesOverride: 5 },
      { filesOverride: 3, totalEntriesOverride: 0 },
      { filesOverride: 3, totalEntriesOverride: -2 },
      { filesOverride: 4, totalEntriesOverride: 4 },
      { filesOverride: 5, totalEntriesOverride: 4 },
    ];

    for (const counts of cases) {
      const built = buildSyntheticVol(
        [{ kind: 'file', name: 'a.bin', data: new Uint8Array([1]) }],
        counts,
      );
      await expect(parseVolHeader(new BufferByteSource(built.bytes))).rejects.toMatchObject({
        name: 'VolError',
        code: VolError.InvalidHeaderCounts,
      });
    }
  });
});
