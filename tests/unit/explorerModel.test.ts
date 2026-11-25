import { describe, expect, it } from 'vitest';
import type { VolEntry } from '../../src/formats/vol';
import {
  ALL_FILES_SCOPE,
  ROOT_SCOPE,
  baseNameOf,
  buildExplorerIndex,
  flattenDirTree,
  isRootScope,
  parentDirOf,
  parentScopeOf,
  queryExplorer,
} from '../../src/ui/explorer/explorerModel';
import { createThreeLevelFixture } from '../fixtures/buildVol';

function makeEntry(
  path: string,
  kind: 'file' | 'dir',
  size = 0,
  unixTime = 945_000_000,
): VolEntry {
  return {
    path,
    kind,
    address: kind === 'dir' ? 0 : 0x800,
    size,
    unixTime,
    isGzip: false,
  };
}

describe('explorerModel (M2.8)', () => {
  it('builds a 3-level tree, synthesizes missing dirs, sorts dirs first, and counts files accurately', () => {
    const { expectedPaths } = createThreeLevelFixture();
    const volEntries: VolEntry[] = expectedPaths.map((e) => makeEntry(e.path, e.kind, e.size, e.unixTime));
    // Add a file inside an undeclared intermediate directory to verify synthesis.
    volEntries.push(makeEntry('orphan/nested/extra.bin', 'file', 42));

    const index = buildExplorerIndex(volEntries);

    expect(index.fileCount).toBe(8);
    expect(index.dirCount).toBe(6);

    const rootChildren = index.childrenByDir.get('') ?? [];
    expect(rootChildren.map((c) => `${c.entry.kind}:${c.name}`)).toEqual([
      'dir:dirA',
      'dir:dirB',
      'dir:emptyDir',
      'file:empty.bin',
      'file:readme.txt',
    ]);

    const dirAChildren = index.childrenByDir.get('dirA') ?? [];
    expect(dirAChildren.map((c) => `${c.entry.kind}:${c.name}`)).toEqual([
      'dir:sub1',
      'dir:sub2',
      'file:a_info.txt',
    ]);

    const flat = flattenDirTree(index.tree);
    expect(flat.map((n) => `${n.depth}:${n.path}:${n.directFileCount}/${n.totalFileCount}`)).toEqual([
      '0::2/8',
      '1:dirA:1/4',
      '2:dirA/sub1:1/2',
      '3:dirA/sub1/deep:1/1',
      '2:dirA/sub2:1/1',
      '1:dirB:1/1',
      '1:emptyDir:0/0',
      '1:orphan:0/1',
      '2:orphan/nested:1/1',
    ]);
  });

  it('queries ROOT_SCOPE, dir scopes, ALL_FILES_SCOPE, and scoped case-insensitive search', () => {
    const { expectedPaths } = createThreeLevelFixture();
    const volEntries: VolEntry[] = expectedPaths.map((e) => makeEntry(e.path, e.kind, e.size, e.unixTime));
    const index = buildExplorerIndex(volEntries);

    expect(queryExplorer(index, ROOT_SCOPE, '').map((e) => e.entry.path)).toEqual([
      'dirA',
      'dirB',
      'emptyDir',
      'empty.bin',
      'readme.txt',
    ]);

    expect(queryExplorer(index, { kind: 'dir', path: 'dirA/sub1' }, '').map((e) => e.entry.path)).toEqual([
      'dirA/sub1/deep',
      'dirA/sub1/sub1.bin',
    ]);

    expect(queryExplorer(index, { kind: 'dir', path: 'missing' }, '')).toEqual([]);

    expect(queryExplorer(index, ALL_FILES_SCOPE, '').map((e) => e.entry.path)).toEqual([
      'dirA/a_info.txt',
      'dirA/sub1/deep/deep.dat',
      'dirA/sub1/sub1.bin',
      'dirA/sub2/sub2.dat',
      'dirB/final.bin',
      'empty.bin',
      'readme.txt',
    ]);

    // Case-insensitive substring search with whitespace trimming across all entries.
    expect(queryExplorer(index, ALL_FILES_SCOPE, '  DEEP  ').map((e) => e.entry.path)).toEqual([
      'dirA/sub1/deep',
      'dirA/sub1/deep/deep.dat',
    ]);

    // Scoped search checks relative path under scope prefix (so searching "dirA" inside dirA does not match every child).
    expect(queryExplorer(index, { kind: 'dir', path: 'dirA' }, 'dira')).toEqual([]);
    expect(queryExplorer(index, { kind: 'dir', path: 'dirA' }, 'SUB').map((e) => e.entry.path)).toEqual([
      'dirA/sub1',
      'dirA/sub1/deep',
      'dirA/sub1/deep/deep.dat',
      'dirA/sub1/sub1.bin',
      'dirA/sub2',
      'dirA/sub2/sub2.dat',
    ]);
  });

  it('indexes and searches 12,000 entries cleanly', () => {
    const entries: VolEntry[] = [
      makeEntry('cars', 'dir'),
      makeEntry('tracks', 'dir'),
      makeEntry('menus', 'dir'),
    ];
    for (let i = 0; i < 12_000; i += 1) {
      const folder = i % 3 === 0 ? 'cars' : i % 3 === 1 ? 'tracks' : 'menus';
      const suffix = i === 10_499 ? 'needle_target.cdo' : `item_${String(i).padStart(5, '0')}.dat`;
      entries.push(makeEntry(`${folder}/${suffix}`, 'file', i));
    }

    const index = buildExplorerIndex(entries);
    expect(index.fileCount).toBe(12_000);
    expect(index.dirCount).toBe(3);

    const allFiles = queryExplorer(index, ALL_FILES_SCOPE, '');
    expect(allFiles.length).toBe(12_000);

    const hits = queryExplorer(index, ALL_FILES_SCOPE, 'NEEDLE_TARGET');
    expect(hits.map((h) => h.entry.path)).toEqual(['menus/needle_target.cdo']);

    const wrongScope = queryExplorer(index, { kind: 'dir', path: 'cars' }, 'needle_target');
    expect(wrongScope).toEqual([]);
  });

  it('computes parent paths and scope navigation helpers', () => {
    expect(parentDirOf('a/b/c.txt')).toBe('a/b');
    expect(parentDirOf('root.txt')).toBe('');
    expect(baseNameOf('a/b/c.txt')).toBe('c.txt');
    expect(baseNameOf('root.txt')).toBe('root.txt');

    expect(isRootScope(ROOT_SCOPE)).toBe(true);
    expect(isRootScope(ALL_FILES_SCOPE)).toBe(false);
    expect(isRootScope({ kind: 'dir', path: 'dirA' })).toBe(false);

    expect(parentScopeOf(ALL_FILES_SCOPE)).toEqual(ROOT_SCOPE);
    expect(parentScopeOf(ROOT_SCOPE)).toEqual(ROOT_SCOPE);
    expect(parentScopeOf({ kind: 'dir', path: 'dirA' })).toEqual(ROOT_SCOPE);
    expect(parentScopeOf({ kind: 'dir', path: 'dirA/sub1' })).toEqual({ kind: 'dir', path: 'dirA' });
  });
});
