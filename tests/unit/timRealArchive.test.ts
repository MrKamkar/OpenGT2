import { existsSync } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync as zlibGunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { extractMultiMemberGzip, isGzipMagic } from '../../src/formats/gzip';
import { decodeTimToRgba, isTimMagic, parseTim, timToIndexedImage } from '../../src/formats/tim';
import { VolReader } from '../../src/formats/vol';
import {
  type ByteSource,
  CachedByteSource,
  SlicedByteSource,
  validateByteRange,
} from '../../src/io';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const REAL_VOL_PATH = path.resolve(PROJECT_ROOT, 'local_assets', 'GT2.VOL');
const HAS_REAL_VOL = existsSync(REAL_VOL_PATH);

const MULTI_MEMBER_WINDOW_BYTES = 1024 * 1024;
const MAX_PADDING_SCAN_BYTES = 4096;
const MAX_MULTI_MEMBERS = 128;

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

function getNormalizedExtension(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  const base = slash >= 0 ? filePath.slice(slash + 1) : filePath;
  const dot = base.lastIndexOf('.');
  return dot > 0 && dot < base.length - 1 ? base.slice(dot).toLowerCase() : '(none)';
}

function stripGzExt(filePath: string): string {
  return filePath.toLowerCase().endsWith('.gz') ? filePath.slice(0, -3) : filePath;
}

describe.skipIf(!HAS_REAL_VOL)('Real GT2.VOL TIM parser verification (M4.3)', () => {
  let fileHandle: FileHandle;
  let rawSource: NodeFileByteSource;
  let cachedSource: CachedByteSource;
  let reader: VolReader;
  let archiveSize = 0;

  beforeAll(async () => {
    fileHandle = await open(REAL_VOL_PATH, 'r');
    const fileStats = await fileHandle.stat();
    archiveSize = fileStats.size;
    rawSource = new NodeFileByteSource(fileHandle, archiveSize);
    cachedSource = new CachedByteSource(rawSource);
    reader = new VolReader();
    await reader.open(cachedSource, { lastModified: fileStats.mtimeMs });
  });

  afterAll(async () => {
    reader?.close();
    if (fileHandle !== undefined) {
      await fileHandle.close();
    }
  });

  it(
    'parses and decodes all 3,729 TIM images via streaming reads (raw, .tim.gz, and 16 bpp multi-gzip)',
    async () => {
      const fileEntries = reader.getAllEntries().filter((entry) => entry.kind === 'file');

      let rawTimParsed = 0;
      let rawTim4BppClut = 0;
      let rawTim4BppNoClut = 0;
      let rawTimWarnings = 0;

      let gzTimParsed = 0;
      let gzTim4BppClut = 0;
      let gzTim8BppClut = 0;
      let gzTim4BppNoClut = 0;
      let gzTimStrictCount = 0;
      let gzTimDoubleBnumWarnings = 0;

      let multiTimParsed = 0;
      let multiTim16Bpp = 0;
      let multiTimWarnings = 0;

      for (const entry of fileEntries) {
        if (entry.size === 0) {
          continue;
        }

        const outerExt = getNormalizedExtension(entry.path);
        const innerExt =
          outerExt === '.gz' ? getNormalizedExtension(stripGzExt(entry.path)) : outerExt;

        if (outerExt === '.tim') {
          const buf = await rawSource.read(entry.address, entry.address + entry.size);
          expect(isTimMagic(buf)).toBe(true);
          const tim = parseTim(buf);
          rawTimParsed += 1;
          rawTimWarnings += tim.warnings.length;

          if (tim.bpp === 4 && tim.hasClut) {
            rawTim4BppClut += 1;
          } else if (tim.bpp === 4 && !tim.hasClut) {
            rawTim4BppNoClut += 1;
          }

          const indexed = timToIndexedImage(tim);
          expect(indexed.indices.byteLength).toBe(tim.width * tim.height);
          const rgba = decodeTimToRgba(tim, 0, { transparencyMode: 'transparent-zero' });
          expect(rgba.rgba.byteLength).toBe(tim.width * tim.height * 4);
          continue;
        }

        if (outerExt === '.gz' && innerExt === '.tim') {
          const compressed = await rawSource.read(entry.address, entry.address + entry.size);
          expect(isGzipMagic(compressed)).toBe(true);
          const gunzipped = zlibGunzipSync(compressed, { info: true });
          expect(gunzipped.engine.bytesWritten).toBe(compressed.byteLength);
          const payload = gunzipped.buffer;
          expect(isTimMagic(payload)).toBe(true);

          const tim = parseTim(payload);
          gzTimParsed += 1;
          if (tim.warnings.length === 0) {
            gzTimStrictCount += 1;
          } else {
            expect(tim.warnings.length).toBe(1);
            expect(tim.warnings[0]).toContain('bnum');
            gzTimDoubleBnumWarnings += 1;
          }

          if (tim.bpp === 4 && tim.hasClut) {
            gzTim4BppClut += 1;
          } else if (tim.bpp === 8 && tim.hasClut) {
            gzTim8BppClut += 1;
          } else if (tim.bpp === 4 && !tim.hasClut) {
            gzTim4BppNoClut += 1;
          }

          const indexed = timToIndexedImage(tim);
          expect(indexed.indices.byteLength).toBe(tim.width * tim.height);
          const rgba = decodeTimToRgba(tim, 0, { transparencyMode: 'transparent-zero' });
          expect(rgba.rgba.byteLength).toBe(tim.width * tim.height * 4);
          continue;
        }

        if (outerExt === '(none)' && entry.size >= 18 && entry.size <= 512 * 1024) {
          const head = await cachedSource.read(entry.address, entry.address + 8);
          if (!isGzipMagic(head)) {
            continue;
          }

          const compressed = await rawSource.read(entry.address, entry.address + entry.size);
          const firstMember = zlibGunzipSync(compressed, { info: true });
          if (firstMember.engine.bytesWritten === compressed.byteLength) {
            continue;
          }

          if (!isTimMagic(firstMember.buffer)) {
            continue;
          }

          let fileOffset = 0;
          let membersInContainer = 0;
          while (fileOffset + 18 <= compressed.byteLength && membersInContainer < MAX_MULTI_MEMBERS) {
            const slice = compressed.subarray(
              fileOffset,
              Math.min(compressed.byteLength, fileOffset + MULTI_MEMBER_WINDOW_BYTES),
            );
            if (!isGzipMagic(slice)) {
              let skip = 0;
              while (
                skip < slice.byteLength &&
                slice[skip] === 0 &&
                skip < MAX_PADDING_SCAN_BYTES
              ) {
                skip += 1;
              }
              if (fileOffset + skip >= compressed.byteLength) {
                break;
              }
              fileOffset += skip;
              continue;
            }

            const memberRes = zlibGunzipSync(slice, { info: true });
            const tim = parseTim(memberRes.buffer);
            multiTimParsed += 1;
            multiTimWarnings += tim.warnings.length;
            if (tim.bpp === 16 && !tim.hasClut) {
              multiTim16Bpp += 1;
            }
            const rgba = decodeTimToRgba(tim, 0, { transparencyMode: 'stp-semi-transparent' });
            expect(rgba.rgba.byteLength).toBe(tim.width * tim.height * 4);

            membersInContainer += 1;
            fileOffset += memberRes.engine.bytesWritten;
          }

          const browserMembers = extractMultiMemberGzip(compressed, { alignment: 2048 });
          expect(browserMembers).toHaveLength(membersInContainer);
          for (const member of browserMembers) {
            const tim = parseTim(member.data);
            expect(tim.bpp).toBe(16);
          }
        }
      }

      expect(rawTimParsed).toBe(3_576);
      expect(rawTim4BppClut).toBe(3_539);
      expect(rawTim4BppNoClut).toBe(37);
      expect(rawTimWarnings).toBe(0);

      expect(gzTimParsed).toBe(129);
      expect(gzTim4BppClut).toBe(120);
      expect(gzTim8BppClut).toBe(7);
      expect(gzTim4BppNoClut).toBe(2);
      expect(gzTimStrictCount).toBe(95);
      expect(gzTimDoubleBnumWarnings).toBe(34);

      expect(multiTimParsed).toBe(24);
      expect(multiTim16Bpp).toBe(24);
      expect(multiTimWarnings).toBe(0);

      expect(rawTimParsed + gzTimParsed + multiTimParsed).toBe(3_729);
      expect(cachedSource.getStats().bytesReadFromSource).toBeLessThan(archiveSize);
    },
    180_000,
  );
});
