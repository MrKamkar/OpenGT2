import { describe, expect, it } from 'vitest';
import { BufferByteSource } from '../../src/io';
import { parseVolHeader } from '../../src/formats/vol/header';
import { parseVolOffsets } from '../../src/formats/vol/offsets';
import { type RawTocEntry, parseVolToc } from '../../src/formats/vol/toc';
import { buildVolTree } from '../../src/formats/vol/tree';
import { buildSyntheticVol, createThreeLevelFixture } from '../fixtures/buildVol';

describe('buildVolTree (M2.4)', () => {
  it('reconstructs a 3-level nested directory tree using exact first-encounter order', async () => {
    const fixture = createThreeLevelFixture();
    const header = await parseVolHeader(fixture.source);
    const offsets = await parseVolOffsets(fixture.source, header.files);
    const rawEntries = await parseVolToc(fixture.source, offsets, header.totalEntries);

    const resolved = buildVolTree(rawEntries);

    expect(
      resolved.map((entry) => ({
        path: entry.path,
        kind: entry.kind,
        unixTime: entry.unixTime,
      })),
    ).toEqual(
      fixture.expectedPaths.map((expected) => ({
        path: expected.path,
        kind: expected.kind,
        unixTime: expected.unixTime,
      })),
    );

    // Ensure no `..` entries or offsetIndex=0 entries ever leak into output.
    expect(resolved.some((entry) => entry.path.endsWith('..'))).toBe(false);
    expect(resolved.some((entry) => entry.offsetIndex === 0)).toBe(false);
  });

  it('switches directory when flag 0x80 appears on a `..` entry in an empty directory', async () => {
    const fixture = createThreeLevelFixture();
    const header = await parseVolHeader(fixture.source);
    const offsets = await parseVolOffsets(fixture.source, header.files);
    const rawEntries = await parseVolToc(fixture.source, offsets, header.totalEntries);

    const resolved = buildVolTree(rawEntries);
    const paths = resolved.map((e) => e.path);

    // `emptyDir` has only `..` with flag 0x81; if 0x80 were ignored on `..`,
    // `dirB/final.bin` would wrongly become `emptyDir/final.bin`.
    expect(paths).toContain('emptyDir');
    expect(paths).toContain('dirB/final.bin');
    expect(paths).not.toContain('emptyDir/final.bin');
  });

  it('inserts nested subdirectories before sibling top-level directories (`dirInsertIndex++`)', async () => {
    const built = buildSyntheticVol([
      {
        kind: 'dir',
        name: 'parent',
        children: [
          {
            kind: 'dir',
            name: 'childA',
            children: [
              {
                kind: 'dir',
                name: 'grandchild',
                children: [{ kind: 'file', name: 'gc.bin', data: new Uint8Array([1]) }],
              },
            ],
          },
          {
            kind: 'dir',
            name: 'childB',
            children: [{ kind: 'file', name: 'cb.bin', data: new Uint8Array([2]) }],
          },
        ],
      },
      {
        kind: 'dir',
        name: 'sibling',
        children: [{ kind: 'file', name: 'sib.bin', data: new Uint8Array([3]) }],
      },
    ]);
    const source = new BufferByteSource(built.bytes);
    const header = await parseVolHeader(source);
    const offsets = await parseVolOffsets(source, header.files);
    const rawEntries = await parseVolToc(source, offsets, header.totalEntries);

    const resolved = buildVolTree(rawEntries);
    expect(resolved.map((e) => e.path)).toEqual([
      'parent',
      'sibling',
      'parent/childA',
      'parent/childB',
      'parent/childA/grandchild',
      'parent/childA/grandchild/gc.bin',
      'parent/childB/cb.bin',
      'sibling/sib.bin',
    ]);
  });

  it('excludes `..` even if offsetIndex !== 0 and excludes any entry with offsetIndex === 0 while honoring 0x80', () => {
    const syntheticEntries: readonly RawTocEntry[] = [
      {
        unixTime: 100,
        offsetIndex: 1,
        flags: 0x81,
        isDirectory: true,
        isLastInDirectory: true,
        name: 'alpha',
      },
      {
        // Defensive: `..` with non-zero offsetIndex must still be excluded
        unixTime: 101,
        offsetIndex: 9,
        flags: 0x01,
        isDirectory: true,
        isLastInDirectory: false,
        name: '..',
      },
      {
        // Entry with offsetIndex === 0 and flag 0x80 must be excluded AND reset current dir
        unixTime: 102,
        offsetIndex: 0,
        flags: 0x80,
        isDirectory: false,
        isLastInDirectory: true,
        name: 'ignored.bin',
      },
      {
        unixTime: 103,
        offsetIndex: 2,
        flags: 0x80,
        isDirectory: false,
        isLastInDirectory: true,
        name: 'root_after.bin',
      },
    ];

    const resolved = buildVolTree(syntheticEntries);
    expect(resolved).toEqual([
      { path: 'alpha', kind: 'dir', offsetIndex: 1, unixTime: 100 },
      { path: 'root_after.bin', kind: 'file', offsetIndex: 2, unixTime: 103 },
    ]);
  });
});
