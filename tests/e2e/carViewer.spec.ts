import { Buffer } from 'node:buffer';
import { chromium, expect, test, type Page } from '@playwright/test';
import { gzipSync } from 'fflate';
import { CDO_FACE_TYPE_UV_QUAD } from '../../src/formats/car/cdo';
import { encodeCarId } from '../../src/formats/gtdb';
import { buildSyntheticCdo } from '../fixtures/buildCdo';
import { buildSyntheticCdp } from '../fixtures/buildCdp';
import { buildSyntheticGtmodeData, buildSyntheticUnistrdb } from '../fixtures/buildGtdb';
import { buildSyntheticVol } from '../fixtures/buildVol';

function buildPageUrl(baseURL: string, query?: string): string {
  const normalized = baseURL.endsWith('/') ? baseURL : `${baseURL}/`;
  const url = new URL(normalized);
  if (query !== undefined) {
    const params = new URLSearchParams(query);
    for (const [key, value] of params.entries()) {
      url.searchParams.set(key, value);
    }
  }
  return url.toString();
}

interface PageErrorMonitors {
  readonly httpErrors: string[];
  readonly failedRequests: string[];
  readonly externalRequests: string[];
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
}

function attachMonitors(page: Page, baseURL: string): PageErrorMonitors {
  const expectedOrigin = new URL(baseURL).origin;
  const httpErrors: string[] = [];
  const failedRequests: string[] = [];
  const externalRequests: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  page.on('request', (request) => {
    const url = request.url();
    if (url.startsWith('blob:') || url.startsWith('data:')) {
      return;
    }
    try {
      const origin = new URL(url).origin;
      if (origin !== expectedOrigin) {
        externalRequests.push(url);
      }
    } catch {
      externalRequests.push(url);
    }
  });

  page.on('response', (response) => {
    if (response.status() >= 400) {
      httpErrors.push(`${response.status()} ${response.url()}`);
    }
  });

  page.on('requestfailed', (request) => {
    failedRequests.push(`${request.url()} (${request.failure()?.errorText ?? 'unknown'})`);
  });

  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });

  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });

  return {
    httpErrors,
    failedRequests,
    externalRequests,
    consoleErrors,
    pageErrors,
  };
}

function assertCleanMonitors(monitors: PageErrorMonitors): void {
  expect(monitors.httpErrors, 'Expected zero HTTP 4xx/5xx responses').toEqual([]);
  expect(monitors.failedRequests, 'Expected zero failed requests').toEqual([]);
  expect(monitors.externalRequests, 'Expected zero external network requests').toEqual([]);
  expect(monitors.consoleErrors, 'Expected zero console.error messages').toEqual([]);
  expect(monitors.pageErrors, 'Expected zero uncaught page errors').toEqual([]);
}

/**
 * Builds a double-sided textured cube model covering all 6 faces so center viewport pixels
 * unambiguously sample the car's active paint slot from any orbit angle.
 */
function buildSolidBoxCdo(scale = 1): Uint8Array {
  const sx = 3000 * scale;
  const sy = 1500 * scale;
  const sz = 4000 * scale;
  const vertices: readonly (readonly [number, number, number, number])[] = [
    [-sx, -sy, -sz, 0], // 0: L B F
    [sx, -sy, -sz, 0],  // 1: R B F
    [sx, sy, -sz, 0],   // 2: R T F
    [-sx, sy, -sz, 0],  // 3: L T F
    [-sx, -sy, sz, 0],  // 4: L B R
    [sx, -sy, sz, 0],   // 5: R B R
    [sx, sy, sz, 0],    // 6: R T R
    [-sx, sy, sz, 0],   // 7: L T R
  ];
  const normals: readonly (readonly [number, number, number])[] = [
    [0, 500, 0],
    [0, 0, 500],
    [500, 0, 0],
    [-500, 0, 0],
  ];
  const fullUvs: readonly [
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
    readonly [number, number],
  ] = [
    [0, 0],
    [64, 0],
    [64, 64],
    [0, 64],
  ];
  const quadFaces: readonly (readonly [number, number, number, number])[] = [
    [0, 1, 2, 3], // front
    [5, 4, 7, 6], // rear
    [4, 0, 3, 7], // left
    [1, 5, 6, 2], // right
    [3, 2, 6, 7], // top
    [4, 5, 1, 0], // bottom
  ];
  const makeLod = (maxDistance: number) => ({
    maxDistance,
    vertices,
    normals,
    triangles: [],
    quads: [],
    uvTriangles: [],
    uvQuads: quadFaces.map((q) => ({
      vertices: q,
      normals: [0, 0, 0, 0] as const,
      renderFlags: 0, // double-sided so all angles render reliably
      faceType: CDO_FACE_TYPE_UV_QUAD,
      paletteRaw: 0x0000,
      uvs: fullUvs,
    })),
  });

  return buildSyntheticCdo({
    lods: [makeLod(5), makeLod(15), makeLod(300)],
  });
}

function buildSolidPaintCdp(slot0Color15: number, slot1Color15: number): Uint8Array {
  const pixels = new Uint8Array(256 * 224).fill(1);
  return buildSyntheticCdp({
    colorCount: 2,
    colorIds: [0x30, 0x31],
    slots: [
      { colorId: 0x30, palettes: [[0x0000, slot0Color15]] },
      { colorId: 0x31, palettes: [[0x0000, slot1Color15]] },
    ],
    pixels,
  });
}

function createSyntheticCarViewerVol(): Uint8Array {
  const stockId = encodeCarId('a1000');
  const rmId = encodeCarId('a100r');
  const secondId = encodeCarId('b2000');

  const makeCar = (carId: number, firstIdx: number, secondIdx: number, year: number) => ({
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
    manufacturerId: 1,
    nameFirstPartIndex: firstIdx,
    nameSecondPartIndex: secondIdx,
    unk_0x40: 0,
    year,
    unk_0x42: 0,
    newPrice: 28000,
  });

  const makeDim = (carId: number, weightKg: number) => ({
    carId,
    unk_0x04: 0,
    length: 4200,
    height: 1280,
    unk_0x0c: 0,
    weightKg,
    rmWeightMultiplier: 65,
    unk_0x11: 0,
    unk_0x12: 0,
  });

  const makeEng = (carId: number, ps: number) => ({
    carId,
    engineTypeNameIndex: 4,
    engineTypeName2Index: 5,
    unk_0x08: 0,
    unk_0x0a: 0,
    bandAcceleration: new Array<number>(16).fill(0xffff),
    engineCc: 1998,
    ps,
    maxPowerRpmRaw: 750,
    torqueKgmRaw: 300,
    torqueRpmStringIndex: 6,
    baseUnits: [100, 0, 0, 80, 75],
    bandRpms: new Array<number>(16).fill(0xff),
    bandPointCount: 10,
  });

  const gtmodeData = buildSyntheticGtmodeData({
    cars: [makeCar(stockId, 0, 1, 98), makeCar(secondId, 2, 3, 99)],
    dimensions: [makeDim(stockId, 1180), makeDim(secondId, 1020)],
    engines: [makeEng(stockId, 280), makeEng(secondId, 340)],
    racingModifications: [
      {
        carId: stockId,
        price: 85000,
        rmBodyId: rmId,
        unk_0x0c: new Uint8Array(16),
      },
    ],
  });

  const unistrdb = buildSyntheticUnistrdb([
    'Alpha',
    'GT',
    'Beta',
    'RS',
    'I4',
    'Turbo',
    '6000 rpm',
  ]);

  // 0x001F = pure red, 0x03E0 = pure green, 0x7C00 = pure blue
  const dayCdo = gzipSync(buildSolidBoxCdo(1), { mtime: 0 });
  const dayCdp = gzipSync(buildSolidPaintCdp(0x001f, 0x03e0), { mtime: 0 });
  const nightCdo = gzipSync(buildSolidBoxCdo(1), { mtime: 0 });
  const nightCdp = gzipSync(buildSolidPaintCdp(0x7c00, 0x03e0), { mtime: 0 });
  const rmCdo = gzipSync(buildSolidBoxCdo(1.05), { mtime: 0 });
  const rmCdp = gzipSync(buildSolidPaintCdp(0x03e0, 0x001f), { mtime: 0 });
  const secondCdo = gzipSync(buildSolidBoxCdo(0.95), { mtime: 0 });
  const secondCdp = gzipSync(buildSolidPaintCdp(0x7c00, 0x001f), { mtime: 0 });

  return buildSyntheticVol([
    {
      kind: 'dir',
      name: 'carparam',
      children: [
        { kind: 'file', name: 'eng_gtmode_data.dat.gz', data: gzipSync(gtmodeData, { mtime: 0 }) },
        { kind: 'file', name: 'eng_unistrdb.dat.gz', data: gzipSync(unistrdb, { mtime: 0 }) },
      ],
    },
    {
      kind: 'dir',
      name: 'carobj',
      children: [
        { kind: 'file', name: 'a1000.cdo.gz', data: dayCdo },
        { kind: 'file', name: 'a1000.cdp.gz', data: dayCdp },
        { kind: 'file', name: 'a1000.cno.gz', data: nightCdo },
        { kind: 'file', name: 'a1000.cnp.gz', data: nightCdp },
        { kind: 'file', name: 'a100r.cdo.gz', data: rmCdo },
        { kind: 'file', name: 'a100r.cdp.gz', data: rmCdp },
        { kind: 'file', name: 'b2000.cdo.gz', data: secondCdo },
        { kind: 'file', name: 'b2000.cdp.gz', data: secondCdp },
      ],
    },
  ]).bytes;
}

test.describe('OpenGT2 M7.7–M7.9 3D Car Viewer & Context Recovery', () => {
  test('renders 3D car by default, switches paint & HD<->PS1 without reloading VOL, responds to WSAD+Arrows camera, and recovers from WEBGL_lose_context from cache', async ({
    baseURL,
  }) => {
    test.slow();
    expect(baseURL).toBeTruthy();
    const resolvedBaseUrl = baseURL ?? 'http://127.0.0.1:4173/';
    const isolatedBrowser = await chromium.launch({
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
      ],
    });
    const context = await isolatedBrowser.newContext();
    const page = await context.newPage();

    try {
      const monitors = attachMonitors(page, resolvedBaseUrl);
      const volBytes = createSyntheticCarViewerVol();

      await page.goto(buildPageUrl(resolvedBaseUrl, 'debug=1'), {
        waitUntil: 'load',
      });

    const appRoot = page.locator('#app');
    await expect(appRoot).toHaveAttribute('data-worker', 'ready', { timeout: 10_000 });
    await expect(appRoot).toHaveAttribute('data-webgl2', 'ready');

    // Upload synthetic VOL containing carparam + carobj -> 3D Viewer opens automatically.
    await page.locator('[data-testid="file-input"]').setInputFiles({
      name: 'SYNTHETIC_CAR_VIEWER.VOL',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from(volBytes),
    });

    await expect(page.locator('[data-testid="car-viewer"]')).toBeVisible({ timeout: 15_000 });
    await expect(appRoot).toHaveAttribute('data-view-mode', 'viewer');

    // Wait until initial car model finishes loading from Worker.
    await expect
      .poll(async () => page.evaluate(() => window.__viewer?.getSnapshot().activeModel !== null))
      .toBe(true);

    // 1. Non-empty render in default HD mode with red paint (slot 0) and 0 WebGL errors.
    const hdRedSample = await page.evaluate(() => window.__viewer?.sampleCenterPixels(48));
    expect(hdRedSample).toBeDefined();
    expect(hdRedSample!.nonBackgroundPixels).toBeGreaterThan(20);
    expect(hdRedSample!.avgR).toBeGreaterThan(hdRedSample!.avgG + 40);

    const workerLoadsInitial = await page.evaluate(
      () => window.__viewer?.getDebugStats().cacheStats.workerLoads ?? 0,
    );
    expect(workerLoadsInitial).toBe(1);

    const debugGlError = await page.evaluate(() => window.__viewer?.getDebugStats().glError);
    expect(debugGlError?.hasError).toBe(false);
    expect(debugGlError?.code).toBe(0);

    // 2. Switch paint slot 0 -> 1 (green) without reloading from VOL.
    await page.locator('[data-testid="viewer-paint-slot"][data-slot-index="1"]').click();
    await expect
      .poll(async () => page.evaluate(() => window.__viewer?.getSnapshot().colorSlotIndex))
      .toBe(1);

    const hdGreenSample = await page.evaluate(() => window.__viewer?.sampleCenterPixels(48));
    expect(hdGreenSample!.nonBackgroundPixels).toBeGreaterThan(20);
    expect(hdGreenSample!.avgG).toBeGreaterThan(hdGreenSample!.avgR + 40);
    expect(
      await page.evaluate(() => window.__viewer?.getDebugStats().cacheStats.workerLoads),
    ).toBe(workerLoadsInitial);

    // 3. Switch HD Remaster -> PS1 without reloading VOL, change PS1 resolution & dithering/OT.
    await page.locator('[data-testid="viewer-mode-ps1"]').click();
    await expect(page.locator('[data-testid="viewer-ps1-options"]')).toBeVisible();
    await page.locator('[data-testid="viewer-ps1-res"]').selectOption('512x240');
    await page.locator('[data-testid="viewer-ps1-ot"]').check();

    const ps1Sample = await page.evaluate(() => window.__viewer?.sampleCenterPixels(48));
    expect(ps1Sample!.nonBackgroundPixels).toBeGreaterThan(20);
    expect(ps1Sample!.avgG).toBeGreaterThan(ps1Sample!.avgR + 40);
    expect(
      await page.evaluate(() => window.__viewer?.getDebugStats().cacheStats.workerLoads),
    ).toBe(workerLoadsInitial);
    expect(
      await page.evaluate(() => window.__viewer?.getDebugStats().glError.hasError),
    ).toBe(false);

    // 4. Switch Stock -> Racing Modification (a100r) and Day -> Night on Stock.
    await page.locator('[data-testid="viewer-body-select"]').selectOption('a100r');
    await expect
      .poll(async () => page.evaluate(() => window.__viewer?.getSnapshot().bodyCode))
      .toBe('a100r');
    await expect
      .poll(async () => page.evaluate(() => window.__viewer?.getSnapshot().loading))
      .toBe(false);
    expect((await page.evaluate(() => window.__viewer?.sampleCenterPixels(48)))!.nonBackgroundPixels).toBeGreaterThan(20);

    await page.locator('[data-testid="viewer-body-select"]').selectOption('a1000');
    await expect
      .poll(async () => page.evaluate(() => window.__viewer?.getSnapshot().loading))
      .toBe(false);
    await page.locator('[data-testid="viewer-time-night"]').click();
    await expect
      .poll(async () => page.evaluate(() => window.__viewer?.getSnapshot().timeOfDay))
      .toBe('night');
    await expect
      .poll(async () => page.evaluate(() => window.__viewer?.getSnapshot().loading))
      .toBe(false);
    expect((await page.evaluate(() => window.__viewer?.sampleCenterPixels(48)))!.nonBackgroundPixels).toBeGreaterThan(20);

    // 5. Keyboard camera control (KeyD, ArrowRight, KeyC) and input focus isolation.
    const canvas = page.locator('canvas.ogt2-canvas');
    await canvas.click();

    const yawBefore = await page.evaluate(() => window.__viewer?.getSnapshot().cameraState.yaw ?? 0);
    await page.keyboard.down('KeyD');
    await page.waitForTimeout(120);
    await page.keyboard.up('KeyD');
    const yawAfterD = await page.evaluate(() => window.__viewer?.getSnapshot().cameraState.yaw ?? 0);
    expect(yawAfterD).not.toBeCloseTo(yawBefore, 3);

    await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(120);
    await page.keyboard.up('ArrowRight');
    const yawAfterArrow = await page.evaluate(
      () => window.__viewer?.getSnapshot().cameraState.yaw ?? 0,
    );
    expect(yawAfterArrow).not.toBeCloseTo(yawAfterD, 3);

    const presetBefore = await page.evaluate(
      () => window.__viewer?.getSnapshot().cameraState.presetIndex ?? 0,
    );
    await page.keyboard.down('KeyC');
    await expect
      .poll(async () =>
        page.evaluate(() => window.__viewer?.getSnapshot().cameraState.presetIndex ?? 0),
      )
      .not.toBe(presetBefore);
    await page.keyboard.up('KeyC');

    // Typing in search box must NOT move the camera.
    const viewerSearch = page.locator('[data-testid="viewer-car-search"]');
    const yawBeforeTyping = await page.evaluate(
      () => window.__viewer?.getSnapshot().cameraState.yaw ?? 0,
    );
    await viewerSearch.click();
    await viewerSearch.pressSequentially('alpha');
    const yawAfterTyping = await page.evaluate(
      () => window.__viewer?.getSnapshot().cameraState.yaw ?? 0,
    );
    expect(yawAfterTyping).toBe(yawBeforeTyping);
    await viewerSearch.fill('');

    // Verify all <input>, <select>, <textarea> have unique non-empty id and name.
    const formProblems = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('input, select, textarea')];
      const ids = new Set<string>();
      const names = new Set<string>();
      const issues: string[] = [];
      for (const node of nodes) {
        const id = node.id;
        const name = node.getAttribute('name') ?? '';
        if (!id || !name) {
          issues.push(`missing:${node.outerHTML}`);
        } else {
          if (ids.has(id)) issues.push(`dup-id:${id}`);
          if (names.has(name)) issues.push(`dup-name:${name}`);
          ids.add(id);
          names.add(name);
        }
      }
      return issues;
    });
    expect(formProblems).toEqual([]);

    // 6. Simulate WebGL2 context loss & restoration via WEBGL_lose_context.
    await page.locator('[data-testid="viewer-paint-slot"][data-slot-index="1"]').click();
    const stateBeforeLoss = await page.evaluate(() => {
      const snap = window.__viewer?.getSnapshot();
      const stats = window.__viewer?.getDebugStats();
      return {
        workerLoads: stats?.cacheStats.workerLoads ?? 0,
        yaw: snap?.cameraState.yaw ?? 0,
        renderMode: snap?.renderMode,
        colorSlotIndex: snap?.colorSlotIndex,
        ps1Width: snap?.ps1Width,
      };
    });

    const hasLoseExt = await page.evaluate(() => {
      const canvasEl = document.querySelector('canvas.ogt2-canvas') as HTMLCanvasElement | null;
      const gl = canvasEl?.getContext('webgl2');
      const ext = gl?.getExtension('WEBGL_lose_context') ?? null;
      (window as unknown as { __testLoseExt?: WEBGL_lose_context | null }).__testLoseExt = ext;
      if (ext === null) {
        return false;
      }
      ext.loseContext();
      return true;
    });
    expect(hasLoseExt).toBe(true);

    await expect(appRoot).toHaveAttribute('data-webgl2', 'lost', { timeout: 10_000 });
    await expect(page.locator('[data-testid="viewer-context-lost"]')).toBeVisible();

    await page.evaluate(() => {
      (window as unknown as { __testLoseExt?: WEBGL_lose_context | null }).__testLoseExt?.restoreContext();
    });

    await expect(appRoot).toHaveAttribute('data-webgl2', 'ready', { timeout: 10_000 });
    await expect(page.locator('[data-testid="viewer-context-lost"]')).toBeHidden();
    await expect
      .poll(async () => page.evaluate(() => window.__viewer?.getSnapshot().restoredCount ?? 0))
      .toBeGreaterThanOrEqual(1);

    const stateAfterRestore = await page.evaluate(() => {
      const snap = window.__viewer?.getSnapshot();
      const stats = window.__viewer?.getDebugStats();
      const sample = window.__viewer?.sampleCenterPixels(48);
      return {
        workerLoads: stats?.cacheStats.workerLoads ?? 0,
        yaw: snap?.cameraState.yaw ?? 0,
        renderMode: snap?.renderMode,
        colorSlotIndex: snap?.colorSlotIndex,
        ps1Width: snap?.ps1Width,
        glError: stats?.glError,
        nonBackgroundPixels: sample?.nonBackgroundPixels ?? 0,
      };
    });

    // Zero VOL re-reads, preserved state, non-empty frame, and zero GL errors!
    expect(stateAfterRestore.workerLoads).toBe(stateBeforeLoss.workerLoads);
    expect(stateAfterRestore.yaw).toBeCloseTo(stateBeforeLoss.yaw, 6);
    expect(stateAfterRestore.renderMode).toBe(stateBeforeLoss.renderMode);
    expect(stateAfterRestore.colorSlotIndex).toBe(stateBeforeLoss.colorSlotIndex);
    expect(stateAfterRestore.ps1Width).toBe(stateBeforeLoss.ps1Width);
    expect(stateAfterRestore.nonBackgroundPixels).toBeGreaterThan(20);
    expect(stateAfterRestore.glError?.hasError).toBe(false);

    // 7. Switch to Inspector and back to 3D Viewer, then clean reset via "Change File".
    await page.locator('[data-testid="nav-mode-inspector"]').click();
    await expect(appRoot).toHaveAttribute('data-view-mode', 'inspector');
    await expect(page.locator('[data-testid="archive-panel"]')).toBeVisible();

    await page.locator('[data-testid="inspector-nav-viewer"]').click();
    await expect(appRoot).toHaveAttribute('data-view-mode', 'viewer');
    await expect(page.locator('[data-testid="car-viewer"]')).toBeVisible();

      await page.locator('[data-testid="viewer-reset-file"]').click();
      await expect(appRoot).toHaveAttribute('data-state', 'NoFile');
      await expect(page.locator('[data-testid="car-viewer"]')).toHaveCount(0);

      assertCleanMonitors(monitors);
    } finally {
      await context.close();
      await isolatedBrowser.close();
    }
  });
});
