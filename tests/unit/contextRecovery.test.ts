import { describe, expect, it, vi } from 'vitest';
import { AssetRepository, type AssetRepositoryWorkerBackend } from '../../src/assets';
import { InputManager } from '../../src/core/input';
import { buildCarModel, type CarModel } from '../../src/formats/car';
import { CDO_FACE_TYPE_UV_QUAD, CDO_FACE_TYPE_UV_TRI, parseCdo } from '../../src/formats/car/cdo';
import { parseCdp } from '../../src/formats/car/cdp';
import type { VolEntry, VolInfo } from '../../src/formats/vol';
import {
  CarViewerSession,
  EMPTY_GPU_RESOURCE_COUNTS,
  GL_NO_ERROR_CODE,
  type GlCanvasTarget,
  GlContext,
  type WebGL2CarRendererContext,
  type WebGL2ErrorContext,
} from '../../src/renderer';
import { buildSyntheticCdo } from '../fixtures/buildCdo';
import { buildSyntheticCdp } from '../fixtures/buildCdp';

function createContextLossHarness() {
  let lost = false;
  let nextId = 1;
  let unpackAlignment = 4;

  const listeners = new Map<string, Set<(event: Event) => void>>();
  const liveTextures = new Set<WebGLTexture>();
  const liveBuffers = new Set<WebGLBuffer>();
  const livePrograms = new Set<WebGLProgram>();
  const liveVaos = new Set<WebGLVertexArrayObject>();
  const liveFramebuffers = new Set<WebGLFramebuffer>();
  const liveRenderbuffers = new Set<WebGLRenderbuffer>();

  const gl: WebGL2CarRendererContext &
    WebGL2ErrorContext & { isContextLost(): boolean } = {
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

    isContextLost: () => lost,
    getError: () => (lost ? 0x9242 : GL_NO_ERROR_CODE),

    createShader: (type) => ({ id: nextId++, type }) as unknown as WebGLShader,
    deleteShader: () => {},
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    createProgram: () => {
      const p = { id: nextId++ } as unknown as WebGLProgram;
      livePrograms.add(p);
      return p;
    },
    deleteProgram: (p) => {
      if (p !== null) livePrograms.delete(p);
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
      liveVaos.add(vao);
      return vao;
    },
    deleteVertexArray: (vao) => {
      if (vao !== null) liveVaos.delete(vao);
    },
    bindVertexArray: () => {},
    createBuffer: () => {
      const buf = { id: nextId++ } as unknown as WebGLBuffer;
      liveBuffers.add(buf);
      return buf;
    },
    deleteBuffer: (buf) => {
      if (buf !== null) liveBuffers.delete(buf);
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
      liveTextures.add(tex);
      return tex;
    },
    deleteTexture: (tex) => {
      if (tex !== null) liveTextures.delete(tex);
    },
    activeTexture: () => {},
    bindTexture: () => {},
    texParameteri: () => {},
    texParameterf: () => {},
    pixelStorei: (pname, param) => {
      if (pname === gl.UNPACK_ALIGNMENT) unpackAlignment = param;
    },
    getParameter: (pname) => {
      if (pname === gl.UNPACK_ALIGNMENT) return unpackAlignment;
      if (pname === gl.MAX_SAMPLES) return 4;
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
    deleteFramebuffer: (fbo) => {
      if (fbo !== null) liveFramebuffers.delete(fbo);
    },
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
    deleteRenderbuffer: (rb) => {
      if (rb !== null) liveRenderbuffers.delete(rb);
    },
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

  const canvas: GlCanvasTarget = {
    width: 800,
    height: 600,
    clientWidth: 800,
    clientHeight: 600,
    getContext: (id) => (id === 'webgl2' ? (gl as unknown as ReturnType<GlCanvasTarget['getContext']>) : null),
    addEventListener(type: string, listener: (event: Event) => void): void {
      let bucket = listeners.get(type);
      if (bucket === undefined) {
        bucket = new Set();
        listeners.set(type, bucket);
      }
      bucket.add(listener);
    },
    removeEventListener(type: string, listener: (event: Event) => void): void {
      listeners.get(type)?.delete(listener);
    },
  };

  const loseContext = (): { defaultPrevented: boolean } => {
    lost = true;
    let defaultPrevented = false;
    const event = {
      type: 'webglcontextlost',
      preventDefault(): void {
        defaultPrevented = true;
      },
    } as unknown as Event;
    for (const listener of listeners.get('webglcontextlost') ?? []) {
      listener(event);
    }
    // Simulate driver wiping old GPU objects on context loss.
    livePrograms.clear();
    liveVaos.clear();
    liveBuffers.clear();
    liveTextures.clear();
    liveFramebuffers.clear();
    liveRenderbuffers.clear();
    return { defaultPrevented };
  };

  const restoreContext = (): void => {
    lost = false;
    const event = { type: 'webglcontextrestored' } as unknown as Event;
    for (const listener of listeners.get('webglcontextrestored') ?? []) {
      listener(event);
    }
  };

  return {
    gl,
    canvas,
    loseContext,
    restoreContext,
    getLiveCounts: () => ({
      programs: livePrograms.size,
      vaos: liveVaos.size,
      buffers: liveBuffers.size,
      textures: liveTextures.size,
      framebuffers: liveFramebuffers.size,
      renderbuffers: liveRenderbuffers.size,
    }),
  };
}

function makeTestCarModel(): CarModel {
  const vertices: readonly (readonly [number, number, number, number])[] = [
    [-2000, 0, -4000, 0],
    [2000, 0, -4000, 0],
    [2000, 1500, 4000, 0],
    [-2000, 1500, 4000, 0],
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
              paletteRaw: 0x0000,
              uvs: [
                [0, 0],
                [64, 0],
                [64, 64],
                [0, 0],
              ],
            },
          ],
          uvQuads: [
            {
              vertices: [3, 2, 1, 0],
              normals: [3, 2, 1, 0],
              faceType: CDO_FACE_TYPE_UV_QUAD,
              paletteRaw: 0x0001,
              uvs: [
                [0, 0],
                [64, 0],
                [64, 64],
                [0, 64],
              ],
            },
          ],
        },
        { maxDistance: 15, vertices, normals, uvTriangles: [], uvQuads: [] },
        { maxDistance: 300, vertices, normals, uvTriangles: [], uvQuads: [] },
      ],
    }),
  );
  const cdp = parseCdp(buildSyntheticCdp({ colorCount: 2, colorIds: [0x30, 0x31] }));
  return buildCarModel(cdo, { texture: cdp, variant: 'day' });
}

describe('WebGL2 context lost / restored recovery (M7.9)', () => {
  it('stops rAF on webglcontextlost and restores CarRenderer, paint, PS1 options, and camera from AssetRepository cache without re-reading VOL', async () => {
    const harness = createContextLossHarness();
    const glContext = new GlContext(harness.canvas, {
      getDevicePixelRatio: () => 1,
      createResizeObserver: () => ({ observe: () => {}, disconnect: () => {} }),
    });

    const volInfo: VolInfo = {
      fingerprint: 'fp_recovery_001',
      fileCount: 2,
      entryCount: 3,
      warnings: [],
      variant: 'unknown',
    };
    const entries: VolEntry[] = [
      { path: 'carobj/a1000.cdo.gz', kind: 'file', address: 2048, size: 512, unixTime: 0, isGzip: true },
      { path: 'carobj/a1000.cdp.gz', kind: 'file', address: 4096, size: 512, unixTime: 0, isGzip: true },
    ];

    const model = makeTestCarModel();
    const loadCarResources = vi.fn(async () => ({ carModel: model }));
    const backend: AssetRepositoryWorkerBackend = {
      list: async () => entries,
      read: async () => new Uint8Array(0),
      readDecompressed: async () => new Uint8Array(0),
      loadCarResources,
    };

    const repo = new AssetRepository({ volInfo, entries, backend });
    const inputManager = new InputManager({ initialContext: 'viewer' });
    let nextRafId = 1;
    const activeRafs = new Set<number>();

    const session = new CarViewerSession({
      glContext,
      gl: harness.gl,
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
    expect(loadCarResources).toHaveBeenCalledTimes(1);

    // Customize mode, PS1 resolution, dithering, paint slot, and camera angle before context loss.
    session.setRenderMode('ps1');
    session.setPs1Resolution(512, 240);
    session.setPs1Dithering(false);
    session.setPaintSlot(1);
    inputManager.handleKeyEvent({ type: 'keydown', code: 'KeyD', repeat: false });
    inputManager.update(0.1);
    session.stepFrame(0.08);
    inputManager.handleKeyEvent({ type: 'keyup', code: 'KeyD', repeat: false });

    const beforeLoss = session.getSnapshot();
    expect(beforeLoss.renderMode).toBe('ps1');
    expect(beforeLoss.ps1Width).toBe(512);
    expect(beforeLoss.ps1Height).toBe(240);
    expect(beforeLoss.ps1Dithering).toBe(false);
    expect(beforeLoss.colorSlotIndex).toBe(1);
    expect(activeRafs.size).toBe(1);

    // 1. Trigger webglcontextlost.
    const lossEvent = harness.loseContext();
    expect(lossEvent.defaultPrevented).toBe(true);
    expect(activeRafs.size).toBe(0);
    expect(session.getSnapshot().contextLost).toBe(true);
    expect(session.getGpuResourceCounts()).toEqual(EMPTY_GPU_RESOURCE_COUNTS);

    // 2. Trigger webglcontextrestored.
    harness.restoreContext();
    const afterRestore = session.getSnapshot();
    expect(afterRestore.contextLost).toBe(false);
    expect(afterRestore.restoredCount).toBe(1);
    expect(afterRestore.running).toBe(true);
    expect(activeRafs.size).toBe(1);

    // Must NOT re-read from VOL / Worker!
    expect(loadCarResources).toHaveBeenCalledTimes(1);

    // Must preserve mode, PS1 settings, paint slot, and exact camera pose.
    expect(afterRestore.renderMode).toBe('ps1');
    expect(afterRestore.ps1Width).toBe(512);
    expect(afterRestore.ps1Height).toBe(240);
    expect(afterRestore.ps1Dithering).toBe(false);
    expect(afterRestore.colorSlotIndex).toBe(1);
    expect(afterRestore.cameraState).toEqual(beforeLoss.cameraState);

    // Fresh GPU objects recreated and rendering cleanly without GL error.
    expect(session.getGpuResourceCounts().programs).toBeGreaterThan(0);
    expect(session.getGpuResourceCounts()).toEqual(harness.getLiveCounts());
    expect(session.getDebugStats().glError.hasError).toBe(false);

    // 3. Dispose releases all restored GPU objects and detaches context listeners.
    session.dispose();
    glContext.dispose();
    expect(harness.getLiveCounts()).toEqual(EMPTY_GPU_RESOURCE_COUNTS);
    expect(session.getGpuResourceCounts()).toEqual(EMPTY_GPU_RESOURCE_COUNTS);
  });
});
