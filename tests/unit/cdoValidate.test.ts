import { describe, expect, it } from 'vitest';
import {
  CDO_FACE_TYPE_QUAD,
  CDO_FACE_TYPE_TRI,
  CDO_FACE_TYPE_UV_QUAD,
  CDO_FACE_TYPE_UV_QUAD_MODULATED,
  CDO_FACE_TYPE_UV_TRI,
  CDO_MAX_FILE_SIZE,
  CdoError,
  type CdoErrorCode,
  parseCdo,
} from '../../src/formats/car/cdo';
import { buildSyntheticCdo, type SyntheticCdoLodInput } from '../fixtures/buildCdo';

function expectCdoError(fn: () => unknown, expectedCode: CdoErrorCode): void {
  try {
    fn();
    expect.fail(`Expected CdoError.${expectedCode}`);
  } catch (error) {
    expect(error).toBeInstanceOf(CdoError);
    expect((error as CdoError).code).toBe(expectedCode);
  }
}

function validSingleLod(overrides: Partial<SyntheticCdoLodInput> = {}): SyntheticCdoLodInput {
  return {
    maxDistance: 5,
    vertices: [
      [-100, -100, -100, 0],
      [100, -100, -100, 0],
      [100, 100, 100, 0],
      [-100, 100, 100, 0],
    ],
    normals: [
      [0, 500, 0],
      [500, 0, 0],
    ],
    triangles: [{ vertices: [0, 1, 2, 0], normals: [0, 1, 0, 0], faceType: CDO_FACE_TYPE_TRI }],
    quads: [{ vertices: [0, 1, 2, 3], normals: [0, 1, 0, 1], faceType: CDO_FACE_TYPE_QUAD }],
    uvTriangles: [
      {
        vertices: [0, 1, 2, 0],
        normals: [0, 1, 0, 0],
        faceType: CDO_FACE_TYPE_UV_TRI,
        uvs: [
          [0, 0],
          [16, 0],
          [16, 16],
          [0, 0],
        ],
      },
    ],
    uvQuads: [
      {
        vertices: [0, 1, 2, 3],
        normals: [0, 1, 0, 1],
        faceType: CDO_FACE_TYPE_UV_QUAD,
        uvs: [
          [0, 0],
          [16, 0],
          [16, 16],
          [0, 16],
        ],
      },
    ],
    ...overrides,
  };
}

describe('CDO full parser and D.6 validators (M6.6)', () => {
  it('parses and validates a complete 3-LOD synthetic CDO with zero warnings', () => {
    const buf = buildSyntheticCdo();
    const model = parseCdo(buf);

    expect(model.byteLength).toBe(buf.byteLength);
    expect(model.byteLength).toBeLessThanOrEqual(CDO_MAX_FILE_SIZE);
    expect(model.warnings).toEqual([]);
    expect(model.lodTable.lodCount).toBe(3);
    expect(model.lods.length).toBe(3);
    expect(model.lods[0]?.polygons.triangles.length).toBe(1);
    expect(model.lods[0]?.polygons.quads.length).toBe(1);
    expect(model.lods[0]?.polygons.uvTriangles.length).toBe(1);
    expect(model.lods[0]?.polygons.uvQuads.length).toBe(1);
    expect(model.shadow.endOffset).toBe(model.byteLength);
  });

  it('rejects files exceeding 0x5000 bytes with CdoError.FileTooLarge', () => {
    const oversized = new Uint8Array(CDO_MAX_FILE_SIZE + 1);
    oversized[0] = 0x47;
    oversized[1] = 0x54;
    oversized[2] = 0x02;
    expectCdoError(() => parseCdo(oversized), CdoError.FileTooLarge);
  });

  it('emits a non-fatal warning when lodCount !== 3', () => {
    const buf = buildSyntheticCdo({
      lods: [validSingleLod({ maxDistance: 5 }), validSingleLod({ maxDistance: 300 })],
    });
    const model = parseCdo(buf);
    expect(model.lods.length).toBe(2);
    expect(model.warnings.some((w) => w.includes('Expected 3 LODs'))).toBe(true);
  });

  it('rejects LOD headers with verticesOffset !== 0x50', () => {
    const buf = buildSyntheticCdo({
      lods: [validSingleLod({ verticesOffset: 0x54 }), validSingleLod(), validSingleLod()],
    });
    expectCdoError(() => parseCdo(buf), CdoError.InvalidVerticesOffset);
  });

  it('rejects vertex indices >= vertexCount across triangle and quad lists', () => {
    const badTri = buildSyntheticCdo({
      lods: [
        validSingleLod({
          triangles: [{ vertices: [0, 4, 2, 0], normals: [0, 0, 0, 0], faceType: CDO_FACE_TYPE_TRI }],
        }),
        validSingleLod(),
        validSingleLod(),
      ],
    });
    expectCdoError(() => parseCdo(badTri), CdoError.VertexIndexOutOfBounds);

    const badQuad = buildSyntheticCdo({
      lods: [
        validSingleLod({
          uvQuads: [{ vertices: [0, 1, 2, 4], normals: [0, 0, 0, 0], faceType: CDO_FACE_TYPE_UV_QUAD }],
        }),
        validSingleLod(),
        validSingleLod(),
      ],
    });
    expectCdoError(() => parseCdo(badQuad), CdoError.VertexIndexOutOfBounds);
  });

  it('rejects normal indices >= normalCount when normalCount > 0', () => {
    const buf = buildSyntheticCdo({
      lods: [
        validSingleLod({
          quads: [{ vertices: [0, 1, 2, 3], normals: [0, 1, 2, 0], faceType: CDO_FACE_TYPE_QUAD }],
        }),
        validSingleLod(),
        validSingleLod(),
      ],
    });
    expectCdoError(() => parseCdo(buf), CdoError.NormalIndexOutOfBounds);
  });

  it('accepts normalCount === 0 with all-zero normal indices and warns, but rejects non-zero normal indices', () => {
    const zeroNormalOk = buildSyntheticCdo({
      lods: [
        validSingleLod({
          normals: [],
          triangles: [{ vertices: [0, 1, 2, 0], normals: [0, 0, 0, 0], faceType: CDO_FACE_TYPE_TRI }],
          quads: [{ vertices: [0, 1, 2, 3], normals: [0, 0, 0, 0], faceType: CDO_FACE_TYPE_QUAD }],
          uvTriangles: [
            { vertices: [0, 1, 2, 0], normals: [0, 0, 0, 0], faceType: CDO_FACE_TYPE_UV_TRI },
          ],
          uvQuads: [
            { vertices: [0, 1, 2, 3], normals: [0, 0, 0, 0], faceType: CDO_FACE_TYPE_UV_QUAD },
          ],
        }),
        validSingleLod(),
        validSingleLod(),
      ],
    });
    const parsed = parseCdo(zeroNormalOk);
    expect(parsed.warnings.some((w) => w.includes('normalCount === 0'))).toBe(true);

    const zeroNormalBad = buildSyntheticCdo({
      lods: [
        validSingleLod({
          normals: [],
          triangles: [{ vertices: [0, 1, 2, 0], normals: [0, 1, 0, 0], faceType: CDO_FACE_TYPE_TRI }],
          quads: [],
          uvTriangles: [],
          uvQuads: [],
        }),
        validSingleLod(),
        validSingleLod(),
      ],
    });
    expectCdoError(() => parseCdo(zeroNormalBad), CdoError.NormalIndexOutOfBounds);
  });

  it('rejects normals whose length falls outside [0.95, 1.05]', () => {
    const tooShort = buildSyntheticCdo({
      lods: [validSingleLod({ normals: [[450, 0, 0]] }), validSingleLod(), validSingleLod()],
    });
    expectCdoError(() => parseCdo(tooShort), CdoError.InvalidNormalLength);

    const tooLong = buildSyntheticCdo({
      lods: [validSingleLod({ normals: [[511, 200, 0]] }), validSingleLod(), validSingleLod()],
    });
    expectCdoError(() => parseCdo(tooLong), CdoError.InvalidNormalLength);

    const zeroVec = buildSyntheticCdo({
      lods: [validSingleLod({ normals: [[0, 0, 0]] }), validSingleLod(), validSingleLod()],
    });
    expectCdoError(() => parseCdo(zeroVec), CdoError.InvalidNormalLength);
  });

  it('rejects LOD bounding box mismatches', () => {
    const buf = buildSyntheticCdo({
      lods: [
        validSingleLod({
          boundingBoxOverride: {
            low: [-99, -100, -100, 0],
            high: [100, 100, 100, 0],
          },
        }),
        validSingleLod(),
        validSingleLod(),
      ],
    });
    expectCdoError(() => parseCdo(buf), CdoError.BoundingBoxMismatch);
  });

  it('rejects mismatched or unknown faceType values while permitting faceType 44 on uvQuads with warning', () => {
    const wrongTriType = buildSyntheticCdo({
      lods: [
        validSingleLod({
          triangles: [{ vertices: [0, 1, 2, 0], normals: [0, 0, 0, 0], faceType: CDO_FACE_TYPE_QUAD }],
        }),
        validSingleLod(),
        validSingleLod(),
      ],
    });
    expectCdoError(() => parseCdo(wrongTriType), CdoError.InvalidFaceType);

    const unknownUvQuadType = buildSyntheticCdo({
      lods: [
        validSingleLod({
          uvQuads: [{ vertices: [0, 1, 2, 3], normals: [0, 0, 0, 0], faceType: 99 }],
        }),
        validSingleLod(),
        validSingleLod(),
      ],
    });
    expectCdoError(() => parseCdo(unknownUvQuadType), CdoError.InvalidFaceType);

    const modulatedUvQuad = buildSyntheticCdo({
      lods: [
        validSingleLod({
          uvQuads: [
            {
              vertices: [0, 1, 2, 3],
              normals: [0, 1, 0, 1],
              faceType: CDO_FACE_TYPE_UV_QUAD_MODULATED,
              color24: 0x5f5045,
            },
          ],
        }),
        validSingleLod(),
        validSingleLod(),
      ],
    });
    const parsed = parseCdo(modulatedUvQuad);
    expect(parsed.lods[0]?.polygons.uvQuads[0]?.faceType).toBe(44);
    expect(parsed.warnings.some((w) => w.includes('faceType 44'))).toBe(true);
  });

  it('rejects non-zero v3 on untextured and UV triangles', () => {
    const badUntexTri = buildSyntheticCdo({
      lods: [
        validSingleLod({
          triangles: [{ vertices: [0, 1, 2, 1], normals: [0, 0, 0, 0], faceType: CDO_FACE_TYPE_TRI }],
        }),
        validSingleLod(),
        validSingleLod(),
      ],
    });
    expectCdoError(() => parseCdo(badUntexTri), CdoError.InvalidTriangleVertex3);

    const badUvTri = buildSyntheticCdo({
      lods: [
        validSingleLod({
          uvTriangles: [
            { vertices: [0, 1, 2, 3], normals: [0, 0, 0, 0], faceType: CDO_FACE_TYPE_UV_TRI },
          ],
        }),
        validSingleLod(),
        validSingleLod(),
      ],
    });
    expectCdoError(() => parseCdo(badUvTri), CdoError.InvalidTriangleVertex3);
  });

  it('rejects non-zero uv3 on UV triangles', () => {
    const buf = buildSyntheticCdo({
      lods: [
        validSingleLod({
          uvTriangles: [
            {
              vertices: [0, 1, 2, 0],
              normals: [0, 0, 0, 0],
              faceType: CDO_FACE_TYPE_UV_TRI,
              uvs: [
                [0, 0],
                [16, 0],
                [16, 16],
                [1, 0],
              ],
            },
          ],
        }),
        validSingleLod(),
        validSingleLod(),
      ],
    });
    expectCdoError(() => parseCdo(buf), CdoError.InvalidTriangleUv3);
  });

  it('rejects non-zero bytes 0x16..0x17 on UV polygon records', () => {
    const buf = buildSyntheticCdo({
      lods: [
        validSingleLod({
          uvQuads: [
            {
              vertices: [0, 1, 2, 3],
              normals: [0, 0, 0, 0],
              faceType: CDO_FACE_TYPE_UV_QUAD,
              pad0x16: 1,
            },
          ],
        }),
        validSingleLod(),
        validSingleLod(),
      ],
    });
    expectCdoError(() => parseCdo(buf), CdoError.InvalidUvPadding);
  });

  it('validates shadow XZ bounding box while allowing non-zero shadow Y bounds', () => {
    const nonZeroYShadow = buildSyntheticCdo({
      shadow: {
        verticesXZ: [
          [-1800, -3900],
          [1800, 3900],
          [-1800, 3900],
          [1800, -3900],
        ],
        triangles: [{ vertices: [0, 1, 2, 0] }],
        quads: [{ vertices: [0, 1, 2, 3] }],
        lowY: -406,
        highY: -406,
      },
    });
    const ok = parseCdo(nonZeroYShadow);
    expect(ok.shadow.header.boundingBox.low.y).toBe(-406);

    const badShadowBox = buildSyntheticCdo({
      shadow: {
        verticesXZ: [
          [-1800, -3900],
          [1800, 3900],
          [-1800, 3900],
          [1800, -3900],
        ],
        triangles: [{ vertices: [0, 1, 2, 0] }],
        quads: [{ vertices: [0, 1, 2, 3] }],
        boundingBoxOverride: {
          low: [-1799, 0, -3900, 0],
          high: [1800, 0, 3900, 0],
        },
      },
    });
    expectCdoError(() => parseCdo(badShadowBox), CdoError.ShadowBoundingBoxMismatch);
  });

  it('rejects out-of-bounds shadow vertex indices and non-zero triangle v3', () => {
    const badShadowIdx = buildSyntheticCdo({
      shadow: {
        verticesXZ: [
          [-100, -100],
          [100, -100],
          [100, 100],
          [-100, 100],
        ],
        triangles: [{ vertices: [0, 1, 4, 0] }],
        quads: [],
      },
    });
    expectCdoError(() => parseCdo(badShadowIdx), CdoError.ShadowVertexIndexOutOfBounds);

    const badShadowTriV3 = buildSyntheticCdo({
      shadow: {
        verticesXZ: [
          [-100, -100],
          [100, -100],
          [100, 100],
          [-100, 100],
        ],
        triangles: [{ vertices: [0, 1, 2, 3] }],
        quads: [],
      },
    });
    expectCdoError(() => parseCdo(badShadowTriV3), CdoError.ShadowInvalidTriangleVertex3);
  });

  it('rejects trailing bytes after the shadow block with CdoError.TrailingData', () => {
    const buf = buildSyntheticCdo({ trailingBytes: 1 });
    expectCdoError(() => parseCdo(buf), CdoError.TrailingData);
  });
});
