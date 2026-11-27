import { existsSync } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CdoPolygon, type CdoTexturedPolygon, parseCdo } from '../../src/formats/car/cdo';
import { CDP_WIDTH, parseCdp } from '../../src/formats/car/cdp';
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

function triangleNormalDot(
  positions: Float32Array,
  normals: Float32Array,
  i0: number,
  i1: number,
  i2: number,
  n0: number,
  n1: number,
  n2: number,
): number {
  const x0 = positions[i0 * 3] ?? 0;
  const y0 = positions[i0 * 3 + 1] ?? 0;
  const z0 = positions[i0 * 3 + 2] ?? 0;
  const x1 = positions[i1 * 3] ?? 0;
  const y1 = positions[i1 * 3 + 1] ?? 0;
  const z1 = positions[i1 * 3 + 2] ?? 0;
  const x2 = positions[i2 * 3] ?? 0;
  const y2 = positions[i2 * 3 + 1] ?? 0;
  const z2 = positions[i2 * 3 + 2] ?? 0;

  const ux = x1 - x0;
  const uy = y1 - y0;
  const uz = z1 - z0;
  const vx = x2 - x0;
  const vy = y2 - y0;
  const vz = z2 - z0;

  const cx = uy * vz - uz * vy;
  const cy = uz * vx - ux * vz;
  const cz = ux * vy - uy * vx;
  const cLen = Math.hypot(cx, cy, cz);
  if (cLen < 1e-7) {
    return 0;
  }

  const nx = (normals[n0 * 3] ?? 0) + (normals[n1 * 3] ?? 0) + (normals[n2 * 3] ?? 0);
  const ny = (normals[n0 * 3 + 1] ?? 0) + (normals[n1 * 3 + 1] ?? 0) + (normals[n2 * 3 + 1] ?? 0);
  const nz = (normals[n0 * 3 + 2] ?? 0) + (normals[n1 * 3 + 2] ?? 0) + (normals[n2 * 3 + 2] ?? 0);
  const nLen = Math.hypot(nx, ny, nz);
  if (nLen < 1e-7) {
    return 0;
  }

  return (cx * nx + cy * ny + cz * nz) / (cLen * nLen);
}

function cross2d(u0: number, v0: number, u1: number, v1: number, u2: number, v2: number): number {
  return (u1 - u0) * (v2 - v0) - (v1 - v0) * (u2 - u0);
}

interface CarPairEntry {
  model?: VolEntry;
  texture?: VolEntry;
}

describe.skipIf(!HAS_REAL_VOL)('Real GT2.VOL CDO/CDP open-question verification (M6.9)', () => {
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
    'resolves wheel slots, CCW quad triangulation, paletteRaw formula, renderFlags, and 0xFFFF usage across 2,220 pairs',
    async () => {
      const pairs = new Map<string, CarPairEntry>();
      for (const entry of reader.getAllEntries()) {
        if (entry.kind !== 'file') {
          continue;
        }
        const lower = entry.path.toLowerCase();
        const slash = lower.lastIndexOf('/');
        const base = slash >= 0 ? lower.slice(slash + 1) : lower;
        let isNight = false;
        let isModel = false;
        if (base.endsWith('.cdo.gz')) {
          isModel = true;
        } else if (base.endsWith('.cno.gz')) {
          isNight = true;
          isModel = true;
        } else if (base.endsWith('.cdp.gz')) {
          isNight = false;
        } else if (base.endsWith('.cnp.gz')) {
          isNight = true;
        } else {
          continue;
        }

        const key = `${base.slice(0, -7)}:${isNight ? 'night' : 'day'}`;
        let pair = pairs.get(key);
        if (pair === undefined) {
          pair = {};
          pairs.set(key, pair);
        }
        if (isModel) {
          pair.model = entry;
        } else {
          pair.texture = entry;
        }
      }

      expect(pairs.size).toBe(2220);

      let singleSidedPos = 0;
      let singleSidedNeg = 0;
      let rf12Pos = 0;
      let rf12Neg = 0;
      let uvQuadSameSign = 0;
      let uvQuadOppSign = 0;
      let uvPolyTotal = 0;
      let palette14Matches = 0;
      let rfBit2Matches = 0;
      let rfBit2AndPal14BijectionErrors = 0;
      let partialFfffTexelHits = 0;
      let allFfffDayHitCount = 0;
      let allFfffNightFixedCount = 0;
      const observedPaletteRaw = new Set<number>();

      for (const [key, pair] of pairs) {
        if (pair.model === undefined || pair.texture === undefined) {
          throw new Error(`Incomplete car pair for ${key}`);
        }
        const isNight = key.endsWith(':night');
        const cdo = parseCdo(
          await gunzip(await cachedSource.read(pair.model.address, pair.model.address + pair.model.size)),
        );
        const cdp = parseCdp(
          await gunzip(
            await cachedSource.read(pair.texture.address, pair.texture.address + pair.texture.size),
          ),
        );

        // 1) Wheels: 0x08..0x0F is zero, 0x18..0x1F is non-zero, 0x20 order is FL/FR/RL/RR
        expect(cdo.header.rawWheelDiag0x08).toEqual([0, 0, 0, 0]);
        expect(cdo.header.menuWheels.frontRadius).toBeGreaterThan(0);
        expect(cdo.header.menuWheels.rearRadius).toBeGreaterThan(0);
        expect(cdo.header.wheelPositions[0].x).toBeLessThan(0);
        expect(cdo.header.wheelPositions[0].z).toBeLessThan(0);
        expect(cdo.header.wheelPositions[1].x).toBeGreaterThan(0);
        expect(cdo.header.wheelPositions[1].z).toBeLessThan(0);
        expect(cdo.header.wheelPositions[2].x).toBeLessThan(0);
        expect(cdo.header.wheelPositions[2].z).toBeGreaterThan(0);
        expect(cdo.header.wheelPositions[3].x).toBeGreaterThan(0);
        expect(cdo.header.wheelPositions[3].z).toBeGreaterThan(0);

        const slot0 = cdp.colorSlots[0];
        expect(slot0).toBeDefined();
        if (slot0 === undefined) {
          continue;
        }

        for (const lod of cdo.lods) {
          const pos = lod.vertices.positionsMeters;
          const norm = lod.normals.vectors;
          const hasNormals = lod.normals.count > 0;

          const checkSingleSided = (poly: CdoPolygon, isQuad: boolean): void => {
            if (!hasNormals || (poly.renderFlags & 0x08) === 0) {
              return;
            }
            const d1 = triangleNormalDot(
              pos,
              norm,
              poly.vertices[0],
              poly.vertices[1],
              poly.vertices[2],
              poly.normals[0],
              poly.normals[1],
              poly.normals[2],
            );
            if (!isQuad) {
              if (d1 > 1e-4) singleSidedPos += 1;
              else if (d1 < -1e-4) singleSidedNeg += 1;
              if (poly.renderFlags === 12) {
                if (d1 > 1e-4) rf12Pos += 1;
                else if (d1 < -1e-4) rf12Neg += 1;
              }
              return;
            }
            const d2 = triangleNormalDot(
              pos,
              norm,
              poly.vertices[0],
              poly.vertices[2],
              poly.vertices[3],
              poly.normals[0],
              poly.normals[2],
              poly.normals[3],
            );
            if (d1 > 1e-4 && d2 > 1e-4) {
              singleSidedPos += 1;
              if (poly.renderFlags === 12) rf12Pos += 1;
            } else if (d1 < -1e-4 || d2 < -1e-4) {
              singleSidedNeg += 1;
              if (poly.renderFlags === 12) rf12Neg += 1;
            }
          };

          for (const tri of lod.polygons.triangles) {
            expect(tri.renderFlags & 0x04).toBe(0);
            checkSingleSided(tri, false);
          }
          for (const quad of lod.polygons.quads) {
            expect(quad.renderFlags & 0x04).toBe(0);
            checkSingleSided(quad, true);
          }

          const checkUvPoly = (poly: CdoTexturedPolygon, isQuad: boolean): void => {
            uvPolyTotal += 1;
            checkSingleSided(poly, isQuad);
            observedPaletteRaw.add(poly.paletteRaw);

            const palIdx = (poly.paletteRaw >>> 4) + (poly.paletteRaw & 0x3f);
            expect(palIdx).toBeGreaterThanOrEqual(0);
            expect(palIdx).toBeLessThanOrEqual(14);

            const hasRfBit2 = (poly.renderFlags & 0x04) !== 0;
            const isPal14 = palIdx === 14;
            if (hasRfBit2 !== isPal14) {
              rfBit2AndPal14BijectionErrors += 1;
            }
            if (hasRfBit2) rfBit2Matches += 1;
            if (isPal14) palette14Matches += 1;

            if (isQuad) {
              const c1 = cross2d(
                poly.uvs[0].u,
                poly.uvs[0].v,
                poly.uvs[1].u,
                poly.uvs[1].v,
                poly.uvs[2].u,
                poly.uvs[2].v,
              );
              const c2 = cross2d(
                poly.uvs[0].u,
                poly.uvs[0].v,
                poly.uvs[2].u,
                poly.uvs[2].v,
                poly.uvs[3].u,
                poly.uvs[3].v,
              );
              if (c1 !== 0 && c2 !== 0) {
                if ((c1 > 0 && c2 > 0) || (c1 < 0 && c2 < 0)) {
                  uvQuadSameSign += 1;
                } else {
                  uvQuadOppSign += 1;
                }
              }
            }

            const emptyMask = slot0.emptyEntryMasks[palIdx] ?? 0;
            if (slot0.emptyPalettes[palIdx] === true) {
              expect(isNight).toBe(false);
              allFfffDayHitCount += 1;
            } else if (emptyMask !== 0) {
              const corners = isQuad ? 4 : 3;
              let uMin = 255;
              let uMax = 0;
              let vMin = 223;
              let vMax = 0;
              for (let c = 0; c < corners; c += 1) {
                const uv = poly.uvs[c];
                if (uv === undefined) continue;
                if (uv.u < uMin) uMin = uv.u;
                if (uv.u > uMax) uMax = uv.u;
                if (uv.v < vMin) vMin = uv.v;
                if (uv.v > vMax) vMax = uv.v;
              }
              for (let v = vMin; v <= vMax; v += 1) {
                for (let u = uMin; u <= uMax; u += 1) {
                  const idx = cdp.indices[v * CDP_WIDTH + u] ?? 0;
                  if ((emptyMask & (1 << idx)) !== 0) {
                    partialFfffTexelHits += 1;
                  }
                }
              }
            }
          };

          for (const tri of lod.polygons.uvTriangles) {
            checkUvPoly(tri, false);
          }
          for (const quad of lod.polygons.uvQuads) {
            checkUvPoly(quad, true);
          }
        }
      }

      // Re-verify the single daytime all-0xFFFF quirk has non-empty illuminated night palette
      for (const [key, pair] of pairs) {
        if (!key.endsWith(':day') || pair.model === undefined || pair.texture === undefined) {
          continue;
        }
        const cdo = parseCdo(
          await gunzip(await cachedSource.read(pair.model.address, pair.model.address + pair.model.size)),
        );
        const cdp = parseCdp(
          await gunzip(
            await cachedSource.read(pair.texture.address, pair.texture.address + pair.texture.size),
          ),
        );
        const slot0 = cdp.colorSlots[0];
        if (slot0 === undefined) continue;
        const hasAllFfffRef = cdo.lods.some((lod) =>
          [...lod.polygons.uvTriangles, ...lod.polygons.uvQuads].some((poly) => {
            const palIdx = (poly.paletteRaw >>> 4) + (poly.paletteRaw & 0x3f);
            return slot0.emptyPalettes[palIdx] === true;
          }),
        );
        if (hasAllFfffRef) {
          const nightTex = pairs.get(key.replace(':day', ':night'))?.texture;
          expect(nightTex).toBeDefined();
          if (nightTex !== undefined) {
            const cnp = parseCdp(
              await gunzip(await cachedSource.read(nightTex.address, nightTex.address + nightTex.size)),
            );
            expect(cnp.colorSlots[0]?.emptyPalettes[12]).toBe(false);
            expect(cnp.colorSlots[0]?.illuminationMasks[12]).toBeGreaterThan(0);
            allFfffNightFixedCount += 1;
          }
        }
      }

      expect(uvPolyTotal).toBe(761_689);
      expect(observedPaletteRaw.size).toBe(15);
      expect(rfBit2AndPal14BijectionErrors).toBe(0);
      expect(rfBit2Matches).toBe(21_941);
      expect(palette14Matches).toBe(21_941);
      expect(rf12Neg).toBe(0);
      expect(rf12Pos).toBeGreaterThan(19_000);
      expect(singleSidedPos / (singleSidedPos + singleSidedNeg)).toBeGreaterThan(0.995);
      expect(uvQuadSameSign / (uvQuadSameSign + uvQuadOppSign)).toBeGreaterThan(0.995);
      expect(partialFfffTexelHits).toBe(0);
      expect(allFfffDayHitCount).toBe(4);
      expect(allFfffNightFixedCount).toBe(1);
    },
    120_000,
  );
});
