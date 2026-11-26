import { existsSync } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync as zlibGunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  composeGmToRgba,
  composeGtmpToRgba,
  isGmMagic,
  isGtmpMagic,
  parseGm,
  parseIdxTable,
  readGmContainerEntry,
  readGtmpContainerEntry,
} from '../../src/formats/gtimg';
import { isGzipMagic } from '../../src/formats/gzip';
import { VolReader, type VolEntry } from '../../src/formats/vol';
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

function getNormalizedExtension(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  const base = slash >= 0 ? filePath.slice(slash + 1) : filePath;
  const dot = base.lastIndexOf('.');
  return dot > 0 && dot < base.length - 1 ? base.slice(dot).toLowerCase() : '(none)';
}

describe.skipIf(!HAS_REAL_VOL)('Real GT2.VOL GM/GTMP/IDX parser verification (M4.4)', () => {
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
    'parses all 458 GTMP blocks and 16,914 GM images via IDX tables using streaming reads',
    async () => {
      const fileEntries = reader.getAllEntries().filter((entry) => entry.kind === 'file');

      const idxEntries: VolEntry[] = [];
      const gmDatEntries: VolEntry[] = [];
      let gtmpDatEntry: VolEntry | undefined;

      for (const entry of fileEntries) {
        if (entry.size === 0) {
          continue;
        }
        const ext = getNormalizedExtension(entry.path);
        if (ext === '.idx') {
          idxEntries.push(entry);
          continue;
        }
        if (ext === '.dat') {
          const head = await cachedSource.read(
            entry.address,
            entry.address + Math.min(4, entry.size),
          );
          if (isGzipMagic(head)) {
            gmDatEntries.push(entry);
          } else if (isGtmpMagic(head)) {
            gtmpDatEntry = entry;
          }
        }
      }

      expect(idxEntries.length).toBe(6);
      expect(gmDatEntries.length).toBe(5);
      expect(gtmpDatEntry).toBeDefined();
      if (gtmpDatEntry === undefined) {
        return;
      }

      // 1. Pair .idx files with GTMP and the 5 GM .dat containers by exact totalDataSize
      const gtmpBySize = new Map<number, VolEntry>([[gtmpDatEntry.size, gtmpDatEntry]]);
      const gmBySize = new Map<number, VolEntry>(gmDatEntries.map((d) => [d.size, d]));

      let gtmpParsedCount = 0;
      let gmTotalCount = 0;
      let gmBrowserPipelineSampleCount = 0;
      const gmVariantCounts = new Map<number, number>();

      for (const idxEntry of idxEntries) {
        const idxBytes = await rawSource.read(idxEntry.address, idxEntry.address + idxEntry.size);
        const maybeGtmpIdx = parseIdxTable(idxBytes, 'aligned-2048');
        const matchedGtmp = gtmpBySize.get(maybeGtmpIdx.totalDataSize);

        if (matchedGtmp !== undefined) {
          expect(maybeGtmpIdx.count).toBe(458);
          const gtmpSlice = rawSource.slice(
            matchedGtmp.address,
            matchedGtmp.address + matchedGtmp.size,
          );

          for (let i = 0; i < maybeGtmpIdx.count; i += 1) {
            const gtmp = await readGtmpContainerEntry(gtmpSlice, maybeGtmpIdx, i);
            expect(gtmp.tileSheet.width).toBe(512);
            expect(gtmp.tileSheet.bpp).toBe(8);
            expect(gtmp.tileSheet.palettes.length).toBe(16);
            expect(gtmp.positions.length).toBe(2016);
            gtmpParsedCount += 1;

            if (i < 5 || i >= maybeGtmpIdx.count - 2) {
              const rgba = composeGtmpToRgba(gtmp);
              expect(rgba.width).toBe(512);
              expect(rgba.height).toBe(504);
              expect(rgba.rgba.byteLength).toBe(512 * 504 * 4);
            }
          }
          continue;
        }

        const gmIdx = parseIdxTable(idxBytes, 'mangled-4');
        const matchedDat = gmBySize.get(gmIdx.totalDataSize);
        expect(matchedDat).toBeDefined();
        if (matchedDat === undefined) {
          continue;
        }

        const datSlice = rawSource.slice(matchedDat.address, matchedDat.address + matchedDat.size);

        // Verify pure browser-compatible pipeline (ByteSource + src/formats/gzip) on a stratified sample
        for (let i = 0; i < gmIdx.count; i += 1) {
          if (i < 10 || i >= gmIdx.count - 5) {
            const gm = await readGmContainerEntry(datSlice, gmIdx, i);
            expect(gm.tileSheet.width).toBe(512);
            expect(gm.tileSheet.bpp).toBe(4);
            expect(gm.tileSheet.palettes.length).toBe(32);
            expect(gm.metadata.backgroundIndex).toBeGreaterThanOrEqual(0);
            expect(gm.metadata.backgroundIndex).toBeLessThan(458);
            const rgba = composeGmToRgba(gm);
            expect(rgba.rgba.byteLength).toBe(512 * 504 * 4);
            gmBrowserPipelineSampleCount += 1;
          }

          // Stream every single member through parseGm without accumulating buffers in RAM
          const idxItem = gmIdx.entries[i];
          expect(idxItem).toBeDefined();
          if (idxItem === undefined) {
            continue;
          }
          const comp = await datSlice.read(idxItem.offset, idxItem.offset + idxItem.size);
          const decomp = zlibGunzipSync(comp, { info: true });
          expect(decomp.engine.bytesWritten).toBe(comp.byteLength);
          expect(isGmMagic(decomp.buffer)).toBe(true);

          const parsed = parseGm(decomp.buffer);
          gmTotalCount += 1;
          gmVariantCounts.set(
            parsed.subBlockSets,
            (gmVariantCounts.get(parsed.subBlockSets) ?? 0) + 1,
          );
        }
      }

      expect(gtmpParsedCount).toBe(458);
      expect(gmBrowserPipelineSampleCount).toBe(75);
      expect(gmTotalCount).toBe(16_914);
      expect(gmVariantCounts.get(0)).toBe(4_239);
      expect(gmVariantCounts.get(1)).toBe(280);
      expect(gmVariantCounts.get(2)).toBe(2_940);
      expect(gmVariantCounts.get(3)).toBe(9_330);
      expect(gmVariantCounts.get(4)).toBe(125);

      expect(cachedSource.getStats().bytesReadFromSource).toBeLessThan(archiveSize);
    },
    180_000,
  );
});
