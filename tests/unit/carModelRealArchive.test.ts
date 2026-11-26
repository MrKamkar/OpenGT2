import { existsSync } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildCarModel,
  selectCarModelPaint,
  withCarModelTexture,
} from '../../src/formats/car';
import { CDO_FIXED_POINT_SCALE, parseCdo } from '../../src/formats/car/cdo';
import { CDP_HEIGHT, CDP_WIDTH, parseCdp } from '../../src/formats/car/cdp';
import { gunzip } from '../../src/formats/gzip';
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

interface PairedCarArchiveEntries {
  dayModel?: VolEntry;
  dayTexture?: VolEntry;
  nightModel?: VolEntry;
  nightTexture?: VolEntry;
}

interface DayCarBaselineSample {
  readonly colorCount: number;
  readonly lod0LengthM: number;
  readonly lod0Vertices: number;
  readonly lod0TotalTriangles: number;
  readonly lod0UntexturedTriangles: number;
  readonly lod0TexturedTriangles: number;
  readonly lod0PaletteCount: number;
  readonly lod1TotalTriangles: number;
  readonly lod2TotalTriangles: number;
}

describe.skipIf(!HAS_REAL_VOL)('Real GT2.VOL CarModel full-archive integration (M6.10)', () => {
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
    'builds WebGL2-ready CarModels across all 2,220 day/night pairs and verifies 5-class M7 baseline stats',
    async () => {
      const carsByStem = new Map<string, PairedCarArchiveEntries>();
      for (const entry of reader.getAllEntries()) {
        if (entry.kind !== 'file') {
          continue;
        }
        const lower = entry.path.toLowerCase();
        const slash = lower.lastIndexOf('/');
        const base = slash >= 0 ? lower.slice(slash + 1) : lower;
        let slot: keyof PairedCarArchiveEntries | undefined;
        if (base.endsWith('.cdo.gz')) slot = 'dayModel';
        else if (base.endsWith('.cdp.gz')) slot = 'dayTexture';
        else if (base.endsWith('.cno.gz')) slot = 'nightModel';
        else if (base.endsWith('.cnp.gz')) slot = 'nightTexture';
        if (slot === undefined) {
          continue;
        }

        const stem = base.slice(0, -7);
        let bucket = carsByStem.get(stem);
        if (bucket === undefined) {
          bucket = {};
          carsByStem.set(stem, bucket);
        }
        bucket[slot] = entry;
      }

      expect(carsByStem.size).toBe(1110);

      let builtModels = 0;
      let paintSwitchChecks = 0;
      let dayNightSwitchChecks = 0;
      let emptyPaletteWarnings = 0;
      let modulatedQuadWarnings = 0;
      let zeroNormalWarnings = 0;
      let uvOutOfRangeCount = 0;
      let paletteOutOfRangeCount = 0;
      let shapeInvariantsFailed = 0;
      const dayBaselines: DayCarBaselineSample[] = [];

      for (const pair of carsByStem.values()) {
        if (
          pair.dayModel === undefined ||
          pair.dayTexture === undefined ||
          pair.nightModel === undefined ||
          pair.nightTexture === undefined
        ) {
          throw new Error('Incomplete day/night car asset quartet in GT2.VOL');
        }

        const [dayModelBytes, dayTexBytes, nightModelBytes, nightTexBytes] = await Promise.all([
          cachedSource
            .read(pair.dayModel.address, pair.dayModel.address + pair.dayModel.size)
            .then(gunzip),
          cachedSource
            .read(pair.dayTexture.address, pair.dayTexture.address + pair.dayTexture.size)
            .then(gunzip),
          cachedSource
            .read(pair.nightModel.address, pair.nightModel.address + pair.nightModel.size)
            .then(gunzip),
          cachedSource
            .read(pair.nightTexture.address, pair.nightTexture.address + pair.nightTexture.size)
            .then(gunzip),
        ]);

        const dayCdo = parseCdo(dayModelBytes);
        const dayCdp = parseCdp(dayTexBytes);
        const nightCno = parseCdo(nightModelBytes);
        const nightCnp = parseCdp(nightTexBytes);

        const dayModel = buildCarModel(dayCdo, {
          texture: dayCdp,
          variant: 'day',
          colorSlotIndex: 0,
        });
        const nightModel = buildCarModel(nightCno, {
          texture: nightCnp,
          variant: 'night',
          colorSlotIndex: 0,
        });
        builtModels += 2;

        for (const car of [dayModel, nightModel]) {
          if (
            car.lods.length !== 3 ||
            car.wheels.length !== 4 ||
            car.windingOrder !== 'ccw' ||
            car.texture === null ||
            car.texture.indexedImage.width !== CDP_WIDTH ||
            car.texture.indexedImage.height !== CDP_HEIGHT ||
            car.texture.indexedImage.palettes.length !== 16
          ) {
            shapeInvariantsFailed += 1;
          }

          for (const lod of car.lods) {
            if (
              lod.rawVerticesInt16.length !== lod.vertexCount * 4 ||
              lod.positionsMeters.length !== lod.vertexCount * 3 ||
              lod.normals.length !== lod.normalCount * 3
            ) {
              shapeInvariantsFailed += 1;
            }

            for (const tri of lod.texturedTriangles) {
              if (tri.paletteIndex < 0 || tri.paletteIndex > 14) {
                paletteOutOfRangeCount += 1;
              }
              for (const uv of tri.uvs) {
                if (uv.u < 0 || uv.u >= CDP_WIDTH || uv.v < 0 || uv.v >= CDP_HEIGHT) {
                  uvOutOfRangeCount += 1;
                }
              }
            }
          }

          for (const warning of car.warnings) {
            if (warning.includes('normalCount === 0')) {
              zeroNormalWarnings += 1;
            } else if (warning.includes('faceType 44')) {
              modulatedQuadWarnings += 1;
            } else if (warning.includes('all-0xFFFF')) {
              emptyPaletteWarnings += 1;
            } else {
              throw new Error(`Unexpected CarModel warning: ${warning}`);
            }
          }
        }

        if (dayCdp.colorCount > 1) {
          const lastPaint = selectCarModelPaint(dayModel, dayCdp.colorCount - 1);
          expect(lastPaint.texture?.colorSlotIndex).toBe(dayCdp.colorCount - 1);
          paintSwitchChecks += 1;
        }

        if (dayNightSwitchChecks < 25) {
          const reboundNight = withCarModelTexture(dayModel, nightCnp, {
            variant: 'night',
            colorSlotIndex: 0,
          });
          expect(reboundNight.texture?.variant).toBe('night');
          dayNightSwitchChecks += 1;
        }

        const lod0 = dayModel.lods[0];
        const lod1 = dayModel.lods[1];
        const lod2 = dayModel.lods[2];
        if (lod0 !== undefined && lod1 !== undefined && lod2 !== undefined) {
          const usedPals = new Set<number>();
          for (const tri of lod0.texturedTriangles) {
            usedPals.add(tri.paletteIndex);
          }
          dayBaselines.push({
            colorCount: dayCdp.colorCount,
            lod0LengthM: Number(
              ((lod0.boundingBox.high.z - lod0.boundingBox.low.z) / CDO_FIXED_POINT_SCALE).toFixed(
                3,
              ),
            ),
            lod0Vertices: lod0.vertexCount,
            lod0TotalTriangles: lod0.untexturedTriangles.length + lod0.texturedTriangles.length,
            lod0UntexturedTriangles: lod0.untexturedTriangles.length,
            lod0TexturedTriangles: lod0.texturedTriangles.length,
            lod0PaletteCount: usedPals.size,
            lod1TotalTriangles: lod1.untexturedTriangles.length + lod1.texturedTriangles.length,
            lod2TotalTriangles: lod2.untexturedTriangles.length + lod2.texturedTriangles.length,
          });
        }
      }

      expect(builtModels).toBe(2220);
      expect(shapeInvariantsFailed).toBe(0);
      expect(paletteOutOfRangeCount).toBe(0);
      expect(uvOutOfRangeCount).toBe(0);
      expect(paintSwitchChecks).toBe(825);
      expect(dayNightSwitchChecks).toBe(25);
      expect(zeroNormalWarnings).toBe(8);
      expect(modulatedQuadWarnings).toBe(8);
      expect(emptyPaletteWarnings).toBe(1);
      expect(dayBaselines).toHaveLength(1110);

      // Verify 5 deterministic anonymized M7 visual baseline classes
      const byLength = [...dayBaselines].sort(
        (a, b) => a.lod0LengthM - b.lod0LengthM || a.lod0TotalTriangles - b.lod0TotalTriangles,
      );
      const classA = byLength[0];
      const classB = byLength[Math.floor(byLength.length / 2)];
      const classC = [...dayBaselines].sort(
        (a, b) => b.lod0TotalTriangles - a.lod0TotalTriangles || b.lod0Vertices - a.lod0Vertices,
      )[0];
      const classD = [...dayBaselines]
        .filter((item) => item.colorCount === 16)
        .sort((a, b) => b.lod0TotalTriangles - a.lod0TotalTriangles)[0];
      const classE = byLength[byLength.length - 1];

      expect(classA).toEqual({
        colorCount: 1,
        lod0LengthM: 0.063,
        lod0Vertices: 88,
        lod0TotalTriangles: 172,
        lod0UntexturedTriangles: 0,
        lod0TexturedTriangles: 172,
        lod0PaletteCount: 1,
        lod1TotalTriangles: 172,
        lod2TotalTriangles: 172,
      });
      expect(classB).toEqual({
        colorCount: 10,
        lod0LengthM: 2.241,
        lod0Vertices: 226,
        lod0TotalTriangles: 328,
        lod0UntexturedTriangles: 32,
        lod0TexturedTriangles: 296,
        lod0PaletteCount: 7,
        lod1TotalTriangles: 214,
        lod2TotalTriangles: 50,
      });
      expect(classC).toEqual({
        colorCount: 6,
        lod0LengthM: 3.685,
        lod0Vertices: 255,
        lod0TotalTriangles: 496,
        lod0UntexturedTriangles: 36,
        lod0TexturedTriangles: 460,
        lod0PaletteCount: 13,
        lod1TotalTriangles: 236,
        lod2TotalTriangles: 32,
      });
      expect(classD).toEqual({
        colorCount: 16,
        lod0LengthM: 2.497,
        lod0Vertices: 198,
        lod0TotalTriangles: 368,
        lod0UntexturedTriangles: 38,
        lod0TexturedTriangles: 330,
        lod0PaletteCount: 13,
        lod1TotalTriangles: 232,
        lod2TotalTriangles: 52,
      });
      expect(classE).toEqual({
        colorCount: 2,
        lod0LengthM: 3.968,
        lod0Vertices: 223,
        lod0TotalTriangles: 376,
        lod0UntexturedTriangles: 32,
        lod0TexturedTriangles: 344,
        lod0PaletteCount: 13,
        lod1TotalTriangles: 266,
        lod2TotalTriangles: 64,
      });
    },
    120_000,
  );
});
