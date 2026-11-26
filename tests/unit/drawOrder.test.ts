import { describe, expect, it } from 'vitest';
import { buildCarModel } from '../../src/formats/car';
import { CDO_FACE_TYPE_TRI, parseCdo } from '../../src/formats/car/cdo';
import {
  type CarMeshPrimitive,
  CarRenderMesh,
  OrbitCamera,
  Ps1Pipeline,
  type WebGL2Ps1Context,
  mat4Identity,
  mat4LookAt,
  sortPrimitivesOrderingTable,
} from '../../src/renderer';
import { buildSyntheticCdo } from '../fixtures/buildCdo';

function makePrim(
  idx: number,
  centroidZ: number,
  singleSided: boolean,
  renderOrder = 16,
  centroidX = 0,
): CarMeshPrimitive {
  const base = idx * 3;
  return {
    i0: base,
    i1: base + 1,
    i2: base + 2,
    centroidX,
    centroidY: 0,
    centroidZ,
    singleSided,
    renderOrder,
    faceType: CDO_FACE_TYPE_TRI,
    paletteIndex: 0,
  };
}

function createMockPs1DrawOrderGl() {
  let nextId = 1;
  let depthTestEnabled = false;
  const depthTestHistory: boolean[] = [];
  const bufferUploads: Array<{ readonly target: number; readonly usage: number; readonly len: number }> = [];
  const drawElementsCount: number[] = [];

  const gl: WebGL2Ps1Context = {
    VERTEX_SHADER: 0x8b31,
    FRAGMENT_SHADER: 0x8b30,
    COMPILE_STATUS: 0x8b81,
    LINK_STATUS: 0x8b82,
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
    BLEND: 0x0be2,
    FUNC_ADD: 0x8006,
    FUNC_REVERSE_SUBTRACT: 0x800b,
    ONE: 1,
    CONSTANT_ALPHA: 0x8003,
    ONE_MINUS_CONSTANT_ALPHA: 0x8004,
    TEXTURE_2D: 0x0de1,
    TEXTURE0: 0x84c0,
    TEXTURE1: 0x84c1,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    NEAREST: 0x2600,
    CLAMP_TO_EDGE: 0x812f,
    RGBA8: 0x8058,
    RGBA: 0x1908,
    DEPTH_COMPONENT24: 0x81a6,
    FRAMEBUFFER: 0x8d40,
    RENDERBUFFER: 0x8d41,
    COLOR_ATTACHMENT0: 0x8ce0,
    DEPTH_ATTACHMENT: 0x8d00,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    DEPTH_TEST: 0x0b71,
    LEQUAL: 0x0203,
    COLOR_BUFFER_BIT: 0x4000,
    DEPTH_BUFFER_BIT: 0x0100,

    createShader: (type) => ({ id: nextId++, type }) as unknown as WebGLShader,
    deleteShader: () => {},
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    createProgram: () => ({ id: nextId++ }) as unknown as WebGLProgram,
    deleteProgram: () => {},
    attachShader: () => {},
    detachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    useProgram: () => {},
    getUniformLocation: (_p, name) => ({ name }) as unknown as WebGLUniformLocation,
    getAttribLocation: () => 0,
    uniform1i: () => {},
    uniform1ui: () => {},
    uniform1f: () => {},
    uniform2f: () => {},
    uniform2i: () => {},
    uniform3f: () => {},
    uniform4f: () => {},
    uniformMatrix4fv: () => {},

    createVertexArray: () => ({ id: nextId++ }) as unknown as WebGLVertexArrayObject,
    deleteVertexArray: () => {},
    bindVertexArray: () => {},
    createBuffer: () => ({ id: nextId++ }) as unknown as WebGLBuffer,
    deleteBuffer: () => {},
    bindBuffer: () => {},
    bufferData: (target, srcData, usage) => {
      const len = typeof srcData === 'number' ? srcData : srcData.byteLength;
      bufferUploads.push({ target, usage, len });
    },
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    vertexAttribIPointer: () => {},
    enable: (cap) => {
      if (cap === gl.DEPTH_TEST) {
        depthTestEnabled = true;
      }
    },
    disable: (cap) => {
      if (cap === gl.DEPTH_TEST) {
        depthTestEnabled = false;
      }
    },
    cullFace: () => {},
    frontFace: () => {},
    drawElements: (_mode, count) => {
      depthTestHistory.push(depthTestEnabled);
      drawElementsCount.push(count);
    },
    blendEquation: () => {},
    blendFunc: () => {},
    blendColor: () => {},

    createTexture: () => ({ id: nextId++ }) as unknown as WebGLTexture,
    deleteTexture: () => {},
    activeTexture: () => {},
    bindTexture: () => {},
    texParameteri: () => {},
    texImage2D: () => {},
    createFramebuffer: () => ({ id: nextId++ }) as unknown as WebGLFramebuffer,
    deleteFramebuffer: () => {},
    bindFramebuffer: () => {},
    framebufferTexture2D: () => {},
    framebufferRenderbuffer: () => {},
    checkFramebufferStatus: () => gl.FRAMEBUFFER_COMPLETE,
    createRenderbuffer: () => ({ id: nextId++ }) as unknown as WebGLRenderbuffer,
    deleteRenderbuffer: () => {},
    bindRenderbuffer: () => {},
    renderbufferStorage: () => {},
    viewport: () => {},
    clearColor: () => {},
    clear: () => {},
    depthFunc: () => {},
    depthMask: () => {},
    drawArrays: () => {},
  };

  return { gl, depthTestHistory, bufferUploads, drawElementsCount };
}

describe('Draw order & experimental CPU ordering table (M7.6)', () => {
  it('sorts primitives back-to-front in right-handed view space (-Z forward) for both identity and rotated cameras', () => {
    const primitives = [
      makePrim(0, -2, true), // near
      makePrim(1, -10, true), // far
      makePrim(2, -5, true), // mid
    ];

    const identitySorted = sortPrimitivesOrderingTable(primitives, mat4Identity());
    // Farthest (-10 -> prim 1) first, then mid (-5 -> prim 2), then near (-2 -> prim 0)
    expect(Array.from(identitySorted.indices)).toEqual([3, 4, 5, 6, 7, 8, 0, 1, 2]);
    expect(identitySorted.batches).toEqual([{ singleSided: true, indexOffset: 0, indexCount: 9 }]);

    // Camera placed at -Z looking toward +Z reverses relative depth order.
    const flippedView = mat4LookAt([0, 0, -20], [0, 0, 0], [0, 1, 0]);
    const flippedSorted = sortPrimitivesOrderingTable(primitives, flippedView);
    expect(Array.from(flippedSorted.indices)).toEqual([0, 1, 2, 6, 7, 8, 3, 4, 5]);
  });

  it('breaks equal-depth ties deterministically and applies E1 renderOrder only when enabled', () => {
    const primitives = [
      makePrim(0, -4, true, 24),
      makePrim(1, -4, true, 8),
      makePrim(2, -4, true, 16),
    ];

    // Default: ignore E1 renderOrder and preserve original primitive order deterministically.
    const defaultSorted = sortPrimitivesOrderingTable(primitives, mat4Identity());
    expect(Array.from(defaultSorted.indices)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);

    // Experimental renderOrder hint enabled: sorts equal-depth ties by ascending renderOrder (8, 16, 24).
    const hintSorted = sortPrimitivesOrderingTable(primitives, mat4Identity(), {
      useRenderOrderHint: true,
    });
    expect(Array.from(hintSorted.indices)).toEqual([3, 4, 5, 6, 7, 8, 0, 1, 2]);
  });

  it('merges consecutive primitives sharing culling state into minimal batches while preserving painter order', () => {
    const primitives = [
      makePrim(0, -10, true),
      makePrim(1, -8, true),
      makePrim(2, -6, false),
      makePrim(3, -4, false),
      makePrim(4, -2, true),
    ];

    const sorted = sortPrimitivesOrderingTable(primitives, mat4Identity());
    expect(sorted.batches).toEqual([
      { singleSided: true, indexOffset: 0, indexCount: 6 },
      { singleSided: false, indexOffset: 6, indexCount: 6 },
      { singleSided: true, indexOffset: 12, indexCount: 3 },
    ]);
  });

  it('integrates with Ps1Pipeline: Z-buffer enabled by default vs disabled + DYNAMIC_DRAW IBO in ordering-table-experimental', () => {
    const verts: readonly (readonly [number, number, number, number])[] = [
      [-1000, 0, -1000, 0],
      [1000, 0, -1000, 0],
      [0, 1000, 1000, 0],
    ];
    const norms: readonly (readonly [number, number, number])[] = [[0, 500, 0]];
    const cdo = parseCdo(
      buildSyntheticCdo({
        lods: [
          {
            vertices: verts,
            normals: norms,
            triangles: [
              { vertices: [0, 1, 2, 0], normals: [0, 0, 0, 0], faceType: CDO_FACE_TYPE_TRI },
            ],
            quads: [],
            uvTriangles: [],
            uvQuads: [],
          },
          { vertices: verts, normals: norms, triangles: [], quads: [], uvTriangles: [], uvQuads: [] },
          { vertices: verts, normals: norms, triangles: [], quads: [], uvTriangles: [], uvQuads: [] },
        ],
      }),
    );

    const mock = createMockPs1DrawOrderGl();
    const mesh = CarRenderMesh.fromCarModel(mock.gl, buildCarModel(cdo), 0);
    const ps1 = new Ps1Pipeline(mock.gl);
    const camera = new OrbitCamera();

    // Default Z-buffer mode
    ps1.render(mesh, null, camera, 640, 480);
    expect(mock.depthTestHistory[0]).toBe(true);
    expect(mock.bufferUploads.some((u) => u.usage === mock.gl.DYNAMIC_DRAW)).toBe(false);

    // Experimental CPU ordering table mode
    ps1.render(mesh, null, camera, 640, 480, { drawOrderMode: 'ordering-table-experimental' });
    expect(mock.depthTestHistory[1]).toBe(false);
    expect(mock.bufferUploads.some((u) => u.usage === mock.gl.DYNAMIC_DRAW)).toBe(true);

    ps1.dispose();
    mesh.dispose();
  });
});
