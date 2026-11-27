import { existsSync } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gunzip } from '../../src/formats/gzip';
import {
  buildTrackModel,
  parseTro,
  parseTrp,
  type TrackMeshPart,
} from '../../src/formats/track';
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

function getStem(entryPath: string): string {
  const slashIdx = Math.max(entryPath.lastIndexOf('/'), entryPath.lastIndexOf('\\'));
  const fileName = slashIdx >= 0 ? entryPath.slice(slashIdx + 1) : entryPath;
  const firstDot = fileName.indexOf('.');
  return (firstDot >= 0 ? fileName.slice(0, firstDot) : fileName).toLowerCase();
}

function countHorizontalNormalSigns(parts: readonly TrackMeshPart[]): { up: number; down: number } {
  let up = 0;
  let down = 0;
  for (const part of parts) {
    const pos = part.positions;
    const idx = part.indices;
    for (let ti = 0; ti < part.triangleCount; ti += 1) {
      const i0 = idx[ti * 3]! * 3;
      const i1 = idx[ti * 3 + 1]! * 3;
      const i2 = idx[ti * 3 + 2]! * 3;
      const ax = pos[i1]! - pos[i0]!;
      const ay = pos[i1 + 1]! - pos[i0 + 1]!;
      const az = pos[i1 + 2]! - pos[i0 + 2]!;
      const bx = pos[i2]! - pos[i0]!;
      const by = pos[i2 + 1]! - pos[i0 + 1]!;
      const bz = pos[i2 + 2]! - pos[i0 + 2]!;
      const nx = ay * bz - az * by;
      const ny = az * bx - ax * bz;
      const nz = ax * by - ay * bx;
      const len = Math.hypot(nx, ny, nz);
      if (len > 1e-6) {
        const nyNorm = ny / len;
        if (nyNorm > 0.7) up += 1;
        else if (nyNorm < -0.7) down += 1;
      }
    }
  }
  return { up, down };
}

describe.skipIf(!HAS_REAL_VOL)('Real GT2.VOL track parser & TrackModel integration (M8.4)', () => {
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

  it('parses all 126 .trp.gz + .tro.gz pairs and builds TrackModels with 0 errors and verified batching/winding', async () => {
    const files = reader.getAllEntries().filter((entry) => entry.kind === 'file');
    const troEntries = files.filter(
      (e) => e.path.toLowerCase().startsWith('crsobj/') && e.path.toLowerCase().endsWith('.tro.gz'),
    );
    const trpByStem = new Map(
      files
        .filter((e) => e.path.toLowerCase().startsWith('crsobj/') && e.path.toLowerCase().endsWith('.trp.gz'))
        .map((e) => [getStem(e.path), e]),
    );

    expect(troEntries).toHaveLength(126);

    let totalTims = 0;
    let totalSegments = 0;
    let totalWalls2D = 0;
    let totalLod1FallbackSegs = 0;
    let tracksWithLod1Fallback = 0;
    let totalPrimaryParts = 0;
    let totalPrimaryTriangles = 0;
    let totalNonEmptySegs = 0;
    let horizUp = 0;
    let horizDown = 0;

    for (const troEntry of troEntries) {
      const trpEntry = trpByStem.get(getStem(troEntry.path));
      expect(trpEntry).toBeDefined();

      const troRaw = await gunzip(await cachedSource.read(troEntry.address, troEntry.address + troEntry.size));
      const trpRaw = await gunzip(await cachedSource.read(trpEntry!.address, trpEntry!.address + trpEntry!.size));

      const trp = parseTrp(trpRaw);
      const tro = parseTro(troRaw);
      const model = buildTrackModel(tro, trp);

      totalTims += trp.timCount;
      totalSegments += tro.segmentCount;
      for (const seg of tro.segments) {
        totalWalls2D += seg.walls2D.length;
      }

      let hadFallback = false;
      for (const segInfo of model.segments) {
        if (segInfo.subMeshRole === 'lod1-fallback') {
          totalLod1FallbackSegs += 1;
          hadFallback = true;
        }
        if (segInfo.subMeshRole !== 'empty') {
          totalNonEmptySegs += 1;
        }
      }
      if (hadFallback) tracksWithLod1Fallback += 1;

      totalPrimaryParts += model.render.length;
      for (const part of model.render) {
        totalPrimaryTriangles += part.triangleCount;
        expect(part.vertexCount).toBeGreaterThan(0);
        expect(part.triangleCount).toBeGreaterThan(0);
      }

      expect(Number.isFinite(model.bounds.min.x)).toBe(true);
      expect(Number.isFinite(model.bounds.max.x)).toBe(true);
      expect(model.textureAtlas).not.toBeNull();

      const signs = countHorizontalNormalSigns(model.render);
      horizUp += signs.up;
      horizDown += signs.down;
    }

    expect(totalTims).toBe(14_138);
    expect(totalSegments).toBe(14_387);
    expect(totalWalls2D).toBe(80_433);
    expect(totalLod1FallbackSegs).toBe(700);
    expect(tracksWithLod1Fallback).toBe(12);
    expect(totalPrimaryTriangles).toBeGreaterThan(1_000_000);
    // Normalized CCW winding makes > 95% of near-horizontal road/ground triangles face +Y up.
    expect(horizUp / (horizUp + horizDown)).toBeGreaterThan(0.95);
    // Per-vertex paletteIndices batching keeps parts compact (well under 8 parts per non-empty segment).
    expect(totalPrimaryParts / totalNonEmptySegs).toBeLessThan(8);
  }, 60_000);
});
