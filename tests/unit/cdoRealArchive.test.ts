import { existsSync } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CDO_MAX_FILE_SIZE, parseCdo } from '../../src/formats/car/cdo';
import { gunzip, isGzipMagic } from '../../src/formats/gzip';
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

describe.skipIf(!HAS_REAL_VOL)('Real GT2.VOL CDO/CNO model verification (M6.6)', () => {
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
    'streams, decompresses, parses, and validates all 2,220 .cdo.gz/.cno.gz car models',
    async () => {
      const cdoEntries = reader.getAllEntries().filter((entry) => {
        if (entry.kind !== 'file') {
          return false;
        }
        const lower = entry.path.toLowerCase();
        return lower.endsWith('.cdo.gz') || lower.endsWith('.cno.gz');
      });

      expect(cdoEntries.length).toBe(2220);

      let cdoCount = 0;
      let cnoCount = 0;
      let minBytes = Infinity;
      let maxBytes = 0;
      let filesWithZeroNormals = 0;
      let lodsWithZeroNormals = 0;
      let filesWithModulatedUvQuad = 0;
      let modulatedUvQuadCount = 0;
      let shadow24Count = 0;
      let shadow48Count = 0;

      for (const entry of cdoEntries) {
        if (entry.path.toLowerCase().endsWith('.cdo.gz')) {
          cdoCount += 1;
        } else {
          cnoCount += 1;
        }

        const compressed = await cachedSource.read(entry.address, entry.address + entry.size);
        expect(isGzipMagic(compressed)).toBe(true);
        const raw = await gunzip(compressed);

        const classified = classifyFile({
          path: stripGzipExtension(entry.path),
          headBytes: raw.subarray(0, 16),
        });
        expect(classified.id).toBe('cdo');
        expect(classified.evidence).toBe('E3');
        expect(classified.matchedBy).toBe('magic+ext');

        const model = parseCdo(raw);

        if (model.byteLength < minBytes) minBytes = model.byteLength;
        if (model.byteLength > maxBytes) maxBytes = model.byteLength;
        expect(model.byteLength).toBeLessThanOrEqual(CDO_MAX_FILE_SIZE);
        expect(model.lodTable.lodCount).toBe(3);
        expect(model.header.rawWheelDiag0x08).toEqual([0, 0, 0, 0]);
        expect(model.header.unk_0x10).toEqual([0, 0, 0, 0]);
        expect(model.header.menuWheels.frontRadius).toBeGreaterThan(0);
        expect(model.shadow.endOffset).toBe(model.byteLength);

        if (model.shadow.header.vertexCount === 24) {
          shadow24Count += 1;
        } else if (model.shadow.header.vertexCount === 48) {
          shadow48Count += 1;
        }

        let fileZeroNormalLods = 0;
        let fileModulatedQuads = 0;
        for (const warning of model.warnings) {
          if (warning.includes('normalCount === 0')) {
            fileZeroNormalLods += 1;
          } else if (warning.includes('faceType 44')) {
            fileModulatedQuads += 1;
          } else {
            throw new Error(`Unexpected CDO validation warning: ${warning}`);
          }
        }

        if (fileZeroNormalLods > 0) {
          filesWithZeroNormals += 1;
          lodsWithZeroNormals += fileZeroNormalLods;
        }
        if (fileModulatedQuads > 0) {
          filesWithModulatedUvQuad += 1;
          modulatedUvQuadCount += fileModulatedQuads;
        }
      }

      expect(cdoCount).toBe(1110);
      expect(cnoCount).toBe(1110);
      expect(minBytes).toBe(11048);
      expect(maxBytes).toBe(20000);
      expect(shadow24Count).toBe(2218);
      expect(shadow48Count).toBe(2);
      expect(filesWithZeroNormals).toBe(4);
      expect(lodsWithZeroNormals).toBe(8);
      expect(filesWithModulatedUvQuad).toBe(2);
      expect(modulatedUvQuadCount).toBe(8);
    },
    30_000,
  );
});
