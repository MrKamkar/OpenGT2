import { describe, expect, it } from 'vitest';
import { BufferByteSource } from '../../src/io';
import {
  buildVolTree,
  parseVolHeader,
  parseVolOffsets,
  parseVolToc,
  resolveVolSizes,
  VOL_LAST_FILE_FALLBACK_SIZE,
} from '../../src/formats/vol';
import { buildSyntheticVol, createThreeLevelFixture } from '../fixtures/buildVol';

describe('resolveVolSizes (M2.5)', () => {
  it('resolves exact sizes (including 0-byte, sector-aligned, and last file) with zero warnings and readable payloads', async () => {
    const fixture = createThreeLevelFixture();
    const header = await parseVolHeader(fixture.source);
    const offsets = await parseVolOffsets(fixture.source, header.files);
    const rawEntries = await parseVolToc(fixture.source, offsets, header.totalEntries);
    const resolved = buildVolTree(rawEntries);
    const result = resolveVolSizes(resolved, offsets, fixture.source.size);

    expect(result.warnings).toEqual([]);
    expect(
      result.entries.map((e) => ({
        path: e.path,
        kind: e.kind,
        size: e.size,
        unixTime: e.unixTime,
      })),
    ).toEqual(fixture.expectedPaths);

    // Directories must always have address=0 and size=0.
    for (const entry of result.entries) {
      if (entry.kind === 'dir') {
        expect(entry.address).toBe(0);
        expect(entry.size).toBe(0);
      }
    }

    // Verify reading [address, address + size) from ByteSource yields exact original file bytes.
    for (const expectedFile of fixture.built.filesInOrder) {
      const parsed = result.entries.find((e) => e.path === expectedFile.path);
      expect(parsed).toBeDefined();
      if (parsed !== undefined) {
        expect(parsed.address).toBe(expectedFile.address);
        expect(parsed.size).toBe(expectedFile.size);
        const payload = await fixture.source.read(parsed.address, parsed.address + parsed.size);
        expect(payload).toEqual(expectedFile.data);
      }
    }
  });

  it('falls back to 0x800 for the last file when computed size is <= 0', async () => {
    const built = buildSyntheticVol(
      [
        { kind: 'dir', name: 'd1', children: [{ kind: 'file', name: 'f1.bin', data: new Uint8Array([1, 2, 3]) }] },
        { kind: 'dir', name: 'd2', children: [{ kind: 'file', name: 'last.bin', data: new Uint8Array(0) }] },
      ],
      {
        // Make last.bin (offsetIndex 3) have tail=0x7FF while sitting at EOF -> volEnd - addr - tail <= 0
        offsetOverrides: {
          3: (0x1800 | 0x7ff) >>> 0,
        },
      },
    );
    const source = new BufferByteSource(built.bytes);
    const header = await parseVolHeader(source);
    const offsets = await parseVolOffsets(source, header.files);
    const rawEntries = await parseVolToc(source, offsets, header.totalEntries);
    const resolved = buildVolTree(rawEntries);

    const result = resolveVolSizes(resolved, offsets, source.size);
    const lastEntry = result.entries.find((e) => e.path === 'd2/last.bin');
    expect(lastEntry?.size).toBe(VOL_LAST_FILE_FALLBACK_SIZE);
  });

  it('reports non-fatal warnings for non-monotonic addresses, overlapping files, bounds overflow, and bad offsetIndex', async () => {
    const built = buildSyntheticVol([
      {
        kind: 'dir',
        name: 'd1',
        children: [
          { kind: 'file', name: 'first.bin', data: new Uint8Array(100) },
          { kind: 'file', name: 'second.bin', data: new Uint8Array(100) },
        ],
      },
      {
        kind: 'dir',
        name: 'd2',
        children: [{ kind: 'file', name: 'third.bin', data: new Uint8Array(100) }],
      },
    ]);
    const source = new BufferByteSource(built.bytes);
    const header = await parseVolHeader(source);
    const offsets = await parseVolOffsets(source, header.files);
    const rawEntries = await parseVolToc(source, offsets, header.totalEntries);
    const resolved = buildVolTree(rawEntries);

    // Case 1: Non-monotonic & overlapping (swap offset words of file indices 2 and 3)
    const swappedOffsets = [...offsets];
    const off2 = swappedOffsets[2] ?? 0;
    const off3 = swappedOffsets[3] ?? 0;
    swappedOffsets[2] = off3;
    swappedOffsets[3] = off2;

    const nonMonotonic = resolveVolSizes(resolved, swappedOffsets, source.size);
    expect(nonMonotonic.warnings.some((w) => w.includes('Non-monotonic'))).toBe(true);
    expect(nonMonotonic.warnings.some((w) => w.includes('Negative computed size'))).toBe(true);

    // Case 2: Overlapping non-zero files sharing the same address
    const overlappingOffsets = [...offsets];
    overlappingOffsets[3] = off2; // second.bin starts at same address as first.bin, while third.bin is +0x1000
    // Give first.bin size > 0 by putting third.bin ahead; first.bin overlaps second.bin
    const overlapping = resolveVolSizes(resolved, overlappingOffsets, source.size);
    // first.bin has computed size 0 (address identical), second.bin has size 0x800 - tail -> no overlap if first is 0.
    // Force first.bin address 0x1000, second.bin address 0x1000 with non-zero size by setting third at 0x2000:
    // Actually: if off2=0x1000, off3=0x1800, and off4=0x1000 -> wait: test explicit overlap with two files sharing 0x1000
    expect(overlapping.entries.length).toBeGreaterThan(0);

    const overlapOffsets = [...offsets];
    overlapOffsets[2] = 0x1000;
    overlapOffsets[3] = 0x1800; // first.bin => [0x1000, 0x1800)
    overlapOffsets[4] = 0x1000; // second.bin => negative size (clamped 0), third.bin => [0x1000, volSize) -> overlaps first.bin!
    const overlapResult = resolveVolSizes(resolved, overlapOffsets, source.size);
    expect(overlapResult.warnings.some((w) => w.includes('Overlapping file ranges'))).toBe(true);

    // Case 3: Archive size smaller than file ranges -> bounds and total-sum warnings (no throw)
    const tinyVolResult = resolveVolSizes(resolved, offsets, 128);
    expect(tinyVolResult.warnings.some((w) => w.includes('exceeds VOL size'))).toBe(true);
    expect(tinyVolResult.warnings.some((w) => w.includes('Sum of file sizes'))).toBe(true);

    // Case 4: Out-of-range offsetIndex -> warning, no throw
    const badIndexResolved = resolved.map((entry) =>
      entry.path === 'd1/first.bin' ? { ...entry, offsetIndex: 99 } : entry,
    );
    const badIndexResult = resolveVolSizes(badIndexResolved, offsets, source.size);
    expect(badIndexResult.warnings.some((w) => w.includes('out-of-range offsetIndex=99'))).toBe(
      true,
    );
  });
});
