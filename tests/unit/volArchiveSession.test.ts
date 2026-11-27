import { describe, expect, it, vi } from 'vitest';
import {
  describeVolOpenError,
  errorMessageOf,
  isAbortLikeError,
  loadAllVolEntries,
} from '../../src/app/volArchiveSession';
import { VolError, type VolEntry } from '../../src/formats/vol';

function dirEntry(path: string): VolEntry {
  return { path, kind: 'dir', address: 0, size: 0, unixTime: 0, isGzip: false };
}

function fileEntry(path: string, size = 16): VolEntry {
  return { path, kind: 'file', address: 0x800, size, unixTime: 0, isGzip: false };
}

describe('volArchiveSession (M2.8)', () => {
  it('collects all entries breadth-first with one list() call per directory', async () => {
    const tree = new Map<string, readonly VolEntry[]>([
      ['', [fileEntry('root.txt'), dirEntry('dirA'), dirEntry('emptyDir')]],
      ['dirA', [fileEntry('dirA/a.bin'), dirEntry('dirA/sub')]],
      ['emptyDir', []],
      ['dirA/sub', [fileEntry('dirA/sub/deep.dat')]],
    ]);

    const listSpy = vi.fn(async (dir: string) => tree.get(dir) ?? []);
    const entries = await loadAllVolEntries(listSpy);

    expect(entries.map((e) => e.path)).toEqual([
      'root.txt',
      'dirA',
      'emptyDir',
      'dirA/a.bin',
      'dirA/sub',
      'dirA/sub/deep.dat',
    ]);
    expect(listSpy.mock.calls.map((c) => c[0])).toEqual(['', 'dirA', 'emptyDir', 'dirA/sub']);
  });

  it('handles an empty root and duplicate directory entries without looping', async () => {
    const listSpy = vi.fn(async (dir: string) => {
      if (dir === '') {
        return [dirEntry('dup'), dirEntry('dup')];
      }
      return [fileEntry('dup/one.bin')];
    });
    const entries = await loadAllVolEntries(listSpy);
    expect(entries.map((e) => e.path)).toEqual(['dup', 'dup', 'dup/one.bin']);
    expect(listSpy).toHaveBeenCalledTimes(2);
  });

  it('maps VolError, RpcWorkerError, and generic errors to clear English UI messages', () => {
    expect(describeVolOpenError(new VolError(VolError.BadMagic, 'bad magic'))).toContain('GTFS');
    expect(describeVolOpenError(new VolError(VolError.TruncatedHeader, 'short'))).toContain(
      'truncated header',
    );
    expect(describeVolOpenError(new VolError(VolError.InvalidTocBounds, 'toc overflow'))).toContain('toc overflow');
    expect(
      describeVolOpenError(Object.assign(new Error('worker crashed'), { name: 'RpcWorkerError' })),
    ).toContain('worker crashed');
    expect(describeVolOpenError(new Error('unexpected'))).toContain('unexpected');
    expect(describeVolOpenError('plain failure')).toContain('plain failure');
  });

  it('detects abort-like errors and extracts messages safely', () => {
    expect(isAbortLikeError(Object.assign(new Error('cancelled'), { name: 'AbortError' }))).toBe(true);
    expect(isAbortLikeError(new Error('other'))).toBe(false);
    expect(isAbortLikeError(null)).toBe(false);
    expect(errorMessageOf(new Error('msg'))).toBe('msg');
    expect(errorMessageOf('raw')).toBe('raw');
    expect(errorMessageOf(42)).toBe('42');
  });
});
