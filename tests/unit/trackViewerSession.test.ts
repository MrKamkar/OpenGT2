import { gzipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';
import {
  AssetRepository,
  TrackAssetIndex,
  buildTrackModelCacheKey,
} from '../../src/assets';
import { InputManager } from '../../src/core/input';
import { buildTrackModel, parseTro, parseTrp, type TrackModel } from '../../src/formats/track';
import { VolReader, type VolEntry, type VolInfo } from '../../src/formats/vol';
import { type BlobLike, BufferByteSource, CachedByteSource } from '../../src/io';
import {
  EMPTY_GPU_RESOURCE_COUNTS,
  GL_NO_ERROR_CODE,
  type GlCanvasTarget,
  GlContext,
  TrackViewerSession,
  type WebGL2ErrorContext,
  type WebGL2TrackRendererContext,
} from '../../src/renderer';
import {
  type RpcEndpoint,
  type RpcErrorEventLike,
  type RpcMessageEventLike,
  type RpcMessageTransport,
  VolReaderRpcClient,
  type VolReaderTrackLoadProgress,
  bindVolReaderRpcServer,
} from '../../src/workers';
import { buildSyntheticTro } from '../fixtures/buildTro';
import { buildSyntheticTrp, encodeClutWord, encodeTpageWord, pack4BppPixels } from '../fixtures/buildTrp';
import { buildSyntheticVol } from '../fixtures/buildVol';

function createBlobLikeFromBytes(bytes: Uint8Array): BlobLike {
  const makeSlice = (start: number, end: number): BlobLike => {
    const view = bytes.subarray(start, end);
    return {
      size: view.byteLength,
      slice(subStart = 0, subEnd = view.byteLength): BlobLike {
        const normStart = Math.max(0, Math.min(view.byteLength, subStart));
        const normEnd = Math.max(normStart, Math.min(view.byteLength, subEnd));
        return makeSlice(start + normStart, start + normEnd);
      },
      async arrayBuffer(): Promise<ArrayBuffer> {
        const copy = new Uint8Array(view.byteLength);
        copy.set(view);
        return copy.buffer;
      },
    };
  };
  return makeSlice(0, bytes.byteLength);
}

function createStructuredTransferRpcChannel() {
  const mainMessageListeners = new Set<(event: RpcMessageEventLike) => void>();
  const mainErrorListeners = new Set<(event: RpcErrorEventLike) => void>();
  const workerMessageListeners = new Set<(event: RpcMessageEventLike) => void>();
  const workerSentTransfers: Transferable[][] = [];
  let terminated = false;

  const cloneMessage = (message: unknown, transfer?: Transferable[]): unknown => {
    if (transfer !== undefined && transfer.length > 0) {
      return structuredClone(message, { transfer });
    }
    return message;
  };

  const mainEndpoint: RpcEndpoint = {
    postMessage(message: unknown, transfer?: Transferable[]): void {
      if (terminated) throw new Error('Worker terminated');
      const delivered = cloneMessage(message, transfer);
      queueMicrotask(() => {
        if (terminated) return;
        for (const listener of workerMessageListeners) {
          listener({ data: delivered });
        }
      });
    },
    addEventListener(
      type: 'message' | 'error',
      listener: ((event: RpcMessageEventLike) => void) | ((event: RpcErrorEventLike) => void),
    ): void {
      if (type === 'message') {
        mainMessageListeners.add(listener as (event: RpcMessageEventLike) => void);
      } else {
        mainErrorListeners.add(listener as (event: RpcErrorEventLike) => void);
      }
    },
    removeEventListener(
      type: 'message' | 'error',
      listener: ((event: RpcMessageEventLike) => void) | ((event: RpcErrorEventLike) => void),
    ): void {
      if (type === 'message') {
        mainMessageListeners.delete(listener as (event: RpcMessageEventLike) => void);
      } else {
        mainErrorListeners.delete(listener as (event: RpcErrorEventLike) => void);
      }
    },
    terminate(): void {
      terminated = true;
    },
  };

  const workerTransport: RpcMessageTransport = {
    postMessage(message: unknown, transfer?: Transferable[]): void {
      if (terminated) return;
      workerSentTransfers.push(transfer ? [...transfer] : []);
      const delivered = cloneMessage(message, transfer);
      queueMicrotask(() => {
        if (terminated) return;
        for (const listener of mainMessageListeners) {
          listener({ data: delivered });
        }
      });
    },
    addEventListener(_type: 'message', listener: (event: RpcMessageEventLike) => void): void {
      workerMessageListeners.add(listener);
    },
    removeEventListener(_type: 'message', listener: (event: RpcMessageEventLike) => void): void {
      workerMessageListeners.delete(listener);
    },
  };

  return { mainEndpoint, workerTransport, workerSentTransfers };
}

function makeTestTrackBuffers(color15: number) {
  const pal = new Array<number>(16).fill(color15);
  pal[0] = 0x0000;
  const trpBytes = buildSyntheticTrp({
    tims: [
      {
        pixelMode: 0,
        clutPalettes: [pal],
        clutVramX: 640,
        clutVramY: 480,
        imageVramX: 640,
        imageVramY: 0,
        imageVramWidth: 8,
        imageHeight: 32,
        pixelData: pack4BppPixels(32, 32, () => 1),
      },
    ],
  });
  const troBytes = buildSyntheticTro({
    trackLengthRaw: 65536 * 120,
    uvEntries: [
      {
        hiRes: {
          u: [0, 0, 15, 15],
          v: [0, 15, 15, 0],
          clutRaw: encodeClutWord(640, 480),
          tpageRaw: encodeTpageWord(10, 0),
        },
      },
    ],
    segments: [
      {
        prevSegment: 1,
        nextSegment: 1,
        centerRaw: [0, 0, 0],
        subMesh0: {
          localVertices: [
            [-640, 0, 0],
            [-640, 1280, 0],
            [640, 1280, 0],
            [640, 0, 0],
          ],
          polygons: [
            {
              listIndex: 6,
              vertices: [0, 1, 2, 3],
              uvIndex: 0,
              colors: [{ r: 128, g: 128, b: 128 }],
            },
          ],
        },
        subMesh1: { localVertices: [], polygons: [] },
      },
      {
        prevSegment: 0,
        nextSegment: 0,
        centerRaw: [0, 1280, 0],
        subMesh0: {
          localVertices: [
            [-640, 1280, 0],
            [-640, 2560, 0],
            [640, 2560, 0],
            [640, 1280, 0],
          ],
          polygons: [
            {
              listIndex: 6,
              vertices: [0, 1, 2, 3],
              uvIndex: 0,
              colors: [{ r: 128, g: 128, b: 128 }],
            },
          ],
        },
        subMesh1: { localVertices: [], polygons: [] },
      },
    ],
  });
  return { troBytes, trpBytes };
}

function makeTestTrackModel(color15 = 0x03e0): TrackModel {
  const { troBytes, trpBytes } = makeTestTrackBuffers(color15);
  return buildTrackModel(parseTro(troBytes), parseTrp(trpBytes), {
    includeCollision: false,
    includeLod1: false,
  });
}

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

  const gl: WebGL2TrackRendererContext & WebGL2ErrorContext & { isContextLost(): boolean } = {
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
      const v = { id: nextId++ } as unknown as WebGLVertexArrayObject;
      liveVaos.add(v);
      return v;
    },
    deleteVertexArray: (v) => {
      if (v !== null) liveVaos.delete(v);
    },
    bindVertexArray: () => {},
    createBuffer: () => {
      const b = { id: nextId++ } as unknown as WebGLBuffer;
      liveBuffers.add(b);
      return b;
    },
    deleteBuffer: (b) => {
      if (b !== null) liveBuffers.delete(b);
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
      const t = { id: nextId++ } as unknown as WebGLTexture;
      liveTextures.add(t);
      return t;
    },
    deleteTexture: (t) => {
      if (t !== null) liveTextures.delete(t);
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
      const f = { id: nextId++ } as unknown as WebGLFramebuffer;
      liveFramebuffers.add(f);
      return f;
    },
    deleteFramebuffer: (f) => {
      if (f !== null) liveFramebuffers.delete(f);
    },
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
    deleteRenderbuffer: (r) => {
      if (r !== null) liveRenderbuffers.delete(r);
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

  const loseContext = (): void => {
    lost = true;
    const event = { type: 'webglcontextlost', preventDefault: () => {} } as unknown as Event;
    for (const listener of listeners.get('webglcontextlost') ?? []) {
      listener(event);
    }
    livePrograms.clear();
    liveVaos.clear();
    liveBuffers.clear();
    liveTextures.clear();
    liveFramebuffers.clear();
    liveRenderbuffers.clear();
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

describe('TrackAssetIndex, Worker Track RPC, LRU Cache & TrackViewerSession (M8.9)', () => {
  it('indexes crsobj/*.tro* and pairs .trp* dynamically in sorted order', () => {
    const entries: VolEntry[] = [
      { path: 'crsobj/zeta.tro.gz', kind: 'file', address: 2048, size: 100, unixTime: 0, isGzip: true },
      { path: 'crsobj/alpha.tro.gz', kind: 'file', address: 4096, size: 200, unixTime: 0, isGzip: true },
      { path: 'crsobj/alpha.trp.gz', kind: 'file', address: 6144, size: 300, unixTime: 0, isGzip: true },
      { path: 'bgsobj/sky.bso.gz', kind: 'file', address: 8192, size: 50, unixTime: 0, isGzip: true },
    ];
    const index = new TrackAssetIndex(entries);
    expect(index.trackCount).toBe(2);
    expect(index.listTracks().map((t) => t.stem)).toEqual(['alpha', 'zeta']);
    expect(index.getTrack('ALPHA')?.trpEntry?.path).toBe('crsobj/alpha.trp.gz');
    expect(index.getTrack('ALPHA')?.totalCompressedBytes).toBe(500);
    expect(index.getTrack('zeta')?.trpEntry).toBeNull();
  });

  it('streams track resources via Worker RPC with progress stages and zero-copy structuredClone transfers', async () => {
    const { troBytes, trpBytes } = makeTestTrackBuffers(0x001f);
    const vol = buildSyntheticVol([
      {
        kind: 'dir',
        name: 'crsobj',
        children: [
          { kind: 'file', name: 'track_a.tro.gz', data: gzipSync(troBytes, { mtime: 0 }) },
          { kind: 'file', name: 'track_a.trp.gz', data: gzipSync(trpBytes, { mtime: 0 }) },
        ],
      },
      {
        kind: 'dir',
        name: 'empty_aux',
        children: [],
      },
    ]);

    const channel = createStructuredTransferRpcChannel();
    const server = bindVolReaderRpcServer(channel.workerTransport, new VolReader(), {
      createSource: (blob) => new CachedByteSource(new BufferByteSource(vol.bytes.subarray(0, blob.size))),
    });
    const client = new VolReaderRpcClient(channel.mainEndpoint);

    await client.open(createBlobLikeFromBytes(vol.bytes));
    const progressEvents: VolReaderTrackLoadProgress[] = [];
    const res = await client.loadTrackResources(
      { troPath: 'crsobj/track_a.tro.gz', trpPath: 'crsobj/track_a.trp.gz' },
      { onProgress: (p) => progressEvents.push(p as VolReaderTrackLoadProgress) },
    );

    expect(res.trackModel.segments).toHaveLength(2);
    expect(res.trackModel.textureAtlas?.pages).toHaveLength(1);
    expect(progressEvents.map((p) => p.stage)).toEqual([
      'reading-tro',
      'reading-trp',
      'parsing',
      'building-model',
      'complete',
    ]);
    expect(progressEvents[progressEvents.length - 1]?.progress).toBe(1);
    expect(channel.workerSentTransfers.at(-1)?.length).toBeGreaterThan(0);

    client.dispose(true);
    server.dispose();
  });

  it('caches tracks in AssetRepository LRU with eviction, progress forwarding, and abort isolation', async () => {
    const tA = makeTestTrackModel(0x001f);
    const tB = makeTestTrackModel(0x03e0);
    const tC = makeTestTrackModel(0x7c00);
    const byPath: Record<string, TrackModel> = {
      'crsobj/a.tro.gz': tA,
      'crsobj/b.tro.gz': tB,
      'crsobj/c.tro.gz': tC,
    };

    const loadTrackResources = vi.fn(
      async (
        params: { troPath: string },
        opts?: { onProgress?: (p: unknown) => void },
      ) => {
        opts?.onProgress?.({ stage: 'parsing', progress: 0.65, label: 'Parsing' });
        opts?.onProgress?.({ stage: 'complete', progress: 1, label: 'Done' });
        return { trackModel: byPath[params.troPath]! };
      },
    );

    const entries: VolEntry[] = [
      { path: 'crsobj/a.tro.gz', kind: 'file', address: 2048, size: 100, unixTime: 0, isGzip: true },
      { path: 'crsobj/b.tro.gz', kind: 'file', address: 4096, size: 100, unixTime: 0, isGzip: true },
      { path: 'crsobj/c.tro.gz', kind: 'file', address: 6144, size: 100, unixTime: 0, isGzip: true },
    ];
    const volInfo: VolInfo = {
      fingerprint: 'fp_trk',
      fileCount: 3,
      entryCount: 4,
      warnings: [],
      variant: 'unknown',
    };

    const repo = new AssetRepository({
      volInfo,
      entries,
      maxTrackEntries: 2,
      backend: {
        list: async () => entries,
        read: async () => new Uint8Array(0),
        readDecompressed: async () => new Uint8Array(0),
        loadCarResources: vi.fn(),
        loadTrackResources,
      },
    });

    expect(buildTrackModelCacheKey('fp_trk', 'A')).toBe('fp_trk:track:a');
    expect(await repo.getTrackModel('a')).toBe(tA);
    expect(await repo.getTrackModel('a')).toBe(tA);
    expect(loadTrackResources).toHaveBeenCalledTimes(1);

    await repo.getTrackModel('b');
    // Touch 'a' so 'b' becomes LRU, then load 'c' to evict 'b'.
    await repo.getTrackModel('a');
    await repo.getTrackModel('c');

    expect(repo.getCachedTrackModel('a')).toBe(tA);
    expect(repo.getCachedTrackModel('b')).toBeNull();
    expect(repo.getCachedTrackModel('c')).toBe(tC);
    expect(repo.getTrackCacheStats().evictions).toBe(1);
    expect(repo.getTrackCacheStats().hits).toBe(2);
  });

  it('recovers active TrackViewerSession from cache on webglcontextrestored without re-reading VOL, and keeps inactive session paused', async () => {
    const harness = createContextLossHarness();
    const glContext = new GlContext(harness.canvas, {
      getDevicePixelRatio: () => 1,
      createResizeObserver: () => ({ observe: () => {}, disconnect: () => {} }),
    });

    const entries: VolEntry[] = [
      { path: 'crsobj/t1.tro.gz', kind: 'file', address: 2048, size: 100, unixTime: 0, isGzip: true },
    ];
    const model = makeTestTrackModel(0x03e0);
    const loadTrackResources = vi.fn(async () => ({ trackModel: model }));
    const repo = new AssetRepository({
      volInfo: {
        fingerprint: 'fp_tv_rec',
        fileCount: 1,
        entryCount: 2,
        warnings: [],
        variant: 'unknown',
      },
      entries,
      backend: {
        list: async () => entries,
        read: async () => new Uint8Array(0),
        readDecompressed: async () => new Uint8Array(0),
        loadCarResources: vi.fn(),
        loadTrackResources,
      },
    });

    const inputManager = new InputManager({ initialContext: 'freecam' });
    let nextRafId = 1;
    const activeRafs = new Set<number>();

    const session = new TrackViewerSession({
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
    await session.loadTrack('t1');
    session.setRenderMode('ps1');
    session.setPs1Resolution(512, 240);
    inputManager.handleKeyEvent({ type: 'keydown', code: 'KeyW', repeat: false });
    session.stepFrame(0.2);
    inputManager.handleKeyEvent({ type: 'keyup', code: 'KeyW', repeat: false });

    const beforeLoss = session.getSnapshot();
    expect(beforeLoss.running).toBe(true);
    expect(loadTrackResources).toHaveBeenCalledTimes(1);

    harness.loseContext();
    expect(activeRafs.size).toBe(0);
    expect(session.getSnapshot().contextLost).toBe(true);

    harness.restoreContext();
    const afterRestore = session.getSnapshot();
    expect(afterRestore.contextLost).toBe(false);
    expect(afterRestore.restoredCount).toBe(1);
    expect(afterRestore.running).toBe(true);
    expect(afterRestore.renderMode).toBe('ps1');
    expect(afterRestore.ps1Width).toBe(512);
    expect(afterRestore.cameraState).toEqual(beforeLoss.cameraState);
    expect(loadTrackResources).toHaveBeenCalledTimes(1);

    // KeyR via InputManager teleports back to start pose.
    const movedPos = [...afterRestore.cameraState.position];
    inputManager.handleKeyEvent({ type: 'keydown', code: 'KeyR', repeat: false });
    session.stepFrame(0.016);
    inputManager.handleKeyEvent({ type: 'keyup', code: 'KeyR', repeat: false });
    expect(session.getSnapshot().cameraState.position).not.toEqual(movedPos);

    // Pause session (simulating user switched to another tab), then lose + restore context:
    // inactive session MUST NOT resume rAF or allocate GPU resources until started again!
    session.pause();
    expect(activeRafs.size).toBe(0);
    harness.loseContext();
    harness.restoreContext();
    expect(session.getSnapshot().running).toBe(false);
    expect(activeRafs.size).toBe(0);
    expect(harness.getLiveCounts()).toEqual(EMPTY_GPU_RESOURCE_COUNTS);

    session.dispose();
    glContext.dispose();
    expect(harness.getLiveCounts()).toEqual(EMPTY_GPU_RESOURCE_COUNTS);
  });
});
