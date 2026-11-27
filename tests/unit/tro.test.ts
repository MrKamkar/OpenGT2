import { describe, expect, it } from 'vitest';
import { TRO_MAGIC, TrackError, parseTro } from '../../src/formats/track';
import { buildSyntheticTro } from '../fixtures/buildTro';
import { encodeClutWord, encodeTpageWord } from '../fixtures/buildTrp';

describe('TRO track geometry parser (M8.4)', () => {
  it('parses segments, cell origins across 4096 boundaries, all polygon lists 1..8, UV table, and subBlock98 walls', () => {
    const clutRaw = encodeClutWord(640, 480);
    const tpageRaw = encodeTpageWord(10, 0);

    const bytes = buildSyntheticTro({
      trackLengthRaw: 65536 * 100,
      uvEntries: [
        {
          hiRes: {
            u: [0, 15, 15, 0],
            v: [0, 0, 15, 15],
            clutRaw,
            tpageRaw,
            unk0x0C: 123,
          },
          mipmap: {
            u: [16, 23, 23, 16],
            v: [0, 0, 7, 7],
            clutRaw,
            tpageRaw,
          },
        },
      ],
      segments: [
        {
          // centerRaw = (4200, 0, 0) => (4200 * 1024) >> 22 = 1 => cellOrigin = (4096, 0, 0)
          centerRaw: [4200, 0, 0],
          subMesh0: {
            localVertices: [
              [0, 0, 0],
              [64, 0, 0],
              [64, 64, 0],
              [0, 64, 0],
            ],
            polygons: [
              { listIndex: 1, vertices: [0, 1, 2], colors: [{ r: 10, g: 20, b: 30 }], unk5: 5, unkFlags: 0x20 },
              { listIndex: 2, vertices: [0, 1, 2, 3], colors: [{ r: 40, g: 50, b: 60 }] },
              {
                listIndex: 3,
                vertices: [0, 1, 2],
                colors: [
                  { r: 1, g: 2, b: 3 },
                  { r: 4, g: 5, b: 6 },
                  { r: 7, g: 8, b: 9 },
                ],
              },
              {
                listIndex: 4,
                vertices: [0, 1, 2, 3],
                colors: [
                  { r: 10, g: 11, b: 12 },
                  { r: 13, g: 14, b: 15 },
                  { r: 16, g: 17, b: 18 },
                  { r: 19, g: 20, b: 21 },
                ],
              },
              { listIndex: 5, vertices: [0, 1, 2], uvIndex: 0, colors: [{ r: 128, g: 128, b: 128 }] },
              { listIndex: 6, vertices: [0, 1, 2, 3], uvIndex: 0, colors: [{ r: 120, g: 125, b: 130 }] },
              {
                listIndex: 7,
                vertices: [0, 1, 2],
                uvIndex: 0,
                colors: [
                  { r: 100, g: 101, b: 102 },
                  { r: 110, g: 111, b: 112 },
                  { r: 120, g: 121, b: 122 },
                ],
              },
              {
                listIndex: 8,
                vertices: [0, 1, 2, 3],
                uvIndex: 0,
                colors: [
                  { r: 200, g: 201, b: 202 },
                  { r: 210, g: 211, b: 212 },
                  { r: 220, g: 221, b: 222 },
                  { r: 230, g: 231, b: 232 },
                ],
              },
            ],
            list9Count: 2,
            list10Count: 1,
          },
          subMesh1: {
            localVertices: [
              [0, 0, 0],
              [64, 64, 0],
              [64, 0, 0],
            ],
            polygons: [{ listIndex: 5, vertices: [0, 1, 2], uvIndex: 0, colors: [{ r: 128, g: 128, b: 128 }] }],
          },
          walls2D: [{ v0: 0, v1: 1, nxFixed12: 0, nyFixed12: 4096 }],
        },
      ],
    });

    const tro = parseTro(bytes);
    expect(tro.header.magic).toBe(TRO_MAGIC);
    expect(tro.segmentCount).toBe(1);
    expect(tro.uvCount).toBe(1);
    expect(tro.warnings).toEqual([]);
    expect(tro.uvTable[0]!.hiRes.clutX).toBe(640);
    expect(tro.uvTable[0]!.hiRes.clutY).toBe(480);
    expect(tro.uvTable[0]!.hiRes.vramX).toBe(640);
    expect(tro.uvTable[0]!.hiRes.unk0x0C).toBe(123);
    expect(tro.uvTable[0]!.mipmap.u).toEqual([16, 23, 23, 16]);

    const seg = tro.segments[0]!;
    expect(seg.cellOriginRaw).toEqual({ x: 4096, y: 0, z: 0 });
    expect(seg.subMesh0.vertexCount).toBe(4);
    expect(Array.from(seg.subMesh0.worldVerticesRaw.subarray(0, 6))).toEqual([4096, 0, 0, 4160, 0, 0]);
    expect(seg.subMesh0.polygons).toHaveLength(8);
    expect(seg.subMesh0.list9Count).toBe(2);
    expect(seg.subMesh0.list10Count).toBe(1);
    expect(seg.subMesh0.polygons[0]!.unk5).toBe(5);
    expect(seg.subMesh0.polygons[0]!.unkFlags).toBe(0x20);
    expect(seg.subMesh0.polygons[3]!.colors).toHaveLength(4);
    expect(seg.subMesh0.polygons[7]!.colors[3]).toEqual({ r: 230, g: 231, b: 232 });
    expect(seg.walls2D).toEqual([{ v0: 0, v1: 1, nxFixed12: 0, nyFixed12: 4096 }]);
  });

  it('rejects bad magic, truncated buffers, unsupported tpage depth, OOB indices, bad GPU tags, and invalid walls', () => {
    expect(() => parseTro(new Uint8Array(10))).toThrowError(TrackError);

    expect(() =>
      parseTro(buildSyntheticTro({ magicOverride: 'BAD-MAGIC-00', uvEntries: [], segments: [] })),
    ).toThrowError(/Invalid TRO magic/i);

    // Unsupported tpage colorDepth (1 = 8 bpp)
    expect(() =>
      parseTro(
        buildSyntheticTro({
          uvEntries: [
            {
              hiRes: {
                u: [0, 1, 1, 0],
                v: [0, 0, 1, 1],
                clutRaw: encodeClutWord(640, 480),
                tpageRaw: encodeTpageWord(10, 0, 0, 1),
              },
            },
          ],
          segments: [],
        }),
      ),
    ).toThrowError(/colorDepth/i);

    // Non-zero pad0x2e in subMesh header
    expect(() =>
      parseTro(
        buildSyntheticTro({
          uvEntries: [],
          segments: [
            {
              centerRaw: [0, 0, 0],
              subMesh0: { localVertices: [], polygons: [], pad0x2eOverride: 1 },
              subMesh1: { localVertices: [], polygons: [] },
            },
          ],
        }),
      ),
    ).toThrowError(/pad0x2e/i);

    // Vertex index OOB
    expect(() =>
      parseTro(
        buildSyntheticTro({
          uvEntries: [],
          segments: [
            {
              centerRaw: [0, 0, 0],
              subMesh0: {
                localVertices: [
                  [0, 0, 0],
                  [1, 0, 0],
                  [0, 1, 0],
                ],
                polygons: [{ listIndex: 1, vertices: [0, 1, 99], colors: [{ r: 1, g: 2, b: 3 }] }],
              },
              subMesh1: { localVertices: [], polygons: [] },
            },
          ],
        }),
      ),
    ).toThrowError(/vertex index/i);

    // Non-zero v3 on triangle
    expect(() =>
      parseTro(
        buildSyntheticTro({
          uvEntries: [],
          segments: [
            {
              centerRaw: [0, 0, 0],
              subMesh0: {
                localVertices: [
                  [0, 0, 0],
                  [1, 0, 0],
                  [0, 1, 0],
                ],
                polygons: [{ listIndex: 1, vertices: [0, 1, 2, 1], colors: [{ r: 1, g: 2, b: 3 }] }],
              },
              subMesh1: { localVertices: [], polygons: [] },
            },
          ],
        }),
      ),
    ).toThrowError(/non-zero v3/i);

    // UV index OOB
    expect(() =>
      parseTro(
        buildSyntheticTro({
          uvEntries: [],
          segments: [
            {
              centerRaw: [0, 0, 0],
              subMesh0: {
                localVertices: [
                  [0, 0, 0],
                  [1, 0, 0],
                  [0, 1, 0],
                ],
                polygons: [{ listIndex: 5, vertices: [0, 1, 2], uvIndex: 0, colors: [{ r: 1, g: 2, b: 3 }] }],
              },
              subMesh1: { localVertices: [], polygons: [] },
            },
          ],
        }),
      ),
    ).toThrowError(/uvIndex/i);

    // Invalid GPU tag
    expect(() =>
      parseTro(
        buildSyntheticTro({
          uvEntries: [],
          segments: [
            {
              centerRaw: [0, 0, 0],
              subMesh0: {
                localVertices: [
                  [0, 0, 0],
                  [1, 0, 0],
                  [0, 1, 0],
                ],
                polygons: [
                  { listIndex: 1, vertices: [0, 1, 2], colors: [{ r: 1, g: 2, b: 3 }], gpuTagOverride: 0x99 },
                ],
              },
              subMesh1: { localVertices: [], polygons: [] },
            },
          ],
        }),
      ),
    ).toThrowError(/GPU tag/i);

    // Wall vertex OOB & extra wall block bytes
    expect(() =>
      parseTro(
        buildSyntheticTro({
          uvEntries: [],
          segments: [
            {
              centerRaw: [0, 0, 0],
              subMesh0: { localVertices: [[0, 0, 0]], polygons: [] },
              subMesh1: { localVertices: [], polygons: [] },
              walls2D: [{ v0: 0, v1: 5, nxFixed12: 4096, nyFixed12: 0 }],
            },
          ],
        }),
      ),
    ).toThrowError(/subMesh0\.vertexCount/i);

    expect(() =>
      parseTro(
        buildSyntheticTro({
          uvEntries: [],
          segments: [
            {
              centerRaw: [0, 0, 0],
              subMesh0: { localVertices: [[0, 0, 0]], polygons: [] },
              subMesh1: { localVertices: [], polygons: [] },
              wallBlockExtraBytes: 4,
            },
          ],
        }),
      ),
    ).toThrowError(/subBlock98 size mismatch/i);
  });
});
