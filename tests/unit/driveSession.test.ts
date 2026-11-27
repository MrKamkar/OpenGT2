import { describe, expect, it, vi } from 'vitest';
import { AssetRepository } from '../../src/assets';
import { InputManager } from '../../src/core/input';
import { buildCarModel, parseCdo, parseCdp } from '../../src/formats/car';
import type { CarCatalogEntry } from '../../src/formats/gtdb';
import { buildTrackModel, parseTro, parseTrp, type TrackModel } from '../../src/formats/track';
import type { VolEntry, VolInfo } from '../../src/formats/vol';
import {
  ChaseCamera,
  DriveRenderer,
  DriveSession,
  EMPTY_GPU_RESOURCE_COUNTS,
  type GlCanvasTarget,
  GlContext,
  type WebGL2DriveRendererContext,
  buildCarWorldModelMatrix,
  computeCarVisualBottomY,
} from '../../src/renderer';
import { buildSyntheticCdo } from '../fixtures/buildCdo';
import { buildSyntheticCdp } from '../fixtures/buildCdp';
import { buildSyntheticTro, type SyntheticSegmentSpec } from '../fixtures/buildTro';
import { buildSyntheticTrp, encodeClutWord, encodeTpageWord, pack4BppPixels } from '../fixtures/buildTrp';

function createTestCatalogEntry(carId = 77): CarCatalogEntry {
  return {
    carId,
    carIdHex: `0x${carId.toString(16).padStart(8, '0')}`,
    name: { displayName: 'Drive Test Car', firstPart: 'Drive', secondPart: 'Test', isFallback: false },
    carData: {
      carId,
      brakePart: 0,
      specialCar: 0,
      weightPartId: 0,
      unk_0x0c: 0,
      unk_0x0e: 0,
      enginePartId: 0,
      unk_0x12: 0,
      unk_0x14: 0,
      unk_0x18: 0,
      turboPart: 0,
      drivetrainPart: 0,
      flywheel: 0,
      clutch: 0,
      unk_0x24: 0,
      differential: 0,
      transmission: 0,
      suspension: 0,
      unk_0x2c: 0,
      frontTyres: 0,
      rearTyres: 0,
      unk_0x34: 0,
      rimsCode3: 0,
      manufacturerId: 0,
      nameFirstPartIndex: 0,
      nameSecondPartIndex: 0,
      unk_0x40: 0,
      year: 99,
      unk_0x42: 0,
      newPrice: 25000,
    },
    dimensions: {
      carId,
      unk_0x04: 0,
      length: 4200,
      height: 1300,
      unk_0x0c: 0,
      weightKg: 1180,
      rmWeightMultiplier: 55,
      unk_0x11: 0,
      unk_0x12: 0,
    },
    engine: {
      carId,
      engineTypeNameIndex: 0,
      engineTypeName2Index: 0,
      unk_0x08: 0,
      unk_0x0a: 0,
      bandAcceleration: [1600, 2200, 2700, 3000, 2850, 2450, 2000],
      engineCc: 2400,
      ps: 260,
      maxPowerRpmRaw: 700,
      torqueKgmRaw: 300,
      torqueRpmStringIndex: 0,
      baseUnits: [1, 1, 1, 1, 1],
      bandRpms: [10, 22, 36, 52, 62, 70, 76],
      bandPointCount: 7,
    },
    engineSummary: null,
    gearboxes: [
      {
        carId,
        price: 0,
        type: 0,
        unk_0x09: 0,
        unk_0x0a: new Uint8Array(16),
        finalGear: 3900,
        unk_0x1c: 0,
        unk_0x20: 0,
      },
    ],
    suspensions: [],
    frontTyres: [],
    rearTyres: [],
    racingModifications: [],
  };
}

function makeTestCarModel(color15 = 0x001f) {
  const cdo = parseCdo(
    buildSyntheticCdo({
      lods: [
        {
          maxDistance: 5,
          vertices: [
            [-2000, -1000, -4000, 0],
            [2000, -1000, -4000, 0],
            [2000, 1500, 4000, 0],
            [-2000, 1500, 4000, 0],
          ],
          normals: [
            [0, 500, 0],
            [0, 500, 0],
            [0, 500, 0],
            [0, 500, 0],
          ],
        },
        { maxDistance: 15 },
        { maxDistance: 300 },
      ],
    }),
  );
  const cdp = parseCdp(
    buildSyntheticCdp({
      colorCount: 2,
      colorIds: [0x30, 0x31],
      slots: [
        { colorId: 0x30, palettes: [[0x0000, color15]] },
        { colorId: 0x31, palettes: [[0x0000, 0x7c00]] },
      ],
      pixels: new Uint8Array(256 * 224).fill(1),
    }),
  );
  return buildCarModel(cdo, { texture: cdp, variant: 'day' });
}

function makeTestTrackModel(includeCollision = true, color15 = 0x03e0): TrackModel {
  const pal = new Array<number>(16).fill(color15);
  pal[0] = 0x0000;
  const trp = parseTrp(
    buildSyntheticTrp({
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
    }),
  );

  const segments: SyntheticSegmentSpec[] = [];
  for (let cellIdx = -1; cellIdx < 6; cellIdx += 1) {
    const cellCenterRawY = cellIdx * 4096 + 2048;
    segments.push({
      prevSegment: cellIdx <= -1 ? 0 : cellIdx,
      nextSegment: cellIdx >= 5 ? 0 : cellIdx + 2,
      centerRaw: [0, cellCenterRawY, 0],
      subMesh0: {
        localVertices: [
          [-2560, 0, 0],
          [-2560, 4096, 0],
          [2560, 4096, 0],
          [2560, 0, 0],
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
    });
  }

  const tro = parseTro(
    buildSyntheticTro({
      trackLengthRaw: 65536 * 400,
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
      segments,
    }),
  );
  return buildTrackModel(tro, trp, { includeCollision, includeLod1: false });
}

function createDriveGlHarness() {
  const livePrograms = new Set<object>();
  const liveVaos = new Set<object>();
  const liveBuffers = new Set<object>();
  const liveTextures = new Set<object>();
  const liveFramebuffers = new Set<object>();
  const liveRenderbuffers = new Set<object>();
  const listeners = new Map<string, Set<(event: { preventDefault(): void }) => void>>();
  let contextLost = false;
  let glErrorCode = 0;

  const gl = {
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
    BLEND: 0x0be2,
    FUNC_ADD: 0x8006,
    FUNC_REVERSE_SUBTRACT: 0x800b,
    ONE: 1,
    ZERO: 0,
    SRC_ALPHA: 0x0302,
    ONE_MINUS_SRC_ALPHA: 0x0303,
    CONSTANT_COLOR: 0x8001,
    COLOR_BUFFER_BIT: 0x4000,
    DEPTH_BUFFER_BIT: 0x0100,
    MAX_SAMPLES: 0x8d57,

    createShader: () => ({}),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    deleteShader: () => {},
    createProgram: () => {
      const obj = {};
      livePrograms.add(obj);
      return obj;
    },
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    deleteProgram: (p: object | null) => {
      if (p !== null) livePrograms.delete(p);
    },
    useProgram: () => {},
    getUniformLocation: () => ({}),
    uniform1i: () => {},
    uniform2i: () => {},
    uniform2f: () => {},
    uniform3f: () => {},
    uniform4f: () => {},
    uniformMatrix4fv: () => {},
    createVertexArray: () => {
      const obj = {};
      liveVaos.add(obj);
      return obj;
    },
    deleteVertexArray: (v: object | null) => {
      if (v !== null) liveVaos.delete(v);
    },
    bindVertexArray: () => {},
    createBuffer: () => {
      const obj = {};
      liveBuffers.add(obj);
      return obj;
    },
    deleteBuffer: (b: object | null) => {
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
    drawArrays: () => {},
    blendEquation: () => {},
    blendFunc: () => {},
    blendColor: () => {},
    createTexture: () => {
      const obj = {};
      liveTextures.add(obj);
      return obj;
    },
    deleteTexture: (t: object | null) => {
      if (t !== null) liveTextures.delete(t);
    },
    activeTexture: () => {},
    bindTexture: () => {},
    texParameteri: () => {},
    texParameterf: () => {},
    pixelStorei: () => {},
    getParameter: (pname: number) => (pname === 0x8d57 ? 4 : 4),
    getExtension: () => null,
    texImage2D: () => {},
    texImage3D: () => {},
    texSubImage3D: () => {},
    generateMipmap: () => {},
    createFramebuffer: () => {
      const obj = {};
      liveFramebuffers.add(obj);
      return obj;
    },
    deleteFramebuffer: (f: object | null) => {
      if (f !== null) liveFramebuffers.delete(f);
    },
    bindFramebuffer: () => {},
    framebufferTexture2D: () => {},
    framebufferRenderbuffer: () => {},
    checkFramebufferStatus: () => 0x8cd5,
    blitFramebuffer: () => {},
    createRenderbuffer: () => {
      const obj = {};
      liveRenderbuffers.add(obj);
      return obj;
    },
    deleteRenderbuffer: (r: object | null) => {
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
    getError: () => glErrorCode,
    isContextLost: () => contextLost,
  } as unknown as WebGL2DriveRendererContext;

  const canvas: GlCanvasTarget = {
    width: 800,
    height: 600,
    clientWidth: 800,
    clientHeight: 600,
    getContext: () => gl as unknown as WebGL2RenderingContext,
    addEventListener(type, listener) {
      let set = listeners.get(type);
      if (set === undefined) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(listener as (event: { preventDefault(): void }) => void);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener as (event: { preventDefault(): void }) => void);
    },
  };

  return {
    gl,
    canvas,
    loseContext: () => {
      contextLost = true;
      glErrorCode = 0x9242;
      for (const listener of listeners.get('webglcontextlost') ?? []) {
        listener({ preventDefault: () => {} });
      }
      livePrograms.clear();
      liveVaos.clear();
      liveBuffers.clear();
      liveTextures.clear();
      liveFramebuffers.clear();
      liveRenderbuffers.clear();
    },
    restoreContext: () => {
      contextLost = false;
      glErrorCode = 0;
      for (const listener of listeners.get('webglcontextrestored') ?? []) {
        listener({ preventDefault: () => {} });
      }
    },
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

describe('DriveRenderer, AssetRepository collision upgrade, and DriveSession (M9.9)', () => {
  it('aligns car visual bottom cleanly to physics ground plane with -Z forward preserved', () => {
    const carModel = makeTestCarModel();
    const bottomY = computeCarVisualBottomY(carModel);
    expect(bottomY).toBeCloseTo(-1000 / 4096, 5);

    const comHeight = 0.48;
    const mat = buildCarWorldModelMatrix(
      { position: { x: 2, y: comHeight, z: -5 }, orientation: { x: 0, y: 0, z: 0, w: 1 } },
      comHeight,
      bottomY,
    );

    // Local point (0, bottomY, 0) transforms to world (2, 0, -5), sitting flush on y = 0 ground.
    const worldY = (mat[5] ?? 0) * bottomY + (mat[13] ?? 0);
    expect(worldY).toBeCloseTo(0, 5);
    // Forward -Z axis remains (0, 0, -1) for identity orientation.
    expect(mat[8]).toBeCloseTo(0, 6);
    expect(mat[10]).toBeCloseTo(1, 6);
  });

  it('upgrades cached TrackModel when includeCollision: true is requested after includeCollision: false', async () => {
    const noColTrack = makeTestTrackModel(false);
    const withColTrack = makeTestTrackModel(true);
    const loadTrackResources = vi.fn(
      async (params: { includeCollision?: boolean }) => ({
        trackModel: params.includeCollision === true ? withColTrack : noColTrack,
      }),
    );

    const entries: VolEntry[] = [
      { path: 'crsobj/test_trk.tro.gz', kind: 'file', address: 2048, size: 100, unixTime: 0, isGzip: true },
    ];
    const volInfo: VolInfo = {
      fingerprint: 'fp_col_up',
      fileCount: 1,
      entryCount: 2,
      warnings: [],
      variant: 'unknown',
    };

    const repo = new AssetRepository({
      volInfo,
      entries,
      backend: {
        list: async () => entries,
        read: async () => new Uint8Array(0),
        readDecompressed: async () => new Uint8Array(0),
        loadCarResources: vi.fn(),
        loadTrackResources,
      },
    });

    const first = await repo.getTrackModel('test_trk', { includeCollision: false });
    expect(first.collision).toBeUndefined();
    expect(loadTrackResources).toHaveBeenCalledTimes(1);

    const second = await repo.getTrackModel('test_trk', { includeCollision: true });
    expect(second.collision).toBeDefined();
    expect(loadTrackResources).toHaveBeenCalledTimes(2);

    // Subsequent request hits upgraded cache without another worker load
    const third = await repo.getTrackModel('test_trk', { includeCollision: true });
    expect(third).toBe(second);
    expect(loadTrackResources).toHaveBeenCalledTimes(2);
  });

  it('maintains constant live GPU counts across 20 car/track/mode switches and drops to 0 on dispose()', () => {
    const harness = createDriveGlHarness();
    const renderer = new DriveRenderer(harness.gl, { initialMode: 'hd' });
    const carA = makeTestCarModel(0x001f);
    const carB = makeTestCarModel(0x7c00);
    const trkA = makeTestTrackModel(true, 0x03e0);
    const trkB = makeTestTrackModel(true, 0x7fff);

    renderer.setTrack(trkA);
    renderer.setCar(carA, { colorSlotIndex: 0 });
    const cam = new ChaseCamera();
    const pose = { position: { x: 0, y: 0.45, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 } };
    cam.snapToPose(pose);

    // Warm up both HD and PS1 FBOs before checking steady-state live GPU handle counts.
    renderer.setMode('ps1');
    renderer.render(cam, pose, 0.45, 800, 600);
    renderer.setMode('hd');
    renderer.render(cam, pose, 0.45, 800, 600);
    const countsAfterWarmup = harness.getLiveCounts();

    for (let i = 1; i <= 20; i += 1) {
      renderer.setMode(i % 2 === 1 ? 'ps1' : 'hd');
      renderer.setTrack(i % 2 === 1 ? trkB : trkA);
      renderer.setCar(i % 2 === 1 ? carB : carA, { colorSlotIndex: i % 2 });
      renderer.render(cam, pose, 0.45, 800, 600);
    }
    const countsAfterLoop = harness.getLiveCounts();
    expect(countsAfterLoop).toEqual(countsAfterWarmup);

    renderer.dispose();
    expect(harness.getLiveCounts()).toEqual(EMPTY_GPU_RESOURCE_COUNTS);
  });

  it('drives car forward via InputManager, supports reset/camera/pause, and recovers cleanly on webglcontextrestored', async () => {
    const harness = createDriveGlHarness();
    const glContext = new GlContext(harness.canvas, {
      getDevicePixelRatio: () => 1,
      createResizeObserver: () => ({ observe: () => {}, disconnect: () => {} }),
    });

    const carModel = makeTestCarModel();
    const trackModel = makeTestTrackModel(true);
    const loadCarResources = vi.fn(async () => ({ carModel }));
    const loadTrackResources = vi.fn(async () => ({ trackModel }));

    const entries: VolEntry[] = [
      { path: 'carobj/a1000.cdo.gz', kind: 'file', address: 2048, size: 100, unixTime: 0, isGzip: true },
      { path: 'crsobj/syn_trk.tro.gz', kind: 'file', address: 4096, size: 100, unixTime: 0, isGzip: true },
    ];
    const repo = new AssetRepository({
      volInfo: {
        fingerprint: 'fp_drive_sess',
        fileCount: 2,
        entryCount: 3,
        warnings: [],
        variant: 'unknown',
      },
      entries,
      backend: {
        list: async () => entries,
        read: async () => new Uint8Array(0),
        readDecompressed: async () => new Uint8Array(0),
        loadCarResources,
        loadTrackResources,
      },
    });

    const input = new InputManager({ initialContext: 'race' });
    let nextRafId = 1;
    const activeRafs = new Set<number>();

    const session = new DriveSession({
      glContext,
      gl: harness.gl,
      inputManager: input,
      assetRepository: repo,
      gamepadProvider: () => [],
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
    const ok = await session.loadSession({
      carEntry: createTestCatalogEntry(77),
      bodyCode: 'a1000',
      trackStem: 'syn_trk',
    });
    expect(ok).toBe(true);
    expect(session.getSnapshot().ready).toBe(true);
    const startZ = session.getTelemetry().pose.position.z;

    // Accelerate with ArrowUp
    input.handleKeyEvent({ type: 'keydown', code: 'ArrowUp', repeat: false });
    for (let i = 0; i < 40; i += 1) {
      session.stepFrame(0.05);
    }
    input.handleKeyEvent({ type: 'keyup', code: 'ArrowUp', repeat: false });

    const movedTelem = session.getTelemetry();
    expect(movedTelem.speedKph).toBeGreaterThan(20);
    expect(movedTelem.pose.position.z).toBeLessThan(startZ - 5);
    expect(movedTelem.elapsedSeconds).toBeGreaterThan(1.5);

    // Cycle camera via KeyC
    input.handleKeyEvent({ type: 'keydown', code: 'KeyC', repeat: false });
    session.stepFrame(0.016);
    input.handleKeyEvent({ type: 'keyup', code: 'KeyC', repeat: false });
    expect(session.getSnapshot().cameraPreset).toBe('close');

    // Pause and resume via Escape / KeyP
    input.handleKeyEvent({ type: 'keydown', code: 'KeyP', repeat: false });
    session.stepFrame(0.016);
    input.handleKeyEvent({ type: 'keyup', code: 'KeyP', repeat: false });
    expect(session.getSnapshot().paused).toBe(true);
    const pausedTime = session.getTelemetry().elapsedSeconds;
    session.stepFrame(0.05);
    expect(session.getTelemetry().elapsedSeconds).toBe(pausedTime);

    input.handleKeyEvent({ type: 'keydown', code: 'Escape', repeat: false });
    session.stepFrame(0.016);
    input.handleKeyEvent({ type: 'keyup', code: 'Escape', repeat: false });
    expect(session.getSnapshot().paused).toBe(false);

    // Reset via KeyR
    input.handleKeyEvent({ type: 'keydown', code: 'KeyR', repeat: false });
    session.stepFrame(0.016);
    input.handleKeyEvent({ type: 'keyup', code: 'KeyR', repeat: false });
    expect(session.getTelemetry().speedKph).toBeLessThan(1);
    expect(session.getTelemetry().elapsedSeconds).toBe(0);
    expect(session.getTelemetry().pose.position.z).toBeCloseTo(startZ, 2);

    // WebGL context loss + restore recovers from cache with 0 extra worker loads
    session.setRenderMode('ps1');
    harness.loseContext();
    expect(activeRafs.size).toBe(0);
    expect(session.getSnapshot().contextLost).toBe(true);

    harness.restoreContext();
    expect(session.getSnapshot().contextLost).toBe(false);
    expect(session.getSnapshot().restoredCount).toBe(1);
    expect(session.getSnapshot().running).toBe(true);
    expect(session.getSnapshot().renderMode).toBe('ps1');
    expect(loadCarResources).toHaveBeenCalledTimes(1);
    expect(loadTrackResources).toHaveBeenCalledTimes(1);

    // Inactive session must stay paused across context loss/restore with 0 GPU allocations
    session.pause();
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
