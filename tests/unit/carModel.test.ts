import { describe, expect, it } from 'vitest';
import {
  CAR_PALETTE_COUNT,
  CAR_RENDER_FLAG_PALETTE_14,
  CAR_RENDER_FLAG_SINGLE_SIDED,
  CAR_WHEEL_SLOTS,
  CarModelError,
  buildCarModel,
  decodeCdoPaletteIndex,
  selectCarModelPaint,
  triangulateCdoQuadIndices,
  withCarModelTexture,
} from '../../src/formats/car';
import {
  CDO_FACE_TYPE_QUAD,
  CDO_FACE_TYPE_TRI,
  CDO_FACE_TYPE_UV_QUAD,
  CDO_FACE_TYPE_UV_QUAD_MODULATED,
  CDO_FACE_TYPE_UV_TRI,
  CDO_FIXED_POINT_SCALE,
  parseCdo,
} from '../../src/formats/car/cdo';
import { parseCdp } from '../../src/formats/car/cdp';
import { buildSyntheticCdo } from '../fixtures/buildCdo';
import { buildEmptyCdpPalette, buildSyntheticCdp } from '../fixtures/buildCdp';

describe('CarModel conversion (M6.8)', () => {
  it('decodes all 15 observed CDO paletteRaw values and rejects out-of-range inputs', () => {
    const expected: readonly (readonly [number, number])[] = [
      [0x0000, 0],
      [0x0001, 1],
      [0x0002, 2],
      [0x0003, 3],
      [0x0040, 4],
      [0x0041, 5],
      [0x0042, 6],
      [0x0043, 7],
      [0x0080, 8],
      [0x0081, 9],
      [0x0082, 10],
      [0x0083, 11],
      [0x00c0, 12],
      [0x00c1, 13],
      [0x00c2, 14],
      [0x00c3, 15],
    ];

    for (const [raw, palIdx] of expected) {
      expect(decodeCdoPaletteIndex(raw)).toBe(palIdx);
    }

    expect(() => decodeCdoPaletteIndex(-1)).toThrowError(CarModelError);
    expect(() => decodeCdoPaletteIndex(0x100)).toThrowError(CarModelError);
    expect(() => decodeCdoPaletteIndex(0x00c4)).toThrowError(CarModelError);
  });

  it('triangulates perimeter quads into (0,1,2) and (0,2,3) CCW triangles', () => {
    const [t1, t2] = triangulateCdoQuadIndices(10, 20, 30, 40);
    expect(t1).toEqual([10, 20, 30]);
    expect(t2).toEqual([10, 30, 40]);
  });

  it('converts CDO geometry, wheels, LODs, shadow, raw texel UVs, faceType, and modulated quads', () => {
    const sampleVerts: readonly (readonly [number, number, number, number])[] = [
      [-2000, 0, -4000, 0],
      [2000, 0, -4000, 0],
      [2000, 1500, 4000, 0],
      [-2000, 1500, 4000, 0],
    ];
    const sampleNorms: readonly (readonly [number, number, number])[] = [
      [0, 500, 0],
      [0, 0, 500],
      [500, 0, 0],
      [-500, 0, 0],
    ];

    const cdo = parseCdo(
      buildSyntheticCdo({
        lods: [
          {
            maxDistance: 5,
            vertices: sampleVerts,
            normals: sampleNorms,
            triangles: [
              {
                vertices: [0, 1, 2, 0],
                normals: [0, 1, 2, 0],
                faceType: CDO_FACE_TYPE_TRI,
                color24: 0x334455,
              },
            ],
            quads: [
              {
                vertices: [0, 1, 2, 3],
                normals: [0, 1, 2, 3],
                faceType: CDO_FACE_TYPE_QUAD,
                color24: 0x112233,
              },
            ],
            uvTriangles: [
              {
                vertices: [0, 2, 3, 0],
                normals: [0, 2, 3, 0],
                faceType: CDO_FACE_TYPE_UV_TRI,
                paletteRaw: 0x0001,
                uvs: [
                  [10, 20],
                  [100, 20],
                  [100, 120],
                  [0, 0],
                ],
              },
            ],
            uvQuads: [
              {
                vertices: [0, 1, 2, 3],
                normals: [0, 1, 2, 3],
                faceType: CDO_FACE_TYPE_UV_QUAD,
                renderFlags: CAR_RENDER_FLAG_SINGLE_SIDED,
                renderOrder: 16,
                color24: 0x808080,
                paletteRaw: 0x0042, // palette 6
                uvs: [
                  [0, 0],
                  [255, 0],
                  [255, 223],
                  [0, 223],
                ],
              },
              {
                vertices: [0, 1, 2, 3],
                normals: [0, 1, 2, 3],
                faceType: CDO_FACE_TYPE_UV_QUAD_MODULATED,
                renderFlags: CAR_RENDER_FLAG_PALETTE_14, // double-sided + palette 14
                renderOrder: 10,
                color24: 0x5f5045,
                paletteRaw: 0x00c2, // palette 14
                uvs: [
                  [12, 34],
                  [56, 34],
                  [56, 78],
                  [12, 78],
                ],
              },
            ],
          },
          { maxDistance: 15, vertices: sampleVerts, normals: sampleNorms },
          { maxDistance: 300, vertices: sampleVerts, normals: sampleNorms },
        ],
      }),
    );

    const car = buildCarModel(cdo);

    expect(car.windingOrder).toBe('ccw');
    expect(car.coordinateSystem).toEqual({
      right: '+X',
      up: '+Y',
      forward: '-Z',
      unitMeters: 1 / CDO_FIXED_POINT_SCALE,
    });
    expect(car.texture).toBeNull();
    expect(car.lods).toHaveLength(3);
    expect(car.shadow.endOffset).toBe(cdo.byteLength);

    // 4 wheels in FL, FR, RL, RR order
    expect(car.wheels.map((w) => w.slot)).toEqual([...CAR_WHEEL_SLOTS]);
    expect(car.wheels[0].axle).toBe('front');
    expect(car.wheels[0].side).toBe('left');
    expect(car.wheels[0].positionRaw.x).toBeLessThan(0);
    expect(car.wheels[0].positionRaw.z).toBeLessThan(0);
    expect(car.wheels[3].axle).toBe('rear');
    expect(car.wheels[3].side).toBe('right');
    expect(car.wheels[3].positionRaw.x).toBeGreaterThan(0);
    expect(car.wheels[3].positionRaw.z).toBeGreaterThan(0);
    expect(car.wheels[0].radiusMeters).toBeCloseTo(
      cdo.header.menuWheels.frontRadius / CDO_FIXED_POINT_SCALE,
      6,
    );

    const lod0 = car.lods[0];
    expect(lod0).toBeDefined();
    if (lod0 === undefined) {
      return;
    }

    expect(lod0.maxDistance).toBe(5);
    expect(lod0.rawVerticesInt16).toBeInstanceOf(Int16Array);
    expect(lod0.positionsMeters).toBeInstanceOf(Float32Array);
    expect(lod0.normals).toBeInstanceOf(Float32Array);

    // 1 triangle (faceType 32) + 1 quad split into 2 triangles (faceType 40) = 3 untextured tris
    expect(lod0.untexturedTriangles).toHaveLength(3);
    expect(lod0.untexturedTriangles[0]?.faceType).toBe(CDO_FACE_TYPE_TRI);
    expect(lod0.untexturedTriangles[0]?.sourceQuad).toBe(false);
    expect(lod0.untexturedTriangles[1]?.faceType).toBe(CDO_FACE_TYPE_QUAD);
    expect(lod0.untexturedTriangles[1]?.sourceQuad).toBe(true);
    expect(lod0.untexturedTriangles[1]?.vertices).toEqual([0, 1, 2]);
    expect(lod0.untexturedTriangles[2]?.vertices).toEqual([0, 2, 3]);

    // 1 uvTri (faceType 37) + 2 uvQuads (4 tris: 2x faceType 45 + 2x faceType 44) = 5 textured tris
    expect(lod0.texturedTriangles).toHaveLength(5);
    expect(lod0.texturedTriangles[0]?.faceType).toBe(CDO_FACE_TYPE_UV_TRI);
    expect(lod0.texturedTriangles[0]?.modulated).toBe(false);

    // Raw texel UVs preserved (NOT divided by 255)
    const q1a = lod0.texturedTriangles[1];
    const q1b = lod0.texturedTriangles[2];
    expect(q1a?.uvs).toEqual([
      { u: 0, v: 0 },
      { u: 255, v: 0 },
      { u: 255, v: 223 },
    ]);
    expect(q1b?.uvs).toEqual([
      { u: 0, v: 0 },
      { u: 255, v: 223 },
      { u: 0, v: 223 },
    ]);
    expect(q1a?.paletteIndex).toBe(6);
    expect(q1a?.singleSided).toBe(true);
    expect(q1a?.modulated).toBe(false);

    const q2a = lod0.texturedTriangles[3];
    expect(q2a?.faceType).toBe(CDO_FACE_TYPE_UV_QUAD_MODULATED);
    expect(q2a?.modulated).toBe(true);
    expect(q2a?.singleSided).toBe(false);
    expect(q2a?.paletteIndex).toBe(14);
    expect(q2a?.color.raw24).toBe(0x5f5045);

    // faceType 44 in synthetic CDO produces one expected CDO parser warning
    expect(car.warnings).toHaveLength(1);
    expect(car.warnings[0]).toContain('faceType 44');
  });

  it('binds day/night CDP textures, warns on all-0xFFFF palette references, and switches paint slots', () => {
    const sampleVerts: readonly (readonly [number, number, number, number])[] = [
      [-2000, 0, -4000, 0],
      [2000, 0, -4000, 0],
      [2000, 1500, 4000, 0],
    ];
    const sampleNorms: readonly (readonly [number, number, number])[] = [
      [0, 500, 0],
      [0, 0, 500],
      [500, 0, 0],
    ];

    const cdo = parseCdo(
      buildSyntheticCdo({
        lods: [
          {
            maxDistance: 5,
            vertices: sampleVerts,
            normals: sampleNorms,
            uvTriangles: [
              {
                vertices: [0, 1, 2, 0],
                normals: [0, 1, 2, 0],
                faceType: CDO_FACE_TYPE_UV_TRI,
                paletteRaw: 0x00c0, // palette 12
                uvs: [
                  [4, 4],
                  [16, 4],
                  [16, 16],
                  [0, 0],
                ],
              },
            ],
          },
          { maxDistance: 15, vertices: sampleVerts, normals: sampleNorms },
          { maxDistance: 300, vertices: sampleVerts, normals: sampleNorms },
        ],
      }),
    );

    const dayPalettes: number[][] = [];
    const nightPalettes: number[][] = [];
    for (let p = 0; p < CAR_PALETTE_COUNT; p += 1) {
      dayPalettes.push(p === 12 ? buildEmptyCdpPalette() : new Array<number>(16).fill(0x0421));
      nightPalettes.push(new Array<number>(16).fill(0x3def));
    }

    const dayCdp = parseCdp(
      buildSyntheticCdp({
        colorCount: 2,
        slots: [
          { colorId: 'a'.charCodeAt(0), palettes: dayPalettes },
          { colorId: 'b'.charCodeAt(0), palettes: dayPalettes },
        ],
      }),
    );
    const nightCnp = parseCdp(
      buildSyntheticCdp({
        colorCount: 2,
        slots: [
          { colorId: 'a'.charCodeAt(0), palettes: nightPalettes },
          { colorId: 'b'.charCodeAt(0), palettes: nightPalettes },
        ],
      }),
    );

    const unbound = buildCarModel(cdo);
    expect(() => selectCarModelPaint(unbound, 0)).toThrowError(CarModelError);

    const dayCar = buildCarModel(cdo, { texture: dayCdp, variant: 'day', colorSlotIndex: 0 });
    expect(dayCar.texture?.variant).toBe('day');
    expect(dayCar.texture?.colorSlotIndex).toBe(0);
    expect(dayCar.texture?.colorSlot.colorIdChar).toBe('a');
    expect(dayCar.texture?.indexedImage.palettes[12]?.[0]).toBe(0x0000);
    expect(dayCar.warnings.some((w) => w.includes('palette 12'))).toBe(true);

    // Switch paint slot on day car
    const dayPaint1 = selectCarModelPaint(dayCar, 1);
    expect(dayPaint1.texture?.colorSlotIndex).toBe(1);
    expect(dayPaint1.texture?.colorSlot.colorIdChar).toBe('b');

    expect(() => selectCarModelPaint(dayCar, 2)).toThrowError(CarModelError);

    // Switch to night texture where palette 12 is populated: empty-palette warning clears cleanly
    const nightCar = withCarModelTexture(dayPaint1, nightCnp, {
      variant: 'night',
      colorSlotIndex: 1,
    });
    expect(nightCar.texture?.variant).toBe('night');
    expect(nightCar.texture?.colorSlotIndex).toBe(1);
    expect(nightCar.texture?.indexedImage.palettes[12]?.[0]).toBe(0x3def);
    expect(nightCar.warnings).toEqual([]);
  });
});
