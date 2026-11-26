import { describe, expect, it, vi } from 'vitest';
import { AssetRepository, type AssetRepositoryWorkerBackend } from '../../src/assets';
import { InputManager } from '../../src/core/input';
import { buildCarModel, type CarModel } from '../../src/formats/car';
import { CDO_FACE_TYPE_UV_QUAD, CDO_FACE_TYPE_UV_TRI, parseCdo } from '../../src/formats/car/cdo';
import { parseCdp } from '../../src/formats/car/cdp';
import type { VolEntry, VolInfo } from '../../src/formats/vol';
import {
  CarRenderer,
  type CarViewerCanvasInputTarget,
  type CarViewerGlContextLike,
  CarViewerSession,
  EMPTY_GPU_RESOURCE_COUNTS,
  GL_NO_ERROR_CODE,
  type GpuResourceCounts,
  OrbitCamera,
  type WebGL2CarRendererContext,
  type WebGL2ErrorContext,
} from '../../src/renderer';
import { buildSyntheticCdo } from '../fixtures/buildCdo';
import { buildSyntheticCdp } from '../fixtures/buildCdp';

function createLeakTrackingMockGl() {
  let nextId = 1;
  let unpackAlignment = 4;

  const livePrograms = new Set<WebGLProgram>();
  const liveShaders = new Set<WebGLShader>();
  const liveVaos = new Set<WebGLVertexArrayObject>();
  const liveBuffers = new Set<WebGLBuffer>();
  const liveTextures = new Set<WebGLTexture>();
  const liveFramebuffers = new Set<WebGLFramebuffer>();
  const liveRenderbuffers = new Set<WebGLRenderbuffer>();
  const doubleDeletes: string[] = [];

  const trackDelete = <T>(set: Set<T>, obj: T | null, kind: string): void => {
    if (obj === null) {
      return;
    }
    if (!set.delete(obj)) {
      doubleDeletes.push(kind);
    }
  };

  const gl: WebGL2CarRendererContext & WebGL2ErrorContext = {
    NO_ERROR: GL_NO_ERROR_CODE,
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

    getError: () => GL_NO_ERROR_CODE,

    createShader: (type) => {
      const shader = { id: nextId++, type } as unknown as WebGLShader;
      liveShaders.add(shader);
      return shader;
    },
    deleteShader: (shader) => trackDelete(liveShaders, shader, 'shader'),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    createProgram: () => {
      const program = { id: nextId++ } as unknown as WebGLProgram;
      livePrograms.add(program);
      return program;
    },
    deleteProgram: (program) => trackDelete(livePrograms, program, 'program'),
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
      liveVaos.add(vao);
      return vao;
    },
    deleteVertexArray: (vao) => trackDelete(liveVaos, vao, 'vao'),
    bindVertexArray: () => {},
    createBuffer: () => {
      const buf = { id: nextId++ } as unknown as WebGLBuffer;
      liveBuffers.add(buf);
      return buf;
    },
    deleteBuffer: (buf) => trackDelete(liveBuffers, buf, 'buffer'),
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
      liveTextures.add(tex);
      return tex;
    },
    deleteTexture: (tex) => trackDelete(liveTextures, tex, 'texture'),
    activeTexture: () => {},
    bindTexture: () => {},
    texParameteri: () => {},
    texParameterf: () => {},
    pixelStorei: (pname, param) => {
      if (pname === gl.UNPACK_ALIGNMENT) {
        unpackAlignment = param;
      }
    },
    getParameter: (pname) => {
      if (pname === gl.UNPACK_ALIGNMENT) {
        return unpackAlignment;
      }
      if (pname === gl.MAX_SAMPLES) {
        return 4;
      }
      return null;
    },
    getExtension: () => null,
    texImage2D: () => {},
    texImage3D: () => {},
    texSubImage3D: () => {},
    generateMipmap: () => {},

    createFramebuffer: () => {
      const fbo = { id: nextId++ } as unknown as WebGLFramebuffer;
      liveFramebuffers.add(fbo);
      return fbo;
    },
    deleteFramebuffer: (fbo) => trackDelete(liveFramebuffers, fbo, 'framebuffer'),
    bindFramebuffer: () => {},
    framebufferTexture2D: () => {},
    framebufferRenderbuffer: () => {},
    checkFramebufferStatus: () => gl.FRAMEBUFFER_COMPLETE,
    blitFramebuffer: () => {},

    createRenderbuffer: () => {
      const rb = { id: nextId++ } as unknown as WebGLRenderbuffer;
      liveRenderbuffers.add(rb);
      return rb;
    },
    deleteRenderbuffer: (rb) => trackDelete(liveRenderbuffers, rb, 'renderbuffer'),
    bindRenderbuffer: () => {},
    renderbufferStorage: () => {},
    renderbufferStorageMultisample: () => {},

    viewport: () => {},
    clearColor: () => {},
    clear: () => {},
    depthFunc: () => {},
    depthMask: () => {},
    drawArrays: () => {},
  };

  return {
    gl,
    doubleDeletes,
    getLiveCounts(): GpuResourceCounts {
      return {
        programs: livePrograms.size,
        vaos: liveVaos.size,
        buffers: liveBuffers.size,
        textures: liveTextures.size,
        framebuffers: liveFramebuffers.size,
        renderbuffers: liveRenderbuffers.size,
      };
    },
    getLiveShaderCount: () => liveShaders.size,
  };
}

function makeSyntheticCarVariant(seed: number, colorCount: number): CarModel {
  const vertices: readonly (readonly [number, number, number, number])[] = [
    [-2000 - seed * 50, 0, -4000, 0],
    [2000 + seed * 50, 0, -4000, 0],
    [2000, 1500 + seed * 40, 4000, 0],
    [-2000, 1500 + seed * 40, 4000, 0],
  ];
  const normals: readonly (readonly [number, number, number])[] = [
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
          vertices,
          normals,
          uvTriangles: [
            {
              vertices: [0, 2, 3, 0],
              normals: [0, 2, 3, 0],
              faceType: CDO_FACE_TYPE_UV_TRI,
              paletteRaw: seed % 4,
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
              vertices: [3, 2, 1, 0],
              normals: [3, 2, 1, 0],
              faceType: CDO_FACE_TYPE_UV_QUAD,
              paletteRaw: 0x0040 | (seed % 4),
              uvs: [
                [0, 0],
                [64, 0],
                [64, 64],
                [0, 64],
              ],
            },
          ],
        },
        {
          maxDistance: 15,
          vertices,
          normals,
          uvTriangles: [
            {
              vertices: [0, 1, 2, 0],
              normals: [0, 1, 2, 0],
              faceType: CDO_FACE_TYPE_UV_TRI,
              paletteRaw: 0x0000,
              uvs: [
                [0, 0],
                [32, 0],
                [32, 32],
                [0, 0],
              ],
            },
          ],
          uvQuads: [],
        },
        {
          maxDistance: 300,
          vertices,
          normals,
          uvTriangles: [],
          uvQuads: [],
        },
      ],
    }),
  );
  const cdp = parseCdp(buildSyntheticCdp({ colorCount }));
  return buildCarModel(cdo, { texture: cdp, variant: 'day' });
}

describe('GPU Resource Leak Verification (M7.8)', () => {
  it('maintains constant live GPU object counts across 50 consecutive car switches, mode toggles, paint/LOD changes, and drops to 0 on dispose()', () => {
    const mock = createLeakTrackingMockGl();
    const renderer = new CarRenderer(mock.gl, { initialMode: 'hd' });
    const camera = new OrbitCamera();

    const cars = Array.from({ length: 6 }, (_, i) => makeSyntheticCarVariant(i, (i % 4) + 1));
    const ps1Resolutions = [
      [320, 240],
      [512, 240],
      [640, 480],
    ] as const;

    // Warm up both HD and PS1 offscreen FBOs/RBOs/textures on car 0 so baseline covers all steady-state objects.
    renderer.setCar(cars[0]!, { lodIndex: 0, colorSlotIndex: 0 });
    camera.fitToCarModel(cars[0]!, 0);
    renderer.render(camera, 1280, 720, { wireframe: false });
    renderer.setMode('ps1');
    renderer.render(camera, 1280, 720, { wireframe: true });
    renderer.setMode('hd');
    renderer.render(camera, 1280, 720, { wireframe: false });

    const baselineCounts = mock.getLiveCounts();
    expect(mock.getLiveShaderCount()).toBe(0);
    expect(renderer.getResourceCounts()).toEqual(baselineCounts);
    expect(baselineCounts.programs).toBeGreaterThan(0);
    expect(baselineCounts.textures).toBeGreaterThan(0);

    // 50 consecutive car switches with interleaved paint, LOD, HD<->PS1, resolution, and wireframe changes.
    for (let step = 0; step < 50; step += 1) {
      const car = cars[step % cars.length]!;
      const slotCount = car.texture?.source.colorCount ?? 1;
      const mode = step % 2 === 0 ? 'hd' : 'ps1';
      renderer.setMode(mode);
      renderer.setCar(car, { lodIndex: 0, colorSlotIndex: 0 });

      if (slotCount > 1) {
        renderer.setPaintSlot((step + 1) % slotCount);
      }
      renderer.setLod(1);
      renderer.setLod(2);
      renderer.setLod(0);

      const [resW, resH] = ps1Resolutions[step % ps1Resolutions.length]!;
      renderer.setPs1InternalResolution(resW, resH);
      renderer.render(camera, 1280, 720, { wireframe: step % 3 === 0 });

      // Ensure HD texture array is also exercised if step started in PS1.
      if (mode === 'ps1') {
        renderer.setMode('hd');
        renderer.render(camera, 1280, 720);
      }

      const currentCounts = mock.getLiveCounts();
      expect(currentCounts).toEqual(baselineCounts);
      expect(renderer.getResourceCounts()).toEqual(baselineCounts);
      expect(mock.getLiveShaderCount()).toBe(0);
      expect(renderer.pollGlError().hasError).toBe(false);
    }

    // Double-dispose is idempotent and releases 100% of GPU objects.
    renderer.dispose();
    renderer.dispose();

    expect(mock.getLiveCounts()).toEqual(EMPTY_GPU_RESOURCE_COUNTS);
    expect(renderer.getResourceCounts()).toEqual(EMPTY_GPU_RESOURCE_COUNTS);
    expect(mock.getLiveShaderCount()).toBe(0);
    expect(mock.doubleDeletes).toEqual([]);
  });

  it('cleanly disposes CarViewerSession GPU buffers, canvas listeners, and rAF loop on file reset', async () => {
    const mock = createLeakTrackingMockGl();
    const listeners = new Map<string, Set<unknown>>();

    const canvas: CarViewerCanvasInputTarget = {
      addEventListener(type: string, listener: unknown): void {
        let bucket = listeners.get(type);
        if (bucket === undefined) {
          bucket = new Set();
          listeners.set(type, bucket);
        }
        bucket.add(listener);
      },
      removeEventListener(type: string, listener: unknown): void {
        listeners.get(type)?.delete(listener);
      },
    };

    const glContext: CarViewerGlContextLike = {
      gl: {
        COLOR_BUFFER_BIT: 0x4000,
        viewport: mock.gl.viewport,
        clearColor: mock.gl.clearColor,
        clear: mock.gl.clear,
        isContextLost: () => false,
      },
      isContextLost: () => false,
      getSize: () => ({ width: 800, height: 600 }),
      clear: () => {},
    };

    const modelsByPath: Record<string, CarModel> = {
      'carobj/a1000.cdo.gz': makeSyntheticCarVariant(0, 2),
      'carobj/b2000.cdo.gz': makeSyntheticCarVariant(1, 3),
    };

    const volInfo: VolInfo = {
      fingerprint: 'fp_leak_session',
      fileCount: 4,
      entryCount: 5,
      warnings: [],
      variant: 'unknown',
    };
    const entries: VolEntry[] = [
      { path: 'carobj/a1000.cdo.gz', kind: 'file', address: 2048, size: 512, unixTime: 0, isGzip: true },
      { path: 'carobj/a1000.cdp.gz', kind: 'file', address: 4096, size: 512, unixTime: 0, isGzip: true },
      { path: 'carobj/b2000.cdo.gz', kind: 'file', address: 6144, size: 512, unixTime: 0, isGzip: true },
      { path: 'carobj/b2000.cdp.gz', kind: 'file', address: 8192, size: 512, unixTime: 0, isGzip: true },
    ];
    const backend: AssetRepositoryWorkerBackend = {
      list: async () => entries,
      read: async () => new Uint8Array(0),
      readDecompressed: async () => new Uint8Array(0),
      loadCarResources: vi.fn(async (params) => ({
        carModel: modelsByPath[params.modelPath]!,
      })),
    };

    const repo = new AssetRepository({ volInfo, entries, backend });
    const inputManager = new InputManager({ initialContext: 'viewer' });
    let nextRafId = 1;
    const activeRafs = new Set<number>();

    const session = new CarViewerSession({
      glContext,
      gl: mock.gl,
      canvas,
      inputManager,
      assetRepository: repo,
      raf: {
        request: () => {
          const id = nextRafId++;
          activeRafs.add(id);
          return id;
        },
        cancel: (id) => {
          activeRafs.delete(id);
        },
      },
    });

    session.start();
    await session.loadCar('a1000', 'day');
    session.renderCurrentFrame();
    await session.loadCar('b2000', 'day');
    session.setRenderMode('ps1');
    session.renderCurrentFrame();

    expect(mock.getLiveCounts().programs).toBeGreaterThan(0);
    expect(Array.from(listeners.values()).reduce((sum, s) => sum + s.size, 0)).toBe(5);

    // Simulate file reset ("Zmień plik").
    session.dispose();
    repo.dispose();
    inputManager.releaseAll();
    inputManager.setContext('menu');

    expect(mock.getLiveCounts()).toEqual(EMPTY_GPU_RESOURCE_COUNTS);
    expect(session.getGpuResourceCounts()).toEqual(EMPTY_GPU_RESOURCE_COUNTS);
    expect(Array.from(listeners.values()).reduce((sum, s) => sum + s.size, 0)).toBe(0);
    expect(activeRafs.size).toBe(0);
    expect(inputManager.getContext()).toBe('menu');
    expect(mock.doubleDeletes).toEqual([]);
  });
});
