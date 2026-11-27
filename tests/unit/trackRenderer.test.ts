import { describe, expect, it } from 'vitest';
import { buildTrackModel, parseTro, parseTrp, type TrackModel } from '../../src/formats/track';
import {
  EMPTY_GPU_RESOURCE_COUNTS,
  FreeCamera,
  GL_NO_ERROR_CODE,
  type GpuResourceCounts,
  TrackRenderer,
  type WebGL2ErrorContext,
  type WebGL2TrackRendererContext,
  buildTrackMeshData,
  coalesceVisibleDrawRanges,
  prepareTrackTextureAtlasData,
} from '../../src/renderer';
import { buildSyntheticTro } from '../fixtures/buildTro';
import { buildSyntheticTrp, encodeClutWord, encodeTpageWord, pack4BppPixels } from '../fixtures/buildTrp';

interface RecordedDrawCall {
  readonly mode: number;
  readonly count: number;
  readonly type: number;
  readonly offset: number;
}

function createMockTrackGl() {
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
  const drawCalls: RecordedDrawCall[] = [];

  const trackDelete = <T>(set: Set<T>, obj: T | null, kind: string): void => {
    if (obj === null) {
      return;
    }
    if (!set.delete(obj)) {
      doubleDeletes.push(kind);
    }
  };

  const gl: WebGL2TrackRendererContext & WebGL2ErrorContext = {
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
    UNSIGNED_INT: 0x1405,
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
      const s = { id: nextId++, type } as unknown as WebGLShader;
      liveShaders.add(s);
      return s;
    },
    deleteShader: (s) => trackDelete(liveShaders, s, 'shader'),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    createProgram: () => {
      const p = { id: nextId++ } as unknown as WebGLProgram;
      livePrograms.add(p);
      return p;
    },
    deleteProgram: (p) => trackDelete(livePrograms, p, 'program'),
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
      const v = { id: nextId++ } as unknown as WebGLVertexArrayObject;
      liveVaos.add(v);
      return v;
    },
    deleteVertexArray: (v) => trackDelete(liveVaos, v, 'vao'),
    bindVertexArray: () => {},
    createBuffer: () => {
      const b = { id: nextId++ } as unknown as WebGLBuffer;
      liveBuffers.add(b);
      return b;
    },
    deleteBuffer: (b) => trackDelete(liveBuffers, b, 'buffer'),
    bindBuffer: () => {},
    bufferData: () => {},
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    vertexAttribIPointer: () => {},
    enable: () => {},
    disable: () => {},
    cullFace: () => {},
    frontFace: () => {},
    drawElements: (mode, count, type, offset) => {
      drawCalls.push({ mode, count, type, offset });
    },
    blendEquation: () => {},
    blendFunc: () => {},
    blendColor: () => {},

    createTexture: () => {
      const t = { id: nextId++ } as unknown as WebGLTexture;
      liveTextures.add(t);
      return t;
    },
    deleteTexture: (t) => trackDelete(liveTextures, t, 'texture'),
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
      const f = { id: nextId++ } as unknown as WebGLFramebuffer;
      liveFramebuffers.add(f);
      return f;
    },
    deleteFramebuffer: (f) => trackDelete(liveFramebuffers, f, 'framebuffer'),
    bindFramebuffer: () => {},
    framebufferTexture2D: () => {},
    framebufferRenderbuffer: () => {},
    checkFramebufferStatus: () => gl.FRAMEBUFFER_COMPLETE,
    blitFramebuffer: () => {},

    createRenderbuffer: () => {
      const r = { id: nextId++ } as unknown as WebGLRenderbuffer;
      liveRenderbuffers.add(r);
      return r;
    },
    deleteRenderbuffer: (r) => trackDelete(liveRenderbuffers, r, 'renderbuffer'),
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
    drawCalls,
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

function makeSyntheticTrack(seed = 0, cullingMode: 'ccw' | 'none' = 'ccw'): TrackModel {
  const pal0 = new Array<number>(16).fill(0x001f);
  pal0[0] = 0x0000; // transparent cutout index 0
  const pal1 = new Array<number>(16).fill(0x03e0);
  pal1[0] = 0x8000; // opaque black index 0

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
          pixelData: pack4BppPixels(32, 32, (x, y) => ((x + y) & 1) + 1),
        },
      ],
    }),
  );

  const makeSeg = (segIdx: number, yShiftRaw: number, uvIdx: number) => ({
    prevSegment: (segIdx + 2) % 3,
    nextSegment: (segIdx + 1) % 3,
    centerRaw: [0, yShiftRaw, 0] as const,
    subMesh0: {
      localVertices: [
        [-320, yShiftRaw, 0] as const,
        [-320, yShiftRaw + 640, 0] as const,
        [320, yShiftRaw + 640, 0] as const,
        [320, yShiftRaw, 0] as const,
      ],
      polygons: [
        {
          listIndex: 6 as const,
          vertices: [0, 1, 2, 3] as const,
          uvIndex: uvIdx,
          colors: [{ r: 128, g: 128, b: 128 }],
        },
        {
          listIndex: 1 as const,
          vertices: [0, 2, 1] as const,
          colors: [{ r: 200 + seed, g: 100, b: 50 }],
        },
      ],
    },
    subMesh1: { localVertices: [], polygons: [] },
  });

  const tpage10 = encodeTpageWord(10, 0);
  const tro = parseTro(
    buildSyntheticTro({
      trackLengthRaw: 65536 * 200,
      uvEntries: [
        {
          hiRes: {
            u: [0, 0, 15, 15],
            v: [0, 15, 15, 0],
            clutRaw: encodeClutWord(640, 480),
            tpageRaw: tpage10,
          },
        },
        {
          hiRes: {
            u: [16, 16, 31, 31],
            v: [0, 15, 15, 0],
            clutRaw: encodeClutWord(640, 481),
            tpageRaw: tpage10,
          },
        },
      ],
      segments: [
        makeSeg(0, 0, 0),          // Z in [-10, 0]
        makeSeg(1, 640, 1),        // Z in [-20, -10]
        makeSeg(2, 640 * 800, 0),  // Z ~ -8000 m (far beyond camera far=4000)
      ],
    }),
  );

  return buildTrackModel(tro, trp, { cullingMode, includeLod1: false, includeCollision: false });
}

describe('TrackRenderMesh & TrackRenderer (M8.7)', () => {
  it('groups indices by cullingMode, coalesces contiguous visible segments, and prepares shared R8/RGBA8 atlas data', () => {
    const track = makeSyntheticTrack(0, 'ccw');
    const meshData = buildTrackMeshData(track);
    expect(meshData.segmentDraws).toHaveLength(3);
    expect(meshData.triangleCount).toBe(9);
    expect(meshData.indicesUint32.length).toBe(27);

    // All 3 visible -> 1 coalesced CCW draw call.
    const allMask = new Uint8Array([1, 1, 1]);
    expect(coalesceVisibleDrawRanges(meshData.segmentDraws, allMask, 'ccw')).toEqual([
      { indexStart: 0, indexCount: 27 },
    ]);

    // Segment 1 culled -> splits into 2 separate coalesced CCW ranges.
    const gapMask = new Uint8Array([1, 0, 1]);
    expect(coalesceVisibleDrawRanges(meshData.segmentDraws, gapMask, 'ccw')).toEqual([
      { indexStart: 0, indexCount: 9 },
      { indexStart: 18, indexCount: 9 },
    ]);

    const atlasCpu = prepareTrackTextureAtlasData(track.textureAtlas);
    expect(atlasCpu.hasTextureData).toBe(true);
    expect(atlasCpu.pageCount).toBe(1);
    expect(atlasCpu.paletteCount).toBe(2);
    // Palette 0 entry 0 = 0x0000 -> transparent alpha 0; palette 1 entry 0 = 0x8000 -> opaque black alpha 255.
    expect(atlasCpu.paletteRgba8[3]).toBe(0);
    expect(atlasCpu.paletteRgba8[16 * 4 + 3]).toBe(255);
  });

  it('culls out-of-frustum segments, batches with UNSIGNED_INT, toggles HD/PS1 without texture re-upload, and leaks 0 GPU resources across 25 switches', () => {
    const mock = createMockTrackGl();
    const renderer = new TrackRenderer(mock.gl, { initialMode: 'hd' });
    const tracks = [
      makeSyntheticTrack(0, 'ccw'),
      makeSyntheticTrack(1, 'none'),
      makeSyntheticTrack(2, 'ccw'),
    ];
    const cam = new FreeCamera({ position: [0, 4, 2], yaw: 0, pitch: -0.1 });

    // Warm up both HD and PS1 FBOs so steady-state resource count includes both pipeline FBOs.
    renderer.setTrack(tracks[0]!);
    const hdStats = renderer.render(cam, 1280, 720, { wireframe: false });
    expect(hdStats.totalSegments).toBe(3);
    expect(hdStats.visibleSegments).toBe(2); // segment 2 at -8000m is culled
    expect(hdStats.culledSegments).toBe(1);
    expect(hdStats.drawCalls).toBe(1); // segments 0 + 1 coalesced into 1 draw call
    expect(hdStats.renderedTriangles).toBe(6);
    expect(mock.drawCalls.some((c) => c.type === mock.gl.UNSIGNED_INT)).toBe(true);

    renderer.setMode('ps1');
    const ps1Stats = renderer.render(cam, 1280, 720, { wireframe: true });
    expect(ps1Stats.visibleSegments).toBe(2);
    expect(ps1Stats.drawCalls).toBe(2); // 1 triangle batch + 1 wireframe batch

    renderer.setMode('hd');
    renderer.render(cam, 1280, 720, { wireframe: false });

    const baseline = mock.getLiveCounts();
    expect(mock.getLiveShaderCount()).toBe(0);
    expect(renderer.getResourceCounts()).toEqual(baseline);

    const resolutions = [
      [320, 240],
      [512, 240],
      [640, 480],
    ] as const;

    for (let step = 0; step < 25; step += 1) {
      const nextTrack = tracks[step % tracks.length]!;
      const mode = step % 2 === 0 ? 'hd' : 'ps1';
      renderer.setMode(mode);
      renderer.setTrack(nextTrack);
      const [rw, rh] = resolutions[step % resolutions.length]!;
      renderer.setPs1InternalResolution(rw, rh);
      renderer.render(cam, 1280, 720, { wireframe: step % 3 === 0 });
      if (mode === 'ps1') {
        renderer.setMode('hd');
        renderer.render(cam, 1280, 720);
      }

      expect(mock.getLiveCounts()).toEqual(baseline);
      expect(renderer.getResourceCounts()).toEqual(baseline);
      expect(renderer.pollGlError().hasError).toBe(false);
    }

    renderer.dispose();
    renderer.dispose();
    expect(mock.getLiveCounts()).toEqual(EMPTY_GPU_RESOURCE_COUNTS);
    expect(renderer.getResourceCounts()).toEqual(EMPTY_GPU_RESOURCE_COUNTS);
    expect(mock.doubleDeletes).toEqual([]);
  });

  it('drops JS GPU handles safely on invalidateOnContextLost without calling gl.delete*', () => {
    const mock = createMockTrackGl();
    const renderer = new TrackRenderer(mock.gl);
    const track = makeSyntheticTrack(0, 'ccw');
    const cam = new FreeCamera({ position: [0, 4, 2], yaw: 0, pitch: -0.1 });

    renderer.setTrack(track);
    renderer.render(cam, 800, 600);
    const liveBeforeLoss = mock.getLiveCounts();
    expect(liveBeforeLoss.programs).toBeGreaterThan(0);

    renderer.invalidateOnContextLost();
    expect(renderer.isDisposed()).toBe(true);
    expect(renderer.getResourceCounts()).toEqual(EMPTY_GPU_RESOURCE_COUNTS);
    // No gl.delete* calls were issued against the lost context.
    expect(mock.getLiveCounts()).toEqual(liveBeforeLoss);
    expect(mock.doubleDeletes).toEqual([]);
  });
});
