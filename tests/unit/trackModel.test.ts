import { describe, expect, it } from 'vitest';
import {
  TrackError,
  buildTrackModel,
  parseTro,
  parseTrp,
  type TrackMeshPart,
} from '../../src/formats/track';
import { buildSyntheticTro } from '../fixtures/buildTro';
import { buildSyntheticTrp, encodeClutWord, encodeTpageWord, pack4BppPixels } from '../fixtures/buildTrp';

function computeTriangleNormal(part: TrackMeshPart, triIdx: number): [number, number, number] {
  const i0 = part.indices[triIdx * 3]! * 3;
  const i1 = part.indices[triIdx * 3 + 1]! * 3;
  const i2 = part.indices[triIdx * 3 + 2]! * 3;
  const ax = part.positions[i1]! - part.positions[i0]!;
  const ay = part.positions[i1 + 1]! - part.positions[i0 + 1]!;
  const az = part.positions[i1 + 2]! - part.positions[i0 + 2]!;
  const bx = part.positions[i2]! - part.positions[i0]!;
  const by = part.positions[i2 + 1]! - part.positions[i0 + 1]!;
  const bz = part.positions[i2 + 2]! - part.positions[i0 + 2]!;
  return [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx];
}

describe('buildTrackModel (M8.4)', () => {
  it('normalizes subMesh0 CW and subMesh1 CCW horizontal quads to upward +Y CCW, preserves Gouraud corner colors, and batches across multiple CLUTs on one page', () => {
    const pal0 = new Array<number>(16).fill(0x001f);
    const pal1 = new Array<number>(16).fill(0x03e0);
    const px = pack4BppPixels(32, 32, (x, y) => (x + y) & 0x0f);

    const trp = parseTrp(
      buildSyntheticTrp({
        tims: [
          {
            pixelMode: 0,
            clutPalettes: [pal0, pal1],
            clutVramX: 640,
            clutVramY: 480,
            imageVramX: 640,
            imageVramY: 0,
            imageVramWidth: 8,
            imageHeight: 32,
            pixelData: px,
          },
        ],
      }),
    );

    const tpage10 = encodeTpageWord(10, 0);
    const clut0 = encodeClutWord(640, 480);
    const clut1 = encodeClutWord(640, 481);

    // Raw TRO ground quad in XY plane (Z=0): CW perimeter from above (+Z):
    // (0,0,0) -> (0,64,0) -> (64,64,0) -> (64,0,0) has cross nz < 0 (raw subMesh0 CW).
    // Reversed perimeter (CCW from above) for subMesh1:
    // (0,0,0) -> (64,0,0) -> (64,64,0) -> (0,64,0) has cross nz > 0.
    const tro = parseTro(
      buildSyntheticTro({
        trackLengthRaw: 65536 * 50,
        uvEntries: [
          { hiRes: { u: [0, 0, 15, 15], v: [0, 15, 15, 0], clutRaw: clut0, tpageRaw: tpage10 } },
          { hiRes: { u: [16, 16, 31, 31], v: [0, 15, 15, 0], clutRaw: clut1, tpageRaw: tpage10 } },
        ],
        segments: [
          {
            centerRaw: [0, 0, 0],
            subMesh0: {
              localVertices: [
                [0, 0, 0],
                [0, 64, 0],
                [64, 64, 0],
                [64, 0, 0],
                [128, 0, 0],
                [128, 64, 0],
              ],
              polygons: [
                // Two textured quads on the SAME texture page (10, 0) but DIFFERENT CLUTs (0 vs 1):
                // Must merge into ONE TrackMeshPart batch!
                { listIndex: 6, vertices: [0, 1, 2, 3], uvIndex: 0, colors: [{ r: 128, g: 128, b: 128 }] },
                {
                  listIndex: 8,
                  vertices: [3, 2, 5, 4],
                  uvIndex: 1,
                  colors: [
                    { r: 10, g: 20, b: 30 },
                    { r: 40, g: 50, b: 60 },
                    { r: 70, g: 80, b: 90 },
                    { r: 100, g: 110, b: 120 },
                  ],
                },
                // Untextured triangle: separate untextured batch
                { listIndex: 1, vertices: [0, 1, 2], colors: [{ r: 255, g: 0, b: 0 }] },
              ],
            },
            subMesh1: {
              localVertices: [
                [0, 0, 0],
                [64, 0, 0],
                [64, 64, 0],
                [0, 64, 0],
              ],
              polygons: [
                { listIndex: 6, vertices: [0, 1, 2, 3], uvIndex: 0, colors: [{ r: 128, g: 128, b: 128 }] },
              ],
            },
          },
          {
            // Segment 1: only1 fallback (subMesh0 empty, subMesh1 non-empty)
            centerRaw: [128, 0, 0],
            subMesh0: { localVertices: [], polygons: [] },
            subMesh1: {
              localVertices: [
                [64, 0, 0],
                [128, 0, 0],
                [128, 64, 0],
              ],
              polygons: [
                { listIndex: 5, vertices: [0, 1, 2], uvIndex: 1, colors: [{ r: 128, g: 128, b: 128 }] },
              ],
            },
          },
        ],
      }),
    );

    const model = buildTrackModel(tro, trp);
    expect(model.coordinateSystem).toEqual({
      right: '+X',
      up: '+Y',
      forward: '-Z',
      unitsPerMeter: 64,
      unitMeters: 1 / 64,
      windingOrder: 'ccw',
    });
    expect(model.trackLengthMeters).toBe(50);
    expect(model.startGrid).toEqual([]);
    expect(model.checkpoints).toEqual([]);
    expect(model.textureAtlas).not.toBeNull();
    expect(model.textureAtlas!.pages).toHaveLength(1);
    expect(model.textureAtlas!.palettes).toHaveLength(2);

    // Segment 0 has 1 textured batch (combining CLUT 0 + CLUT 1!) + 1 untextured batch = 2 parts
    // Segment 1 has 1 lod1-fallback textured batch = 1 part
    expect(model.segments[0]!.subMeshRole).toBe('lod0');
    expect(model.segments[0]!.primaryPartCount).toBe(2);
    expect(model.segments[1]!.subMeshRole).toBe('lod1-fallback');
    expect(model.segments[1]!.primaryPartCount).toBe(1);
    expect(model.render).toHaveLength(3);

    const seg0Textured = model.render.find((p) => p.segmentIndex === 0 && p.textured)!;
    expect(seg0Textured.triangleCount).toBe(4);
    expect(seg0Textured.texturePageIndex).toBe(0);
    // Both CLUTs present as per-vertex paletteIndices inside the single batch!
    expect(new Set(seg0Textured.paletteIndices)).toEqual(new Set([0, 1]));

    // Verify all triangles in both subMesh0 (lod0) and subMesh1 (lod1 + lod1-fallback) face +Y up!
    for (const part of [...model.render, ...model.lod1Render]) {
      for (let ti = 0; ti < part.triangleCount; ti += 1) {
        const [, ny] = computeTriangleNormal(part, ti);
        expect(ny).toBeGreaterThan(0);
      }
    }

    // Verify bounds in meters: X=[0, 2], Y=[0, 0], Z=[-1, 0]
    expect(model.bounds.min.x).toBeCloseTo(0, 6);
    expect(model.bounds.max.x).toBeCloseTo(2, 6);
    expect(model.bounds.min.z).toBeCloseTo(-1, 6);
    expect(model.bounds.max.z).toBeCloseTo(0, 6);
  });

  it('supports building geometry without TRP and rejects missing VRAM references when strictVram=true', () => {
    const tpage10 = encodeTpageWord(10, 0);
    const clut0 = encodeClutWord(640, 480);
    const tro = parseTro(
      buildSyntheticTro({
        uvEntries: [{ hiRes: { u: [0, 1, 1, 0], v: [0, 0, 1, 1], clutRaw: clut0, tpageRaw: tpage10 } }],
        segments: [
          {
            centerRaw: [0, 0, 0],
            subMesh0: {
              localVertices: [
                [0, 0, 0],
                [64, 0, 0],
                [64, 64, 0],
              ],
              polygons: [{ listIndex: 5, vertices: [0, 1, 2], uvIndex: 0, colors: [{ r: 128, g: 128, b: 128 }] }],
            },
            subMesh1: { localVertices: [], polygons: [] },
          },
        ],
      }),
    );

    const noTrpModel = buildTrackModel(tro);
    expect(noTrpModel.textureAtlas).toBeNull();
    expect(noTrpModel.render[0]!.texturePageIndex).toBeNull();

    // TRP pointing to a different VRAM region -> strictVram throws MissingVramResource
    const unrelatedTrp = parseTrp(
      buildSyntheticTrp({
        tims: [
          {
            pixelMode: 0,
            clutPalettes: [new Array<number>(16).fill(0)],
            clutVramX: 704,
            clutVramY: 480,
            imageVramX: 704,
            imageVramY: 0,
            imageVramWidth: 1,
            imageHeight: 1,
            pixelData: pack4BppPixels(4, 1, () => 0),
          },
        ],
      }),
    );
    expect(() => buildTrackModel(tro, unrelatedTrp)).toThrowError(TrackError);
  });
});
