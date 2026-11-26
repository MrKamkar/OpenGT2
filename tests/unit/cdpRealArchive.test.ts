import { existsSync } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CDP_EXPECTED_FILE_SIZE,
  CDP_HEIGHT,
  CDP_MAX_COLOR_SLOTS,
  CDP_PALETTES_PER_COLOR,
  CDP_WIDTH,
  cdpToIndexedImage,
  parseCdp,
} from '../../src/formats/car/cdp';
import { gunzip, isGzipMagic } from '../../src/formats/gzip';
import { decodeIndexedImageToRgba } from '../../src/formats/ps1';
import { classifyFile, stripGzipExtension } from '../../src/formats/registry';
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

describe.skipIf(!HAS_REAL_VOL)('Real GT2.VOL CDP/CNP texture verification (M6.7)', () => {
  let fileHandle: FileHandle;
  let cachedSource: CachedByteSource;
  let reader: VolReader;

  beforeAll(async () => {
    fileHandle = await open(REAL_VOL_PATH, 'r');
    const fileStats = await fileHandle.stat();
    const rawSource = new NodeFileByteSource(fileHandle, fileStats.size);
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
    'streams, decompresses, parses, and validates all 2,220 .cdp.gz/.cnp.gz car textures',
    async () => {
      const cdpEntries = reader.getAllEntries().filter((entry) => {
        if (entry.kind !== 'file') {
          return false;
        }
        const lower = entry.path.toLowerCase();
        return lower.endsWith('.cdp.gz') || lower.endsWith('.cnp.gz');
      });

      expect(cdpEntries.length).toBe(2220);

      let cdpCount = 0;
      let cnpCount = 0;
      let minColors = Infinity;
      let maxColors = 0;
      let totalActiveSlots = 0;
      let sampleDecodes = 0;
      const dayByStem = new Map<string, { colorCount: number; colorIds: number[] }>();
      const nightByStem = new Map<string, { colorCount: number; colorIds: number[] }>();

      for (const entry of cdpEntries) {
        const lower = entry.path.toLowerCase();
        const isNight = lower.endsWith('.cnp.gz');
        if (isNight) {
          cnpCount += 1;
        } else {
          cdpCount += 1;
        }

        const compressed = await cachedSource.read(entry.address, entry.address + entry.size);
        expect(isGzipMagic(compressed)).toBe(true);
        const raw = await gunzip(compressed);

        const classified = classifyFile({
          path: stripGzipExtension(entry.path),
          headBytes: raw.subarray(0, 16),
        });
        expect(classified.id).toBe('cdp');
        expect(classified.evidence).toBe('E3');
        expect(classified.matchedBy).toBe('ext');

        const parsed = parseCdp(raw);
        expect(parsed.byteLength).toBe(CDP_EXPECTED_FILE_SIZE);
        expect(parsed.width).toBe(CDP_WIDTH);
        expect(parsed.height).toBe(CDP_HEIGHT);
        expect(parsed.headerByte1).toBe(0);
        expect(parsed.colorCount).toBeGreaterThanOrEqual(1);
        expect(parsed.colorCount).toBeLessThanOrEqual(CDP_MAX_COLOR_SLOTS);
        expect(parsed.warnings).toEqual([]);
        expect(parsed.indices.byteLength).toBe(CDP_WIDTH * CDP_HEIGHT);

        if (parsed.colorCount < minColors) minColors = parsed.colorCount;
        if (parsed.colorCount > maxColors) maxColors = parsed.colorCount;
        totalActiveSlots += parsed.colorCount;

        for (const slot of parsed.colorSlots) {
          expect(slot.colorIdChar).not.toBeNull();
          expect(slot.palettes).toHaveLength(CDP_PALETTES_PER_COLOR);
        }

        const slash = lower.lastIndexOf('/');
        const base = slash >= 0 ? lower.slice(slash + 1) : lower;
        const stem = base.slice(0, -7);
        const summary = {
          colorCount: parsed.colorCount,
          colorIds: Array.from(parsed.colorIds),
        };
        if (isNight) {
          nightByStem.set(stem, summary);
        } else {
          dayByStem.set(stem, summary);
        }

        if (sampleDecodes < 20) {
          const indexed = cdpToIndexedImage(parsed, parsed.colorCount - 1);
          const rgba = decodeIndexedImageToRgba(indexed, 0, {
            transparencyMode: 'transparent-zero',
          });
          expect(rgba.width).toBe(CDP_WIDTH);
          expect(rgba.height).toBe(CDP_HEIGHT);
          expect(rgba.rgba.byteLength).toBe(CDP_WIDTH * CDP_HEIGHT * 4);
          sampleDecodes += 1;
        }
      }

      expect(cdpCount).toBe(1110);
      expect(cnpCount).toBe(1110);
      expect(minColors).toBe(1);
      expect(maxColors).toBe(16);
      expect(totalActiveSlots).toBe(9258);
      expect(dayByStem.size).toBe(1110);
      expect(nightByStem.size).toBe(1110);

      for (const [stem, daySummary] of dayByStem) {
        expect(nightByStem.get(stem)).toEqual(daySummary);
      }
    },
    30_000,
  );
});
