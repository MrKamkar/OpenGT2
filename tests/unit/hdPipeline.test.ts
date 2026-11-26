import { describe, expect, it } from 'vitest';
import { buildCarModel } from '../../src/formats/car';
import { CDO_FACE_TYPE_UV_TRI, parseCdo } from '../../src/formats/car/cdo';
import { parseCdp } from '../../src/formats/car/cdp';
import {
  CarRenderer,
  HD_TEXTURE_ARRAY_HEIGHT,
  HD_TEXTURE_ARRAY_LAYERS,
  HD_TEXTURE_ARRAY_WIDTH,
  HdCarTextureArray,
  HdPipeline,
  OrbitCamera,
  type WebGL2CarRendererContext,
  prepareHdPaletteArrayData,
} from '../../src/renderer';
import { buildSyntheticCdo } from '../fixtures/buildCdo';
import { buildEmptyCdpPalette, buildSyntheticCdp } from '../fixtures/buildCdp';

function createMockRendererGl(options: { readonly maxSamples?: number; readonly withAniso?: boolean } = {}) {
  let nextId = 1;
  let activeBoundFbo: WebGLFramebuffer | null = null;
  let activeReadFbo: WebGLFramebuffer | null = null;
  let activeDrawFbo: WebGLFramebuffer | null = null;
  let unpackAlignment = 4;
  let boundTexture2dArray: WebGLTexture | null = null;

  const createdTextures: WebGLTexture[] = [];
  const deletedTextures: WebGLTexture[] = [];
  const createdFbos: WebGLFramebuffer[] = [];
  const deletedFbos: WebGLFramebuffer[] = [];
  const createdRbs: WebGLRenderbuffer[] = [];
  const deletedRbs: WebGLRenderbuffer[] = [];
  const createdVaos: WebGLVertexArrayObject[] = [];
  const deletedVaos: WebGLVertexArrayObject[] = [];
  const createdBuffers: WebGLBuffer[] = [];
  const deletedBuffers: WebGLBuffer[] = [];
  const createdPrograms: WebGLProgram[] = [];
  const deletedPrograms: WebGLProgram[] = [];

  const texArrayParams: Record<number, number> = {};
  const texSubImage3dCalls: Array<{ readonly depth: number; readonly dataLength: number }> = [];
  const generateMipmapTargets: number[] = [];
  const blitCalls: Array<{
    readonly readFbo: WebGLFramebuffer | null;
    readonly drawFbo: WebGLFramebuffer | null;
    readonly mask: number;
    readonly filter: number;
  }> = [];
  const drawArraysCalls: Array<{
    readonly boundFbo: WebGLFramebuffer | null;
    readonly mode: number;
    readonly count: number;
  }> = [];

  const gl: WebGL2CarRendererContext = {
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
    TEXTURE_2D_ARRAY: 0x8c1a,
    TEXTURE0: 0x84c0,
    TEXTURE1: 0x84c1,
    TEXTURE_MIN_FILTER: 0x2801,
    TEXTURE_MAG_FILTER: 0x2800,
    TEXTURE_WRAP_S: 0x2802,
    TEXTURE_WRAP_T: 0x2803,
    LINEAR: 0x2601,
    NEAREST: 0x2600,
    LINEAR_MIPMAP_LINEAR: 0x2703,
    CLAMP_TO_EDGE: 0x812f,
    UNPACK_ALIGNMENT: 0x0cf5,
    R8: 0x8229,
    RED: 0x1903,
    RGBA8: 0x8058,
    RGBA: 0x1908,
    DEPTH_COMPONENT24: 0x81a6,
    FRAMEBUFFER: 0x8d40,
    READ_FRAMEBUFFER: 0x8ca8,
    DRAW_FRAMEBUFFER: 0x8ca9,
    RENDERBUFFER: 0x8d41,
    COLOR_ATTACHMENT0: 0x8ce0,
    DEPTH_ATTACHMENT: 0x8d00,
    FRAMEBUFFER_COMPLETE: 0x8cd5,
    DEPTH_TEST: 0x0b71,
    LEQUAL: 0x0203,
    COLOR_BUFFER_BIT: 0x4000,
    DEPTH_BUFFER_BIT: 0x0100,
    MAX_SAMPLES: 0x8d57,

    createShader: (type) => ({ id: nextId++, type }) as unknown as WebGLShader,
    deleteShader: () => {},
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    createProgram: () => {
      const p = { id: nextId++ } as unknown as WebGLProgram;
      createdPrograms.push(p);
      return p;
    },
    deleteProgram: (p) => {
      if (p !== null) deletedPrograms.push(p);
    },
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

    createVertexArray: () => {
      const vao = { id: nextId++ } as unknown as WebGLVertexArrayObject;
      createdVaos.push(vao);
      return vao;
    },
    deleteVertexArray: (vao) => {
      if (vao !== null) deletedVaos.push(vao);
    },
    bindVertexArray: () => {},
    createBuffer: () => {
      const buf = { id: nextId++ } as unknown as WebGLBuffer;
      createdBuffers.push(buf);
      return buf;
    },
    deleteBuffer: (buf) => {
      if (buf !== null) deletedBuffers.push(buf);
    },
    bindBuffer: () => {},
    bufferData: () => {},
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    vertexAttribIPointer: () => {},
    enable: () => {},
    disable: () => {},
    cullFace: () => {},
    frontFace: () => {},
    drawElements: () => {},
    blendEquation: () => {},
    blendFunc: () => {},
    blendColor: () => {},

    createTexture: () => {
      const tex = { id: nextId++ } as unknown as WebGLTexture;
      createdTextures.push(tex);
      return tex;
    },
    deleteTexture: (tex) => {
      if (tex !== null) deletedTextures.push(tex);
    },
    activeTexture: () => {},
    bindTexture: (target, tex) => {
      if (target === gl.TEXTURE_2D_ARRAY) {
        boundTexture2dArray = tex;
      }
    },
    texParameteri: (target, pname, param) => {
      if (target === gl.TEXTURE_2D_ARRAY && boundTexture2dArray !== null) {
        texArrayParams[pname] = param;
      }
    },
    texParameterf: (target, pname, param) => {
      if (target === gl.TEXTURE_2D_ARRAY && boundTexture2dArray !== null) {
        texArrayParams[pname] = param;
      }
    },
    pixelStorei: (pname, param) => {
      if (pname === gl.UNPACK_ALIGNMENT) {
        unpackAlignment = param;
      }
    },
    getParameter: (pname) => {
      if (pname === gl.UNPACK_ALIGNMENT) return unpackAlignment;
      if (pname === gl.MAX_SAMPLES) return options.maxSamples ?? 4;
      if (pname === 0x84ff) return 16; // MAX_TEXTURE_MAX_ANISOTROPY_EXT
      return null;
    },
    getExtension: (name) => {
      if (options.withAniso !== false && name === 'EXT_texture_filter_anisotropic') {
        return {
          TEXTURE_MAX_ANISOTROPY_EXT: 0x84fe,
          MAX_TEXTURE_MAX_ANISOTROPY_EXT: 0x84ff,
        };
      }
      return null;
    },
    texImage2D: () => {},
    texImage3D: () => {},
    texSubImage3D: (_t, _l, _x, _y, _z, _w, _h, depth, _fmt, _type, data) => {
      texSubImage3dCalls.push({ depth, dataLength: data.byteLength });
    },
    generateMipmap: (target) => {
      generateMipmapTargets.push(target);
    },

    createFramebuffer: () => {
      const fbo = { id: nextId++ } as unknown as WebGLFramebuffer;
      createdFbos.push(fbo);
      return fbo;
    },
    deleteFramebuffer: (fbo) => {
      if (fbo !== null) deletedFbos.push(fbo);
    },
    bindFramebuffer: (target, fbo) => {
      if (target === gl.FRAMEBUFFER) {
        activeBoundFbo = fbo;
        activeReadFbo = fbo;
        activeDrawFbo = fbo;
      } else if (target === gl.READ_FRAMEBUFFER) {
        activeReadFbo = fbo;
      } else if (target === gl.DRAW_FRAMEBUFFER) {
        activeDrawFbo = fbo;
      }
    },
    framebufferTexture2D: () => {},
    framebufferRenderbuffer: () => {},
    checkFramebufferStatus: () => gl.FRAMEBUFFER_COMPLETE,
    blitFramebuffer: (_sx0, _sy0, _sx1, _sy1, _dx0, _dy0, _dx1, _dy1, mask, filter) => {
      blitCalls.push({
        readFbo: activeReadFbo,
        drawFbo: activeDrawFbo,
        mask,
        filter,
      });
    },

    createRenderbuffer: () => {
      const rb = { id: nextId++ } as unknown as WebGLRenderbuffer;
      createdRbs.push(rb);
      return rb;
    },
    deleteRenderbuffer: (rb) => {
      if (rb !== null) deletedRbs.push(rb);
    },
    bindRenderbuffer: () => {},
    renderbufferStorage: () => {},
    renderbufferStorageMultisample: () => {},
    viewport: () => {},
    clearColor: () => {},
    clear: () => {},
    depthFunc: () => {},
    depthMask: () => {},
    drawArrays: (mode, _first, count) => {
      drawArraysCalls.push({ boundFbo: activeBoundFbo, mode, count });
    },
  };

  return {
    gl,
    createdTextures,
    deletedTextures,
    createdFbos,
    deletedFbos,
    createdRbs,
    deletedRbs,
    createdVaos,
    deletedVaos,
    createdBuffers,
    deletedBuffers,
    createdPrograms,
    deletedPrograms,
    texArrayParams,
    texSubImage3dCalls,
    generateMipmapTargets,
    blitCalls,
    drawArraysCalls,
    getAlignment: () => unpackAlignment,
  };
}

function buildTestCar() {
  const pal0: number[] = new Array<number>(16).fill(0x801f); // red with STP
  pal0[0] = 0xffff; // empty -> transparent black 0x0000
  const pal1: number[] = new Array<number>(16).fill(0x83e0); // green
  const palSlot1: number[] = new Array<number>(16).fill(0xfc00); // blue

  const cdp = parseCdp(
    buildSyntheticCdp({
      colorIds: [0x30, 0x31],
      slots: [
        { palettes: [pal0, pal1, ...Array.from({ length: 14 }, () => buildEmptyCdpPalette())] },
        { palettes: [palSlot1, ...Array.from({ length: 15 }, () => buildEmptyCdpPalette())] },
      ],
    }),
  );

  const verts: readonly (readonly [number, number, number, number])[] = [
    [-2048, 0, -2048, 0],
    [2048, 0, -2048, 0],
    [0, 2048, 2048, 0],
  ];
  const norms: readonly (readonly [number, number, number])[] = [[0, 500, 0]];
  const cdo = parseCdo(
    buildSyntheticCdo({
      lods: [
        {
          vertices: verts,
          normals: norms,
          triangles: [],
          quads: [],
          uvTriangles: [
            {
              vertices: [0, 1, 2, 0],
              normals: [0, 0, 0, 0],
              faceType: CDO_FACE_TYPE_UV_TRI,
              paletteRaw: 0,
              uvs: [
                [0, 0],
                [64, 0],
                [32, 64],
                [0, 0],
              ],
            },
          ],
          uvQuads: [],
        },
        { vertices: verts, normals: norms, triangles: [], quads: [], uvTriangles: [], uvQuads: [] },
        { vertices: verts, normals: norms, triangles: [], quads: [], uvTriangles: [], uvQuads: [] },
      ],
    }),
  );

  return {
    cdp,
    carModel: buildCarModel(cdo, { texture: cdp, colorSlotIndex: 0 }),
  };
}

describe('HdPipeline, HdCarTextureArray, and CarRenderer (M7.5)', () => {
  it('prepares 256x224x16 RGBA8 array layers cleanly with 0xFFFF mapped to transparent black', () => {
    const { cdp } = buildTestCar();
    const arrayBytes = prepareHdPaletteArrayData(cdp, 0);
    expect(arrayBytes.byteLength).toBe(
      HD_TEXTURE_ARRAY_WIDTH * HD_TEXTURE_ARRAY_HEIGHT * HD_TEXTURE_ARRAY_LAYERS * 4,
    );

    // Layer 0 pixel (0,0) has index 0 -> 0xFFFF -> (0,0,0,0); pixel (1,0) has index 1 -> red (255,0,0,255)
    expect(Array.from(arrayBytes.slice(0, 4))).toEqual([0, 0, 0, 0]);
    expect(Array.from(arrayBytes.slice(4, 8))).toEqual([255, 0, 0, 255]);

    // Layer 1 pixel (0,0) has index 0 -> green (0,255,0,255)
    const layer1Base = HD_TEXTURE_ARRAY_WIDTH * HD_TEXTURE_ARRAY_HEIGHT * 4;
    expect(Array.from(arrayBytes.slice(layer1Base, layer1Base + 4))).toEqual([0, 255, 0, 255]);
  });

  it('configures TEXTURE_2D_ARRAY with CLAMP_TO_EDGE, LINEAR_MIPMAP_LINEAR, anisotropy, and texSubImage3D paint swaps', () => {
    const { cdp } = buildTestCar();
    const mock = createMockRendererGl({ withAniso: true });
    const texArray = new HdCarTextureArray(mock.gl, cdp, 0);

    expect(texArray.anisotropicFilteringApplied).toBe(true);
    expect(mock.getAlignment()).toBe(4);
    expect(mock.texArrayParams[mock.gl.TEXTURE_WRAP_S]).toBe(mock.gl.CLAMP_TO_EDGE);
    expect(mock.texArrayParams[mock.gl.TEXTURE_WRAP_T]).toBe(mock.gl.CLAMP_TO_EDGE);
    expect(mock.texArrayParams[mock.gl.TEXTURE_MIN_FILTER]).toBe(mock.gl.LINEAR_MIPMAP_LINEAR);
    expect(mock.texArrayParams[mock.gl.TEXTURE_MAG_FILTER]).toBe(mock.gl.LINEAR);
    expect(mock.texArrayParams[0x84fe]).toBe(8);
    expect(mock.generateMipmapTargets).toEqual([mock.gl.TEXTURE_2D_ARRAY]);

    texArray.updatePaintSlot(cdp, 1);
    expect(mock.texSubImage3dCalls).toHaveLength(1);
    expect(mock.texSubImage3dCalls[0]?.depth).toBe(16);
    expect(mock.generateMipmapTargets).toHaveLength(2);

    texArray.dispose();
    texArray.dispose();
    expect(mock.deletedTextures).toHaveLength(1);
    expect(texArray.getResourceCounts().textures).toBe(0);
  });

  it('resolves MSAA FBO to an offscreen resolveFbo (never null) before fullscreen present pass, and falls back when MAX_SAMPLES < 2', () => {
    const { carModel, cdp } = buildTestCar();
    const camera = new OrbitCamera();

    // MSAA path (MAX_SAMPLES = 4)
    const msaaMock = createMockRendererGl({ maxSamples: 4 });
    const hdMsaa = new HdPipeline(msaaMock.gl);
    const texMsaa = new HdCarTextureArray(msaaMock.gl, cdp, 0);
    const meshMsaa = new CarRenderer(msaaMock.gl, { initialMode: 'hd' });
    meshMsaa.setCar(carModel);
    // Test HdPipeline directly
    hdMsaa.render(meshMsaa.getMesh()!, texMsaa, camera, 800, 600);

    expect(hdMsaa.getActiveSampleCount()).toBe(4);
    expect(msaaMock.blitCalls).toHaveLength(1);
    expect(msaaMock.blitCalls[0]?.readFbo).not.toBeNull();
    expect(msaaMock.blitCalls[0]?.drawFbo).not.toBeNull();
    expect(msaaMock.drawArraysCalls[0]?.boundFbo).toBeNull();
    expect(msaaMock.drawArraysCalls[0]?.count).toBe(3);

    texMsaa.dispose();
    hdMsaa.dispose();
    meshMsaa.dispose();

    // Fallback path (MAX_SAMPLES = 1)
    const fallbackMock = createMockRendererGl({ maxSamples: 1 });
    const hdFallback = new HdPipeline(fallbackMock.gl);
    const rendererFallback = new CarRenderer(fallbackMock.gl, { initialMode: 'hd' });
    rendererFallback.setCar(carModel);
    hdFallback.render(rendererFallback.getMesh()!, null, camera, 800, 600);

    expect(hdFallback.getActiveSampleCount()).toBe(0);
    expect(fallbackMock.blitCalls).toHaveLength(0);
    expect(fallbackMock.drawArraysCalls[0]?.boundFbo).toBeNull();

    hdFallback.dispose();
    rendererFallback.dispose();
  });

  it('switches between HD (default) and PS1 and changes paint slots without rebuilding mesh or leaking GPU objects', () => {
    const { carModel } = buildTestCar();
    const mock = createMockRendererGl({ maxSamples: 4 });
    const renderer = new CarRenderer(mock.gl);
    const camera = new OrbitCamera();

    expect(renderer.getMode()).toBe('hd');
    renderer.setCar(carModel);
    const initialMesh = renderer.getMesh();
    const buffersAfterLoad = mock.createdBuffers.length;

    renderer.render(camera, 1280, 720);
    const texturesAfterFirstRender = mock.createdTextures.length;
    // Switch to PS1 without reloading mesh or re-uploading PS1 textures
    renderer.setMode('ps1');
    renderer.render(camera, 1280, 720);
    expect(renderer.getMesh()).toBe(initialMesh);
    expect(mock.createdBuffers.length).toBe(buffersAfterLoad);

    // Paint slot switch in PS1 updates uniform only (zero texSubImage3D until HD renders)
    renderer.setPaintSlot(1);
    expect(mock.texSubImage3dCalls).toHaveLength(0);
    renderer.render(camera, 1280, 720);
    expect(mock.texSubImage3dCalls).toHaveLength(0);

    // Switching back to HD syncs HD texture array via texSubImage3D without recreating textures
    renderer.setMode('hd');
    renderer.render(camera, 1280, 720);
    expect(mock.texSubImage3dCalls).toHaveLength(1);
    expect(mock.createdTextures.length).toBe(texturesAfterFirstRender);

    // Full dispose cleans up all GPU objects to zero
    renderer.dispose();
    renderer.dispose();
    expect(renderer.getResourceCounts()).toEqual({
      programs: 0,
      vaos: 0,
      buffers: 0,
      textures: 0,
      framebuffers: 0,
      renderbuffers: 0,
    });
    expect(mock.deletedPrograms.length).toBe(mock.createdPrograms.length);
    expect(mock.deletedVaos.length).toBe(mock.createdVaos.length);
    expect(mock.deletedBuffers.length).toBe(mock.createdBuffers.length);
    expect(mock.deletedTextures.length).toBe(mock.createdTextures.length);
    expect(mock.deletedFbos.length).toBe(mock.createdFbos.length);
    expect(mock.deletedRbs.length).toBe(mock.createdRbs.length);
  });
});
