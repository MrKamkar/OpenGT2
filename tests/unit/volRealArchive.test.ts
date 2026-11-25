import { existsSync } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync as zlibGunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gunzip, GzipError, isGzipMagic } from '../../src/formats/gzip';
import {
  parseVolHeader,
  parseVolOffsets,
  parseVolToc,
  splitOffset,
  VolReader,
} from '../../src/formats/vol';
import {
  type ByteSource,
  CachedByteSource,
  SlicedByteSource,
  validateByteRange,
} from '../../src/io';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_VOL_PATH = path.resolve(PROJECT_ROOT, 'local_assets', 'GT2.VOL');
const HAS_REAL_VOL = existsSync(REAL_VOL_PATH);

/**
 * Streaming random-access `ByteSource` backed by a Node `FileHandle`.
 * Never loads the entire archive into RAM (Rule 6 / §1.3).
 */
class NodeFileByteSource implements ByteSource {
  readonly size: number;
  private readonly handle: FileHandle;

  constructor(handle: FileHandle, size: number) {
    this.handle = handle;
    this.size = size;
  }

  async read(start: number, end: number): Promise<Uint8Array> {
    validateByteRange(start, end, this.size);
    const length = end - start;
    if (length === 0) {
      return new Uint8Array(0);
    }

    const out = new Uint8Array(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await this.handle.read(out, offset, length - offset, start + offset);
      if (bytesRead === 0) {
        throw new RangeError(
          `Unexpected EOF while reading [${String(start)}, ${String(end)}) at offset ${String(start + offset)}`,
        );
      }
      offset += bytesRead;
    }
    return out;
  }

  slice(start: number, end: number): ByteSource {
    validateByteRange(start, end, this.size);
    return new SlicedByteSource(this, start, end);
  }
}

function isZeroPaddedNextGzipMember(
  bytes: Uint8Array,
  memberEnd: number,
  alignment: number,
): boolean {
  const remainder = memberEnd % alignment;
  const boundary = remainder === 0 ? memberEnd : memberEnd + (alignment - remainder);
  if (boundary + 2 > bytes.byteLength) {
    return false;
  }
  for (let i = memberEnd; i < boundary; i += 1) {
    if (bytes[i] !== 0) {
      return false;
    }
  }
  return isGzipMagic(bytes.subarray(boundary, boundary + 2));
}

describe.skipIf(!HAS_REAL_VOL)('Real local_assets/GT2.VOL verification (M2.10)', () => {
  let fileHandle: FileHandle;
  let cachedSource: CachedByteSource;
  let reader: VolReader;
  let archiveSize = 0;
  let lastModified = 0;

  beforeAll(async () => {
    fileHandle = await open(REAL_VOL_PATH, 'r');
    const fileStats = await fileHandle.stat();
    archiveSize = fileStats.size;
    lastModified = fileStats.mtimeMs;

    const rawSource = new NodeFileByteSource(fileHandle, archiveSize);
    cachedSource = new CachedByteSource(rawSource);
    reader = new VolReader();
    await reader.open(cachedSource, { lastModified });
  });

  afterAll(async () => {
    reader?.close();
    if (fileHandle !== undefined) {
      await fileHandle.close();
    }
  });

  it('opens real GT2.VOL cleanly with explicit EOF offset slot and zero consistency warnings', async () => {
    const info = reader.getInfo();
    expect(info).not.toBeNull();
    if (info === null) {
      return;
    }

    expect(info.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(info.fileCount).toBeGreaterThan(2);
    expect(info.entryCount).toBeGreaterThan(info.fileCount);
    expect(info.warnings).toEqual([]);

    const offsets = await parseVolOffsets(cachedSource, info.fileCount);
    const trailingSentinelRaw = offsets[info.fileCount - 1];
    expect(trailingSentinelRaw).toBeDefined();
    if (trailingSentinelRaw !== undefined) {
      const sentinel = splitOffset(trailingSentinelRaw);
      expect(sentinel.address).toBe(archiveSize);
      expect(sentinel.tail).toBe(0);
    }

    const entries = reader.getAllEntries();
    const fileEntries = entries.filter((entry) => entry.kind === 'file');
    const dirEntries = entries.filter((entry) => entry.kind === 'dir');
    // Offset slots: [0] table, [1] TOC, [2..files-2] files, [files-1] explicit EOF sentinel.
    expect(fileEntries.length).toBe(info.fileCount - 3);
    expect(dirEntries.length).toBeGreaterThan(0);

    // Confirm streaming read never loaded the entire archive into cache.
    const cacheStats = cachedSource.getStats();
    expect(cacheStats.bytesReadFromSource).toBeLessThan(archiveSize);
  });

  it('verifies open structural questions (E0/E1) on real GT2.VOL without exposing game data', async () => {
    const header = await parseVolHeader(cachedSource);
    const offsets = await parseVolOffsets(cachedSource, header.files);
    const rawToc = await parseVolToc(cachedSource, offsets, header.totalEntries);

    let parentRefCount = 0;
    let regularDirCount = 0;
    let regularDirZeroOffsetCount = 0;
    let regularDirNonZeroOffsetCount = 0;
    let regularDirIndexExceedsFilesCount = 0;
    let unknownFlagEntries = 0;

    for (const raw of rawToc) {
      if ((raw.flags & 0x7e) !== 0) {
        unknownFlagEntries += 1;
      }

      if (raw.name === '..') {
        parentRefCount += 1;
        continue;
      }

      if (raw.isDirectory) {
        regularDirCount += 1;
        if (raw.offsetIndex === 0) {
          regularDirZeroOffsetCount += 1;
        } else {
          regularDirNonZeroOffsetCount += 1;
        }
        if (raw.offsetIndex >= header.files) {
          regularDirIndexExceedsFilesCount += 1;
        }
      }
    }

    // Verify 0-byte file offset encoding on real archive entries.
    const allFiles = reader.getAllEntries().filter((entry) => entry.kind === 'file');
    const zeroByteFiles = allFiles.filter((entry) => entry.size === 0);
    let zeroByteMatchesNextAddressZeroTail = 0;
    for (const tocEntry of rawToc) {
      if (tocEntry.isDirectory || tocEntry.offsetIndex < 2) {
        continue;
      }
      const rawOff = offsets[tocEntry.offsetIndex];
      const nextRawOff = offsets[tocEntry.offsetIndex + 1];
      if (rawOff === undefined || nextRawOff === undefined) {
        continue;
      }
      const { address, tail } = splitOffset(rawOff);
      const nextSplit = splitOffset(nextRawOff);
      if (nextSplit.address === address && tail === 0) {
        zeroByteMatchesNextAddressZeroTail += 1;
      }
    }

    expect(header.unk_0x0C).toBe(0);
    expect(unknownFlagEntries).toBe(0);
    expect(parentRefCount).toBe(regularDirCount);
    expect(regularDirZeroOffsetCount).toBe(0);
    expect(regularDirNonZeroOffsetCount).toBe(regularDirCount);
    expect(regularDirIndexExceedsFilesCount).toBeGreaterThan(0);
    expect(zeroByteMatchesNextAddressZeroTail).toBe(zeroByteFiles.length);
  });

  it(
    'decompresses all .gz and standalone gzip files and verifies multi-member containers',
    async () => {
      const fileEntries = reader.getAllEntries().filter((entry) => entry.kind === 'file');

      let gzExtCount = 0;
      let gzExtWithoutMagicCount = 0;
      let standaloneNonGzCount = 0;
      let multiMemberContainerCount = 0;

      for (const entry of fileEntries) {
        const stat = await reader.stat(entry.path);
        expect(stat).toBeDefined();
        const hasMagic = stat?.isGzip === true;
        const hasGzExt = entry.path.toLowerCase().endsWith('.gz');

        if (hasGzExt) {
          gzExtCount += 1;
          if (!hasMagic) {
            gzExtWithoutMagicCount += 1;
          }
        }

        if (!hasMagic) {
          continue;
        }

        const rawBytes = await reader.read(entry.path);
        expect(isGzipMagic(rawBytes)).toBe(true);

        if (hasGzExt) {
          const nativeOut = await gunzip(rawBytes, { backend: 'native' });
          const fflateOut = await gunzip(rawBytes, { backend: 'fflate' });
          expect(fflateOut.byteLength).toBe(nativeOut.byteLength);
          continue;
        }

        // Non-.gz files starting with 1F 8B are either standalone gzip streams or multi-member padded containers.
        try {
          const nativeOut = await gunzip(rawBytes, { backend: 'native' });
          const fflateOut = await gunzip(rawBytes, { backend: 'fflate' });
          expect(fflateOut.byteLength).toBe(nativeOut.byteLength);
          standaloneNonGzCount += 1;
        } catch (error) {
          expect(error).toBeInstanceOf(GzipError);
          expect((error as GzipError).code).toBe(GzipError.CorruptStream);
          expect((error as Error).message).toMatch(/trailing junk/i);

          // Confirm the first member is a valid CRC-checked gzip stream followed by zero-padded next 1F 8B member.
          const firstMember = zlibGunzipSync(rawBytes, { info: true });
          const memberEnd = firstMember.engine.bytesWritten;
          expect(memberEnd).toBeGreaterThan(0);
          expect(memberEnd).toBeLessThan(rawBytes.byteLength);
          const hasAlignedNextMember =
            isZeroPaddedNextGzipMember(rawBytes, memberEnd, 4) ||
            isZeroPaddedNextGzipMember(rawBytes, memberEnd, 2048);
          expect(hasAlignedNextMember).toBe(true);

          multiMemberContainerCount += 1;
        }
      }

      expect(gzExtCount).toBe(5114);
      expect(gzExtWithoutMagicCount).toBe(0);
      expect(standaloneNonGzCount).toBe(84);
      expect(multiMemberContainerCount).toBe(7);
    },
    180_000,
  );
});
