import { describe, expect, it } from 'vitest';
import {
  CAR_RENDER_FLAG_PALETTE_14,
  CAR_RENDER_FLAG_SINGLE_SIDED,
  buildCarModel,
} from '../../src/formats/car';
import {
  CDO_FACE_TYPE_QUAD,
  CDO_FACE_TYPE_TRI,
  CDO_FACE_TYPE_UV_QUAD,
  CDO_FACE_TYPE_UV_QUAD_MODULATED,
  CDO_FACE_TYPE_UV_TRI,
  parseCdo,
} from '../../src/formats/car/cdo';
import {
  CAR_FACE_MODE_TEXTURED_MODULATED,
  CAR_FACE_MODE_TEXTURED_RAW,
  CAR_FACE_MODE_UNTEXTURED,
  CAR_MESH_ATTR_COLOR,
  CAR_MESH_ATTR_MATERIAL,
  CAR_MESH_ATTR_NORMAL,
  CAR_MESH_ATTR_POSITION,
  CAR_MESH_ATTR_UV,
  CarRenderMesh,
  type WebGL2MeshContext,
  buildCarMeshData,
} from '../../src/renderer';
import { buildSyntheticCdo } from '../fixtures/buildCdo';

function createMockMeshGl(options: { readonly failBufferAt?: number } = {}) {
  let nextId = 1;
  let bufferCreateCount = 0;
  const createdVaos: WebGLVertexArrayObject[] = [];
  const deletedVaos: WebGLVertexArrayObject[] = [];
  const createdBuffers: WebGLBuffer[] = [];
  const deletedBuffers: WebGLBuffer[] = [];
  const attribPointers: Array<{
    readonly kind: 'float' | 'int';
    readonly index: number;
    readonly size: number;
    readonly type: number;
    readonly normalized?: boolean;
    readonly stride: number;
    readonly offset: number;
  }> = [];
  const bufferUploads: Array<{
    readonly target: number;
    readonly usage: number;
    readonly byteLength: number;
  }> = [];
  const drawCalls: Array<{
    readonly mode: number;
    readonly count: number;
    readonly type: number;
    readonly offset: number;
    readonly cullEnabled: boolean;
    readonly cullFace: number | null;
    readonly frontFace: number | null;
  }> = [];

  let cullEnabled = false;
  let activeCullFace: number | null = null;
  let activeFrontFace: number | null = null;

  const gl: WebGL2MeshContext = {
    ARRAY_BUFFER: 0x8892,
    ELEMENT_ARRAY_BUFFER: 0x8893,
    STATIC_DRAW: 0x88e4,
    DYNAMIC_DRAW: 0x88e8,
    SHORT: 0x1402,
    FLOAT: 0x1406,
    UNSIGNED_BYTE: 0x1401,
    UNSIGNED_SHORT: 0x1403,
    TRIANGLES: 0x0004,
    LINES: 0x0001,
    CULL_FACE: 0x0b44,
    BACK: 0x0405,
    CCW: 0x0901,
    createVertexArray(): WebGLVertexArrayObject | null {
      const vao = { id: nextId++ } as unknown as WebGLVertexArrayObject;
      createdVaos.push(vao);
      return vao;
    },
    deleteVertexArray(vao: WebGLVertexArrayObject | null): void {
      if (vao !== null) {
        deletedVaos.push(vao);
      }
    },
    bindVertexArray(): void {
      // No-op in mock.
    },
    createBuffer(): WebGLBuffer | null {
      bufferCreateCount += 1;
      if (options.failBufferAt === bufferCreateCount) {
        return null;
      }
      const buf = { id: nextId++ } as unknown as WebGLBuffer;
      createdBuffers.push(buf);
      return buf;
    },
    deleteBuffer(buf: WebGLBuffer | null): void {
      if (buf !== null) {
        deletedBuffers.push(buf);
      }
    },
    bindBuffer(): void {
      // No-op in mock.
    },
    bufferData(target: number, srcData: ArrayBufferView | number, usage: number): void {
      const byteLength = typeof srcData === 'number' ? srcData : srcData.byteLength;
      bufferUploads.push({ target, usage, byteLength });
    },
    enableVertexAttribArray(): void {
      // No-op in mock.
    },
    vertexAttribPointer(
      index: number,
      size: number,
      type: number,
      normalized: boolean,
      stride: number,
      offset: number,
    ): void {
      attribPointers.push({ kind: 'float', index, size, type, normalized, stride, offset });
    },
    vertexAttribIPointer(
      index: number,
      size: number,
      type: number,
      stride: number,
      offset: number,
    ): void {
      attribPointers.push({ kind: 'int', index, size, type, stride, offset });
    },
    enable(cap: number): void {
      if (cap === gl.CULL_FACE) {
        cullEnabled = true;
      }
    },
    disable(cap: number): void {
      if (cap === gl.CULL_FACE) {
        cullEnabled = false;
      }
    },
    cullFace(mode: number): void {
      activeCullFace = mode;
    },
    frontFace(mode: number): void {
      activeFrontFace = mode;
    },
    drawElements(mode: number, count: number, type: number, offset: number): void {
      drawCalls.push({
        mode,
        count,
        type,
        offset,
        cullEnabled,
        cullFace: activeCullFace,
        frontFace: activeFrontFace,
      });
    },
  };

  return {
    gl,
    createdVaos,
    deletedVaos,
    createdBuffers,
    deletedBuffers,
    attribPointers,
    bufferUploads,
    drawCalls,
  };
}

describe('CarRenderMesh & buildCarMeshData (M7.2)', () => {
  it('preserves 16-bit SHORT positions, raw UNSIGNED_BYTE UVs, BGR888->RGB color order, face modes, and culling batches', () => {
    const sampleVerts: readonly (readonly [number, number, number, number])[] = [
      [-4096, 0, -4096, 0],
      [4096, 0, -4096, 0],
      [4096, 2048, 4096, 0],
      [-4096, 2048, 4096, 0],
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
            vertices: sampleVerts,
            normals: sampleNorms,
            triangles: [
              {
                vertices: [0, 1, 2, 0],
                normals: [0, 1, 2, 0],
                faceType: CDO_FACE_TYPE_TRI,
                renderFlags: CAR_RENDER_FLAG_SINGLE_SIDED,
                // LE uint32 low 24 bits: 0xBBGGRR => R=0x12, G=0x34, B=0x56
                color24: 0x563412,
              },
            ],
            quads: [
              {
                vertices: [0, 1, 2, 3],
                normals: [0, 1, 2, 3],
                faceType: CDO_FACE_TYPE_QUAD,
                renderFlags: 0, // double-sided
                color24: 0x112233,
              },
            ],
            uvTriangles: [
              {
                vertices: [0, 2, 3, 0],
                normals: [0, 2, 3, 0],
                faceType: CDO_FACE_TYPE_UV_TRI,
                renderFlags: CAR_RENDER_FLAG_SINGLE_SIDED,
                paletteRaw: 0x0041, // palette 5
                uvs: [
                  [10, 20],
                  [255, 20],
                  [255, 223],
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
                paletteRaw: 0x0042, // palette 6
                uvs: [
                  [0, 0],
                  [20, 0],
                  [20, 20],
                  [0, 20],
                ],
              },
              {
                vertices: [0, 1, 2, 3],
                normals: [0, 1, 2, 3],
                faceType: CDO_FACE_TYPE_UV_QUAD_MODULATED,
                renderFlags: CAR_RENDER_FLAG_PALETTE_14, // double-sided + palette 14
                color24: 0x5f5045, // R=0x45, G=0x50, B=0x5f
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

    const carModel = buildCarModel(cdo);
    const meshData = buildCarMeshData(carModel, 0);

    expect(meshData.hasNormals).toBe(true);
    // 1 untex tri + 2 untex quad tris + 1 uv tri + 2 uv quad tris + 2 modulated quad tris = 8 triangles
    expect(meshData.triangleCount).toBe(8);
    expect(meshData.positionsInt16).toBeInstanceOf(Int16Array);
    expect(meshData.uvsUint8).toBeInstanceOf(Uint8Array);
    expect(meshData.colorsUint8).toBeInstanceOf(Uint8Array);
    expect(meshData.materialsUint8).toBeInstanceOf(Uint8Array);

    // Single-sided batch (1 untex tri + 1 uv tri + 2 uv quad tris = 4 tris = 12 indices), then double-sided (4 tris = 12 indices)
    expect(meshData.batches).toEqual([
      { singleSided: true, indexOffset: 0, indexCount: 12 },
      { singleSided: false, indexOffset: 12, indexCount: 12 },
    ]);

    // First vertex of first untextured triangle: pos [-4096, 0, -4096], color RGB [0x12, 0x34, 0x56]
    const v0 = meshData.indicesUint16[0]!;
    expect(Array.from(meshData.positionsInt16.slice(v0 * 3, v0 * 3 + 3))).toEqual([-4096, 0, -4096]);
    expect(Array.from(meshData.colorsUint8.slice(v0 * 3, v0 * 3 + 3))).toEqual([0x12, 0x34, 0x56]);
    expect(Array.from(meshData.materialsUint8.slice(v0 * 2, v0 * 2 + 2))).toEqual([
      0,
      CAR_FACE_MODE_UNTEXTURED,
    ]);

    // Raw UV triangle: palette 5, faceMode RAW, exact texels [255, 223]
    const uvTriV2 = meshData.indicesUint16[5]!;
    expect(Array.from(meshData.uvsUint8.slice(uvTriV2 * 2, uvTriV2 * 2 + 2))).toEqual([255, 223]);
    expect(Array.from(meshData.materialsUint8.slice(uvTriV2 * 2, uvTriV2 * 2 + 2))).toEqual([
      5,
      CAR_FACE_MODE_TEXTURED_RAW,
    ]);

    // Modulated quad (faceType 44): palette 14, faceMode MODULATED, RGB [0x45, 0x50, 0x5f]
    const modV0 = meshData.indicesUint16[18]!;
    expect(Array.from(meshData.uvsUint8.slice(modV0 * 2, modV0 * 2 + 2))).toEqual([12, 34]);
    expect(Array.from(meshData.colorsUint8.slice(modV0 * 3, modV0 * 3 + 3))).toEqual([
      0x45, 0x50, 0x5f,
    ]);
    expect(Array.from(meshData.materialsUint8.slice(modV0 * 2, modV0 * 2 + 2))).toEqual([
      14,
      CAR_FACE_MODE_TEXTURED_MODULATED,
    ]);

    expect(meshData.boundsMeters.min).toEqual([-1, 0, -1]);
    expect(meshData.boundsMeters.max).toEqual([1, 0.5, 1]);
    expect(meshData.wireframeIndicesUint16.length % 2).toBe(0);
    expect(meshData.wireframeIndicesUint16.length).toBeGreaterThan(0);
  });

  it('handles LODs with normalCount === 0 safely with deterministic (0,1,0) normals and zero NaN', () => {
    const sampleVerts: readonly (readonly [number, number, number, number])[] = [
      [-1000, 0, -1000, 0],
      [1000, 0, -1000, 0],
      [0, 1000, 1000, 0],
    ];
    const cdo = parseCdo(
      buildSyntheticCdo({
        lods: [
          {
            vertices: sampleVerts,
            normals: [],
            triangles: [
              {
                vertices: [0, 1, 2, 0],
                normals: [0, 0, 0, 0],
                faceType: CDO_FACE_TYPE_TRI,
                color24: 0xffffff,
              },
            ],
            quads: [],
            uvTriangles: [],
            uvQuads: [],
          },
          { vertices: sampleVerts, normals: [], triangles: [], quads: [], uvTriangles: [], uvQuads: [] },
          { vertices: sampleVerts, normals: [], triangles: [], quads: [], uvTriangles: [], uvQuads: [] },
        ],
      }),
    );

    const carModel = buildCarModel(cdo);
    const meshData = buildCarMeshData(carModel, 0);

    expect(meshData.hasNormals).toBe(false);
    expect(meshData.vertexCount).toBe(3);
    for (let i = 0; i < meshData.vertexCount; i += 1) {
      const n = Array.from(meshData.normalsFloat32.slice(i * 3, i * 3 + 3));
      expect(n).toEqual([0, 1, 0]);
      expect(n.every((c) => Number.isFinite(c))).toBe(true);
    }
  });

  it('uploads non-normalized SHORT positions, raw UNSIGNED_BYTE UVs, integer material attrs, toggles CCW culling per batch, and disposes cleanly', () => {
    const sampleVerts: readonly (readonly [number, number, number, number])[] = [
      [-1000, 0, -1000, 0],
      [1000, 0, -1000, 0],
      [1000, 1000, 1000, 0],
      [-1000, 1000, 1000, 0],
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
            vertices: sampleVerts,
            normals: sampleNorms,
            triangles: [
              {
                vertices: [0, 1, 2, 0],
                normals: [0, 1, 2, 0],
                faceType: CDO_FACE_TYPE_TRI,
                renderFlags: CAR_RENDER_FLAG_SINGLE_SIDED,
              },
            ],
            quads: [],
            uvTriangles: [
              {
                vertices: [0, 2, 3, 0],
                normals: [0, 2, 3, 0],
                faceType: CDO_FACE_TYPE_UV_TRI,
                renderFlags: 0,
                paletteRaw: 0,
                uvs: [
                  [0, 0],
                  [10, 0],
                  [10, 10],
                  [0, 0],
                ],
              },
            ],
            uvQuads: [],
          },
          { vertices: sampleVerts, normals: sampleNorms, triangles: [], quads: [], uvTriangles: [], uvQuads: [] },
          { vertices: sampleVerts, normals: sampleNorms, triangles: [], quads: [], uvTriangles: [], uvQuads: [] },
        ],
      }),
    );

    const mock = createMockMeshGl();
    const mesh = CarRenderMesh.fromCarModel(mock.gl, buildCarModel(cdo), 0);

    expect(mock.createdVaos).toHaveLength(1);
    expect(mock.createdBuffers).toHaveLength(7);
    expect(mesh.getResourceCounts()).toEqual({
      programs: 0,
      vaos: 1,
      buffers: 7,
      textures: 0,
      framebuffers: 0,
      renderbuffers: 0,
    });

    const posAttr = mock.attribPointers.find((a) => a.index === CAR_MESH_ATTR_POSITION);
    expect(posAttr).toMatchObject({ kind: 'float', size: 3, type: mock.gl.SHORT, normalized: false });

    const normAttr = mock.attribPointers.find((a) => a.index === CAR_MESH_ATTR_NORMAL);
    expect(normAttr).toMatchObject({ kind: 'float', size: 3, type: mock.gl.FLOAT, normalized: false });

    const uvAttr = mock.attribPointers.find((a) => a.index === CAR_MESH_ATTR_UV);
    expect(uvAttr).toMatchObject({
      kind: 'float',
      size: 2,
      type: mock.gl.UNSIGNED_BYTE,
      normalized: false,
    });

    const colorAttr = mock.attribPointers.find((a) => a.index === CAR_MESH_ATTR_COLOR);
    expect(colorAttr).toMatchObject({
      kind: 'float',
      size: 3,
      type: mock.gl.UNSIGNED_BYTE,
      normalized: true,
    });

    const matAttr = mock.attribPointers.find((a) => a.index === CAR_MESH_ATTR_MATERIAL);
    expect(matAttr).toMatchObject({ kind: 'int', size: 2, type: mock.gl.UNSIGNED_BYTE });

    mesh.drawBatches();
    expect(mock.drawCalls).toHaveLength(2);
    expect(mock.drawCalls[0]).toMatchObject({
      cullEnabled: true,
      cullFace: mock.gl.BACK,
      frontFace: mock.gl.CCW,
      count: 3,
      offset: 0,
    });
    expect(mock.drawCalls[1]).toMatchObject({
      cullEnabled: false,
      count: 3,
      offset: 6,
    });

    mesh.drawWireframe();
    expect(mock.drawCalls).toHaveLength(3);
    expect(mock.drawCalls[2]?.mode).toBe(mock.gl.LINES);

    mesh.dispose();
    mesh.dispose();
    expect(mesh.isDisposed()).toBe(true);
    expect(mock.deletedBuffers).toHaveLength(7);
    expect(mock.deletedVaos).toHaveLength(1);
    expect(mesh.getResourceCounts()).toEqual({
      programs: 0,
      vaos: 0,
      buffers: 0,
      textures: 0,
      framebuffers: 0,
      renderbuffers: 0,
    });
  });

  it('cleans up partial buffers and VAO if GPU buffer allocation fails mid-construction', () => {
    const sampleVerts: readonly (readonly [number, number, number, number])[] = [
      [-1000, 0, -1000, 0],
      [1000, 0, -1000, 0],
      [0, 1000, 1000, 0],
    ];
    const sampleNorms: readonly (readonly [number, number, number])[] = [[0, 500, 0]];
    const cdo = parseCdo(
      buildSyntheticCdo({
        lods: [
          {
            vertices: sampleVerts,
            normals: sampleNorms,
            triangles: [{ vertices: [0, 1, 2, 0], normals: [0, 0, 0, 0], faceType: CDO_FACE_TYPE_TRI }],
            quads: [],
            uvTriangles: [],
            uvQuads: [],
          },
          { vertices: sampleVerts, normals: sampleNorms, triangles: [], quads: [], uvTriangles: [], uvQuads: [] },
          { vertices: sampleVerts, normals: sampleNorms, triangles: [], quads: [], uvTriangles: [], uvQuads: [] },
        ],
      }),
    );
    const carModel = buildCarModel(cdo);
    const data = buildCarMeshData(carModel, 0);
    const mock = createMockMeshGl({ failBufferAt: 4 });

    expect(() => new CarRenderMesh(mock.gl, data)).toThrow(/Failed to create WebGL2 buffer/i);
    expect(mock.createdBuffers).toHaveLength(3);
    expect(mock.deletedBuffers).toHaveLength(3);
    expect(mock.deletedVaos).toHaveLength(1);
  });
});
