import { existsSync } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync as zlibGunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isGzipMagic } from '../../src/formats/gzip';
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

const TIM_MAGIC_LE = 0x00000010;
const TIM_ALLOWED_FLAGS_MASK = 0x0000000b;
const TIM_BLOCK_HEADER_BYTES = 12;
const CDP_HEADER_AND_PALETTES_BYTES = 0x43a0;
const CDP_BITMAP_BYTES = 0x7000;
const CDP_EXPECTED_SIZE = CDP_HEADER_AND_PALETTES_BYTES + CDP_BITMAP_BYTES;
const CDO_MAX_SIZE = 0x5000;

const SINGLE_STREAM_GZIP_MAX_COMPRESSED_BYTES = 4 * 1024 * 1024;
const MULTI_MEMBER_WINDOW_BYTES = 1024 * 1024;
const MULTI_MEMBER_LARGE_WINDOW_BYTES = 8 * 1024 * 1024;
const MAX_PADDING_SCAN_BYTES = 4096;
const MAX_MULTI_MEMBERS = 20_000;

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

type TimValidationKind =
  | 'valid-strict'
  | 'valid-quirk-double-bnum'
  | 'valid-with-tail'
  | 'false-positive';

interface TimValidationResult {
  readonly kind: TimValidationKind;
  readonly pmode: number;
  readonly hasClut: boolean;
}

function validateTimBuffer(buf: Uint8Array): TimValidationResult {
  if (buf.byteLength < 20) {
    return { kind: 'false-positive', pmode: -1, hasClut: false };
  }

  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== TIM_MAGIC_LE) {
    return { kind: 'false-positive', pmode: -1, hasClut: false };
  }

  const flags = dv.getUint32(4, true);
  if ((flags & ~TIM_ALLOWED_FLAGS_MASK) !== 0) {
    return { kind: 'false-positive', pmode: -1, hasClut: false };
  }

  const pmode = flags & 0x03;
  const hasClut = (flags & 0x08) !== 0;
  let offset = 8;

  if (hasClut) {
    if (offset + TIM_BLOCK_HEADER_BYTES > buf.byteLength) {
      return { kind: 'false-positive', pmode, hasClut };
    }
    const clutBnum = dv.getUint32(offset, true);
    const clutW = dv.getUint16(offset + 8, true);
    const clutH = dv.getUint16(offset + 10, true);
    const expectedClutBnum = TIM_BLOCK_HEADER_BYTES + clutW * clutH * 2;
    if (
      clutW === 0 ||
      clutH === 0 ||
      clutBnum !== expectedClutBnum ||
      offset + clutBnum > buf.byteLength
    ) {
      return { kind: 'false-positive', pmode, hasClut };
    }
    offset += clutBnum;
  }

  if (offset + TIM_BLOCK_HEADER_BYTES > buf.byteLength) {
    return { kind: 'false-positive', pmode, hasClut };
  }
  const imgBnum = dv.getUint32(offset, true);
  const imgW = dv.getUint16(offset + 8, true);
  const imgH = dv.getUint16(offset + 10, true);
  if (imgW === 0 || imgH === 0) {
    return { kind: 'false-positive', pmode, hasClut };
  }

  const pixelWordBytes = imgW * imgH * 2;
  const expectedImgBnum = TIM_BLOCK_HEADER_BYTES + pixelWordBytes;
  if (offset + expectedImgBnum > buf.byteLength) {
    return { kind: 'false-positive', pmode, hasClut };
  }

  if (imgBnum === expectedImgBnum) {
    return {
      kind: offset + imgBnum === buf.byteLength ? 'valid-strict' : 'valid-with-tail',
      pmode,
      hasClut,
    };
  }

  const doublePixelImgBnum = TIM_BLOCK_HEADER_BYTES + pixelWordBytes * 2;
  if (imgBnum === doublePixelImgBnum && offset + expectedImgBnum === buf.byteLength) {
    return { kind: 'valid-quirk-double-bnum', pmode, hasClut };
  }

  return { kind: 'false-positive', pmode, hasClut };
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

function hasMagic4(buf: Uint8Array, b0: number, b1: number, b2: number, b3: number): boolean {
  return (
    buf.byteLength >= 4 &&
    buf[0] === b0 &&
    buf[1] === b1 &&
    buf[2] === b2 &&
    buf[3] === b3
  );
}

function hasMagic3(buf: Uint8Array, b0: number, b1: number, b2: number): boolean {
  return buf.byteLength >= 3 && buf[0] === b0 && buf[1] === b1 && buf[2] === b2;
}

function incrementMap(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

describe.skipIf(!HAS_REAL_VOL)('Real GT2.VOL image format inventory (M4.1)', () => {
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
    'inventories image formats and file families via streaming reads without loading VOL into RAM',
    async () => {
      const fileEntries = reader.getAllEntries().filter((entry) => entry.kind === 'file');

      let totalFiles = 0;
      let zeroByteFiles = 0;

      let rawTimFiles = 0;
      let rawTimValidStrict = 0;
      const rawTimPmodes = new Map<string, number>();

      let gzTimFiles = 0;
      let gzTimValidStrict = 0;
      let gzTimQuirkDoubleBnum = 0;
      const gzTimPmodes = new Map<string, number>();

      let timMagicCandidates = 0;
      let totalTimFalsePositives = 0;

      let multiTimContainers = 0;
      let multiTimMembers = 0;
      let multiTimValidStrict = 0;
      let multiTimBpp2Count = 0;

      let multiGmContainers = 0;
      let multiGmMembers = 0;
      let multiGmMagicCount = 0;
      let multiGmTimMembers = 0;

      let rawGtmpDatFiles = 0;
      let rawGtmpDatSize = 0;

      let cdpCnpFiles = 0;
      let cdpCnpExactSizeCount = 0;

      let cdoCnoFiles = 0;
      let cdoCnoMagicCount = 0;
      let cdoCnoWithinLimitCount = 0;

      let trpGzCount = 0;
      let trpSecondU32Is16 = 0;
      let bspGzCount = 0;
      let bspSecondU32Is16 = 0;

      let lgfGzCount = 0;
      let lgfGzMagic00000201 = 0;
      let lgfGzFixedSizeCount = 0;
      let standaloneExtensionless00000201 = 0;

      for (const entry of fileEntries) {
        totalFiles += 1;
        if (entry.size === 0) {
          zeroByteFiles += 1;
          continue;
        }

        const outerExt = getNormalizedExtension(entry.path);
        const innerExt = outerExt === '.gz' ? getNormalizedExtension(stripGzExt(entry.path)) : outerExt;

        const head = await cachedSource.read(
          entry.address,
          entry.address + Math.min(64, entry.size),
        );

        if (!isGzipMagic(head)) {
          if (hasMagic4(head, 0x47, 0x54, 0x4d, 0x50) && outerExt === '.dat') {
            rawGtmpDatFiles += 1;
            rawGtmpDatSize = entry.size;
          }

          if (hasMagic4(head, 0x10, 0x00, 0x00, 0x00)) {
            timMagicCandidates += 1;
            const full = await rawSource.read(entry.address, entry.address + entry.size);
            const tim = validateTimBuffer(full);
            if (tim.kind === 'false-positive') {
              totalTimFalsePositives += 1;
            } else {
              if (outerExt === '.tim') {
                rawTimFiles += 1;
                if (tim.kind === 'valid-strict') {
                  rawTimValidStrict += 1;
                }
                incrementMap(rawTimPmodes, `bpp${String(tim.pmode)}${tim.hasClut ? '+clut' : ''}`);
              }
            }
          }
          continue;
        }

        let handledAsSingleStream = false;
        if (entry.size <= SINGLE_STREAM_GZIP_MAX_COMPRESSED_BYTES) {
          const compressed = await rawSource.read(entry.address, entry.address + entry.size);
          const gunzipped = zlibGunzipSync(compressed, { info: true });

          if (gunzipped.engine.bytesWritten === compressed.byteLength) {
            handledAsSingleStream = true;
            const payload = gunzipped.buffer;

            if (outerExt === '.gz' && (innerExt === '.cdp' || innerExt === '.cnp')) {
              cdpCnpFiles += 1;
              if (payload.byteLength === CDP_EXPECTED_SIZE) {
                cdpCnpExactSizeCount += 1;
              }
            } else if (outerExt === '.gz' && (innerExt === '.cdo' || innerExt === '.cno')) {
              cdoCnoFiles += 1;
              if (hasMagic3(payload, 0x47, 0x54, 0x02)) {
                cdoCnoMagicCount += 1;
              }
              if (payload.byteLength <= CDO_MAX_SIZE) {
                cdoCnoWithinLimitCount += 1;
              }
            } else if (outerExt === '.gz' && innerExt === '.trp') {
              trpGzCount += 1;
              if (
                payload.byteLength >= 8 &&
                new DataView(payload.buffer, payload.byteOffset, 8).getUint32(4, true) === 0x10
              ) {
                trpSecondU32Is16 += 1;
              }
            } else if (outerExt === '.gz' && innerExt === '.bsp') {
              bspGzCount += 1;
              if (
                payload.byteLength >= 8 &&
                new DataView(payload.buffer, payload.byteOffset, 8).getUint32(4, true) === 0x10
              ) {
                bspSecondU32Is16 += 1;
              }
            } else if (outerExt === '.gz' && innerExt === '.lgf') {
              lgfGzCount += 1;
              if (hasMagic4(payload, 0x00, 0x00, 0x02, 0x01)) {
                lgfGzMagic00000201 += 1;
              }
              if (payload.byteLength === 36_956) {
                lgfGzFixedSizeCount += 1;
              }
            } else if (outerExt === '(none)' && hasMagic4(payload, 0x00, 0x00, 0x02, 0x01)) {
              standaloneExtensionless00000201 += 1;
            }

            if (hasMagic4(payload, 0x10, 0x00, 0x00, 0x00)) {
              timMagicCandidates += 1;
              const tim = validateTimBuffer(payload);
              if (tim.kind === 'false-positive') {
                totalTimFalsePositives += 1;
              } else if (outerExt === '.gz' && innerExt === '.tim') {
                gzTimFiles += 1;
                if (tim.kind === 'valid-strict') {
                  gzTimValidStrict += 1;
                } else if (tim.kind === 'valid-quirk-double-bnum') {
                  gzTimQuirkDoubleBnum += 1;
                }
                incrementMap(gzTimPmodes, `bpp${String(tim.pmode)}${tim.hasClut ? '+clut' : ''}`);
              }
            }
          }
        }

        if (handledAsSingleStream) {
          continue;
        }

        // Stream multi-member gzip containers window-by-window directly from NodeFileByteSource.
        let fileOffset = 0;
        let membersInContainer = 0;
        let timMembersInContainer = 0;
        let validTimMembersInContainer = 0;
        let timBpp2InContainer = 0;
        let gmMembersInContainer = 0;

        while (fileOffset + 18 <= entry.size && membersInContainer < MAX_MULTI_MEMBERS) {
          const winEnd = Math.min(entry.size, fileOffset + MULTI_MEMBER_WINDOW_BYTES);
          const windowBuf = await rawSource.read(entry.address + fileOffset, entry.address + winEnd);

          if (!isGzipMagic(windowBuf)) {
            let skip = 0;
            while (
              skip < windowBuf.byteLength &&
              windowBuf[skip] === 0 &&
              skip < MAX_PADDING_SCAN_BYTES
            ) {
              skip += 1;
            }
            if (fileOffset + skip >= entry.size) {
              break;
            }
            expect(skip).toBeLessThan(MAX_PADDING_SCAN_BYTES);
            expect(isGzipMagic(windowBuf.subarray(skip, skip + 2))).toBe(true);
            fileOffset += skip;
            continue;
          }

          let memberRes: ReturnType<typeof zlibGunzipSync>;
          try {
            memberRes = zlibGunzipSync(windowBuf, { info: true });
          } catch {
            const largeEnd = Math.min(entry.size, fileOffset + MULTI_MEMBER_LARGE_WINDOW_BYTES);
            const largeWindow = await rawSource.read(
              entry.address + fileOffset,
              entry.address + largeEnd,
            );
            memberRes = zlibGunzipSync(largeWindow, { info: true });
          }

          const memberPayload = memberRes.buffer;
          membersInContainer += 1;

          if (hasMagic4(memberPayload, 0x47, 0x4d, 0x03, 0x00)) {
            gmMembersInContainer += 1;
          }
          if (hasMagic4(memberPayload, 0x10, 0x00, 0x00, 0x00)) {
            timMagicCandidates += 1;
            timMembersInContainer += 1;
            const tim = validateTimBuffer(memberPayload);
            if (tim.kind === 'false-positive') {
              totalTimFalsePositives += 1;
            } else if (tim.kind === 'valid-strict') {
              validTimMembersInContainer += 1;
              if (tim.pmode === 2 && !tim.hasClut) {
                timBpp2InContainer += 1;
              }
            }
          }

          fileOffset += memberRes.engine.bytesWritten;
        }

        expect(membersInContainer).toBeLessThan(MAX_MULTI_MEMBERS);
        if (outerExt === '(none)') {
          multiTimContainers += 1;
          multiTimMembers += membersInContainer;
          multiTimValidStrict += validTimMembersInContainer;
          multiTimBpp2Count += timBpp2InContainer;
        } else if (outerExt === '.dat') {
          multiGmContainers += 1;
          multiGmMembers += membersInContainer;
          multiGmMagicCount += gmMembersInContainer;
          multiGmTimMembers += timMembersInContainer;
        }
      }

      expect(totalFiles).toBe(11_578);
      expect(zeroByteFiles).toBe(6);

      // TIM inventory (standalone raw, .tim.gz, and 2 multi-member containers)
      expect(rawTimFiles).toBe(3_576);
      expect(rawTimValidStrict).toBe(3_576);
      expect(rawTimPmodes.get('bpp0+clut')).toBe(3_539);
      expect(rawTimPmodes.get('bpp0')).toBe(37);

      expect(gzTimFiles).toBe(129);
      expect(gzTimValidStrict).toBe(95);
      expect(gzTimQuirkDoubleBnum).toBe(34);
      expect(gzTimPmodes.get('bpp0+clut')).toBe(120);
      expect(gzTimPmodes.get('bpp1+clut')).toBe(7);
      expect(gzTimPmodes.get('bpp0')).toBe(2);

      expect(multiTimContainers).toBe(2);
      expect(multiTimMembers).toBe(24);
      expect(multiTimValidStrict).toBe(24);
      expect(multiTimBpp2Count).toBe(24);

      expect(timMagicCandidates).toBe(3_729);
      expect(totalTimFalsePositives).toBe(0);

      // Menu / GTMP / GM image containers
      expect(multiGmContainers).toBe(5);
      expect(multiGmMembers).toBe(12_658);
      expect(multiGmMagicCount).toBe(12_658);
      expect(multiGmTimMembers).toBe(0);

      expect(rawGtmpDatFiles).toBe(1);
      expect(rawGtmpDatSize).toBe(44_724_224);

      // Car textures & models (M6)
      expect(cdpCnpFiles).toBe(2_220);
      expect(cdpCnpExactSizeCount).toBe(2_220);
      expect(cdoCnoFiles).toBe(2_220);
      expect(cdoCnoMagicCount).toBe(2_220);
      expect(cdoCnoWithinLimitCount).toBe(2_220);

      // Track/backdrop texture candidates (M8) & unverified 00 00 02 01 family
      expect(trpGzCount).toBe(126);
      expect(trpSecondU32Is16).toBe(126);
      expect(bspGzCount).toBe(34);
      expect(bspSecondU32Is16).toBe(34);
      expect(lgfGzCount).toBe(180);
      expect(lgfGzMagic00000201).toBe(180);
      expect(lgfGzFixedSizeCount).toBe(180);
      expect(standaloneExtensionless00000201).toBe(81);

      // Ensure cachedSource alone never buffered the whole archive
      expect(cachedSource.getStats().bytesReadFromSource).toBeLessThan(archiveSize);
    },
    180_000,
  );
});
