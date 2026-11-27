import { Buffer } from 'node:buffer';
import { chromium, expect, test, type Page } from '@playwright/test';
import { gzipSync } from 'fflate';
import { CDO_FACE_TYPE_UV_QUAD } from '../../src/formats/car/cdo';
import { encodeCarId } from '../../src/formats/gtdb';
import { buildSyntheticCdo } from '../fixtures/buildCdo';
import { buildSyntheticCdp } from '../fixtures/buildCdp';
import { buildSyntheticGtmodeData, buildSyntheticUnistrdb } from '../fixtures/buildGtdb';
import { buildSyntheticTro } from '../fixtures/buildTro';
import { buildSyntheticTrp, encodeClutWord, encodeTpageWord, pack4BppPixels } from '../fixtures/buildTrp';
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

  return { httpErrors, failedRequests, externalRequests, consoleErrors, pageErrors };
}

function assertCleanMonitors(monitors: PageErrorMonitors): void {
  expect(monitors.httpErrors, 'Expected zero HTTP 4xx/5xx responses').toEqual([]);
  expect(monitors.failedRequests, 'Expected zero failed requests').toEqual([]);
  expect(monitors.externalRequests, 'Expected zero external network requests').toEqual([]);
  expect(monitors.consoleErrors, 'Expected zero console.error messages').toEqual([]);
  expect(monitors.pageErrors, 'Expected zero uncaught page errors').toEqual([]);
}

function buildTrackPair(color15: number) {
  const pal = new Array<number>(16).fill(color15);
  pal[0] = 0x0000;
  const trp = buildSyntheticTrp({
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

  // Wide road segments along -Z (raw +Y) plus one segment behind the camera (+Z / raw -Y) for culling check.
  // In raw TRO (+Z up): (x, y) horizontal ground CW perimeter -> (-x, y1) -> (-x, y2) -> (x, y2) -> (x, y1)
  const makeRoadSeg = (idx: number, nextSeg: number, prevSeg: number, y0: number, y1: number) => ({
    prevSegment: prevSeg,
    nextSegment: nextSeg,
    centerRaw: [0, Math.round((y0 + y1) * 0.5), 0] as const,
    subMesh0: {
      localVertices: [
        [-2560, y0, 0] as const,
        [-2560, y1, 0] as const,
        [2560, y1, 0] as const,
        [2560, y0, 0] as const,
      ],
      polygons: [
        {
          listIndex: 6 as const,
          vertices: [0, 1, 2, 3] as const,
          uvIndex: 0,
          colors: [{ r: 128, g: 128, b: 128 }],
        },
      ],
    },
    subMesh1: { localVertices: [], polygons: [] },
  });

  const tro = buildSyntheticTro({
    trackLengthRaw: 65536 * 150,
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
      makeRoadSeg(0, 1, 2, 0, 1600),         // Z in [-25, 0]
      makeRoadSeg(1, 2, 0, 1600, 3200),      // Z in [-50, -25]
      makeRoadSeg(2, 0, 1, 3200, 4800),      // Z in [-75, -50]
      makeRoadSeg(3, 0, 2, -32000, -30400),  // Z in [+475, +500] (behind camera -> culled!)
    ],
  });

  return {
    troGz: gzipSync(tro, { mtime: 0 }),
    trpGz: gzipSync(trp, { mtime: 0 }),
  };
}

function createSyntheticMixedCarAndTrackVol(): Uint8Array {
  const carId = encodeCarId('a1000');
  const gtmodeData = buildSyntheticGtmodeData({
    cars: [
      {
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
        nameFirstPartIndex: 0,
        nameSecondPartIndex: 1,
        unk_0x40: 0,
        year: 98,
        unk_0x42: 0,
        newPrice: 25000,
      },
    ],
    dimensions: [
      {
        carId,
        unk_0x04: 0,
        length: 4200,
        height: 1280,
        unk_0x0c: 0,
        weightKg: 1150,
        rmWeightMultiplier: 65,
        unk_0x11: 0,
        unk_0x12: 0,
      },
    ],
    engines: [
      {
        carId,
        engineTypeNameIndex: 2,
        engineTypeName2Index: 3,
        unk_0x08: 0,
        unk_0x0a: 0,
        bandAcceleration: new Array<number>(16).fill(0xffff),
        engineCc: 1998,
        ps: 280,
        maxPowerRpmRaw: 750,
        torqueKgmRaw: 300,
        torqueRpmStringIndex: 4,
        baseUnits: [100, 0, 0, 80, 75],
        bandRpms: new Array<number>(16).fill(0xff),
        bandPointCount: 10,
      },
    ],
    racingModifications: [],
  });
  const unistrdb = buildSyntheticUnistrdb(['Alpha', 'GT', 'I4', 'Turbo', '6000 rpm']);

  const cdo = buildSyntheticCdo({
    lods: [
      {
        maxDistance: 5,
        vertices: [
          [-2000, -1000, -2000, 0],
          [2000, -1000, -2000, 0],
          [2000, 1000, 2000, 0],
          [-2000, 1000, 2000, 0],
        ],
        normals: [
          [0, 500, 0],
          [0, 500, 0],
          [0, 500, 0],
          [0, 500, 0],
        ],
        uvQuads: [
          {
            vertices: [0, 1, 2, 3],
            normals: [0, 0, 0, 0],
            renderFlags: 0,
            faceType: CDO_FACE_TYPE_UV_QUAD,
            paletteRaw: 0,
            uvs: [
              [0, 0],
              [32, 0],
              [32, 32],
              [0, 32],
            ],
          },
        ],
      },
      { maxDistance: 15, vertices: [[0, 0, 0, 0]], normals: [[0, 500, 0]] },
      { maxDistance: 300, vertices: [[0, 0, 0, 0]], normals: [[0, 500, 0]] },
    ],
  });
  const cdp = buildSyntheticCdp({
    colorCount: 1,
    colorIds: [0x30],
    slots: [{ colorId: 0x30, palettes: [[0x0000, 0x001f]] }],
    pixels: new Uint8Array(256 * 224).fill(1),
  });

  // Track A: green (0x03E0), Track B: blue (0x7C00)
  const trackA = buildTrackPair(0x03e0);
  const trackB = buildTrackPair(0x7c00);

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
        { kind: 'file', name: 'a1000.cdo.gz', data: gzipSync(cdo, { mtime: 0 }) },
        { kind: 'file', name: 'a1000.cdp.gz', data: gzipSync(cdp, { mtime: 0 }) },
      ],
    },
    {
      kind: 'dir',
      name: 'crsobj',
      children: [
        { kind: 'file', name: 'syn_alpha.tro.gz', data: trackA.troGz },
        { kind: 'file', name: 'syn_alpha.trp.gz', data: trackA.trpGz },
        { kind: 'file', name: 'syn_beta.tro.gz', data: trackB.troGz },
        { kind: 'file', name: 'syn_beta.trp.gz', data: trackB.trpGz },
      ],
    },
  ]).bytes;
}

test.describe('OpenGT2 M8.9 Track Viewer, Freecam, Culling & Recovery', () => {
  test('switches to Tracks tab, loads track with progress, renders HD & PS1 with culling, moves freecam via WSAD+Arrows/KeyR, and recovers from WEBGL_lose_context', async ({
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
      const volBytes = createSyntheticMixedCarAndTrackVol();

      await page.goto(buildPageUrl(resolvedBaseUrl, 'debug=1'), { waitUntil: 'load' });
      const appRoot = page.locator('#app');
      await expect(appRoot).toHaveAttribute('data-worker', 'ready', { timeout: 10_000 });
      await expect(appRoot).toHaveAttribute('data-webgl2', 'ready');

      await page.locator('[data-testid="file-input"]').setInputFiles({
        name: 'SYNTHETIC_TRACK_VOL.VOL',
        mimeType: 'application/octet-stream',
        buffer: Buffer.from(volBytes),
      });

      await expect(page.locator('[data-testid="car-viewer"]')).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('[data-testid="car-viewer"] [data-testid="nav-mode-tracks"]')).toBeVisible();

      // Switch to Tracks tab.
      await page.locator('[data-testid="car-viewer"] [data-testid="nav-mode-tracks"]').click();
      await expect(appRoot).toHaveAttribute('data-view-mode', 'tracks');
      await expect(page.locator('[data-testid="track-viewer"]')).toBeVisible();
      expect(await page.evaluate(() => window.__viewer?.getSnapshot().running)).toBe(false);

      // Wait for initial track (syn_alpha) to finish loading.
      await expect
        .poll(async () =>
          page.evaluate(() => {
            const snap = window.__trackViewer?.getSnapshot();
            return snap !== undefined && !snap.loading && snap.activeModel !== null;
          }),
        )
        .toBe(true);

      // 1. Verify non-empty HD green render, frustum culling, and zero GL errors.
      const hdSample = await page.evaluate(() => window.__trackViewer?.sampleCenterPixels(48));
      expect(hdSample).toBeDefined();
      expect(hdSample!.nonBackgroundPixels).toBeGreaterThan(20);
      expect(hdSample!.avgG).toBeGreaterThan(hdSample!.avgR + 40);

      const hdStats = await page.evaluate(() => window.__trackViewer?.getDebugStats());
      expect(hdStats?.renderStats.totalSegments).toBe(4);
      expect(hdStats?.renderStats.visibleSegments).toBeGreaterThan(0);
      expect(hdStats?.renderStats.culledSegments).toBeGreaterThanOrEqual(1);
      expect(hdStats?.renderStats.drawCalls).toBeGreaterThan(0);
      expect(hdStats?.renderStats.renderedTriangles).toBeGreaterThan(0);
      expect(hdStats?.glError.hasError).toBe(false);
      const loadsAfterFirst = hdStats?.cacheStats.workerLoads ?? 0;
      expect(loadsAfterFirst).toBe(1);

      // 2. Freecam movement via KeyW + ArrowUp, search-input isolation ('r'), and KeyR teleport.
      const canvas = page.locator('canvas.ogt2-canvas');
      await canvas.click();

      const startPos = await page.evaluate(
        () => window.__trackViewer?.getSnapshot().cameraState.position ?? [0, 0, 0],
      );
      await page.keyboard.down('KeyW');
      await page.waitForTimeout(140);
      await page.keyboard.up('KeyW');
      const posAfterW = await page.evaluate(
        () => window.__trackViewer?.getSnapshot().cameraState.position ?? [0, 0, 0],
      );
      expect(posAfterW[2]).toBeLessThan(startPos[2] - 0.5);

      await page.keyboard.down('ArrowUp');
      await page.waitForTimeout(140);
      await page.keyboard.up('ArrowUp');
      const posAfterArrow = await page.evaluate(
        () => window.__trackViewer?.getSnapshot().cameraState.position ?? [0, 0, 0],
      );
      expect(posAfterArrow[2]).toBeLessThan(posAfterW[2] - 0.5);

      // Typing 'r' in search input must NOT teleport the camera!
      const trackSearch = page.locator('[data-testid="track-search"]');
      await trackSearch.click();
      await trackSearch.pressSequentially('r');
      const posAfterSearchR = await page.evaluate(
        () => window.__trackViewer?.getSnapshot().cameraState.position ?? [0, 0, 0],
      );
      expect(posAfterSearchR[2]).toBeCloseTo(posAfterArrow[2], 3);
      await trackSearch.fill('');

      // Pressing KeyR with canvas focused teleports camera back to start!
      await canvas.click();
      await page.keyboard.down('KeyR');
      await expect
        .poll(async () => {
          const p = await page.evaluate(
            () => window.__trackViewer?.getSnapshot().cameraState.position ?? [0, 0, 0],
          );
          return Math.abs(p[2] - startPos[2]);
        })
        .toBeLessThan(0.1);
      await page.keyboard.up('KeyR');

      // 3. Toggle HD Remaster -> PS1 without reloading VOL.
      await page.locator('[data-testid="track-mode-ps1"]').click();
      await expect(page.locator('[data-testid="track-ps1-options"]')).toBeVisible();
      await page.locator('[data-testid="track-ps1-res"]').selectOption('512x240');

      const ps1Sample = await page.evaluate(() => window.__trackViewer?.sampleCenterPixels(48));
      expect(ps1Sample!.nonBackgroundPixels).toBeGreaterThan(20);
      expect(ps1Sample!.avgG).toBeGreaterThan(ps1Sample!.avgR + 40);
      expect(
        await page.evaluate(() => window.__trackViewer?.getDebugStats().cacheStats.workerLoads),
      ).toBe(loadsAfterFirst);
      expect(
        await page.evaluate(() => window.__trackViewer?.getDebugStats().glError.hasError),
      ).toBe(false);

      // 4. Verify every <input>, <select>, <textarea> has unique non-empty id and name.
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

      // 5. Simulate WEBGL_lose_context & restoration from cache while CarViewer is inactive.
      const stateBeforeLoss = await page.evaluate(() => {
        const snap = window.__trackViewer?.getSnapshot();
        const stats = window.__trackViewer?.getDebugStats();
        return {
          workerLoads: stats?.cacheStats.workerLoads ?? 0,
          position: snap?.cameraState.position,
          renderMode: snap?.renderMode,
          ps1Width: snap?.ps1Width,
        };
      });

      const lostOk = await page.evaluate(() => {
        const canvasEl = document.querySelector('canvas.ogt2-canvas') as HTMLCanvasElement | null;
        const gl = canvasEl?.getContext('webgl2');
        const ext = gl?.getExtension('WEBGL_lose_context') ?? null;
        (window as unknown as { __testTrackLoseExt?: WEBGL_lose_context | null }).__testTrackLoseExt =
          ext;
        if (ext === null) return false;
        ext.loseContext();
        return true;
      });
      expect(lostOk).toBe(true);
      await expect(appRoot).toHaveAttribute('data-webgl2', 'lost', { timeout: 10_000 });
      await expect(page.locator('[data-testid="track-context-lost"]')).toBeVisible();

      await page.evaluate(() => {
        (
          window as unknown as { __testTrackLoseExt?: WEBGL_lose_context | null }
        ).__testTrackLoseExt?.restoreContext();
      });
      await expect(appRoot).toHaveAttribute('data-webgl2', 'ready', { timeout: 10_000 });
      await expect(page.locator('[data-testid="track-context-lost"]')).toBeHidden();
      await expect
        .poll(async () => page.evaluate(() => window.__trackViewer?.getSnapshot().restoredCount ?? 0))
        .toBeGreaterThanOrEqual(1);

      const afterRestore = await page.evaluate(() => {
        const snap = window.__trackViewer?.getSnapshot();
        const stats = window.__trackViewer?.getDebugStats();
        const sample = window.__trackViewer?.sampleCenterPixels(48);
        return {
          workerLoads: stats?.cacheStats.workerLoads ?? 0,
          position: snap?.cameraState.position,
          renderMode: snap?.renderMode,
          ps1Width: snap?.ps1Width,
          glError: stats?.glError,
          nonBackgroundPixels: sample?.nonBackgroundPixels ?? 0,
          carRunning: window.__viewer?.getSnapshot().running ?? false,
        };
      });

      expect(afterRestore.workerLoads).toBe(stateBeforeLoss.workerLoads);
      expect(afterRestore.position).toEqual(stateBeforeLoss.position);
      expect(afterRestore.renderMode).toBe(stateBeforeLoss.renderMode);
      expect(afterRestore.ps1Width).toBe(stateBeforeLoss.ps1Width);
      expect(afterRestore.nonBackgroundPixels).toBeGreaterThan(20);
      expect(afterRestore.glError?.hasError).toBe(false);
      // Inactive Cars 3D session MUST remain paused after context restoration!
      expect(afterRestore.carRunning).toBe(false);

      // 6. Switch to second track (syn_beta, blue) and verify cache + Inspector tab navigation + reset.
      await page.locator('[data-testid="track-item"][data-track-stem="syn_beta"]').click();
      await expect
        .poll(async () =>
          page.evaluate(() => {
            const snap = window.__trackViewer?.getSnapshot();
            return snap?.trackStem === 'syn_beta' && !snap.loading && snap.activeModel !== null;
          }),
        )
        .toBe(true);
      const blueSample = await page.evaluate(() => window.__trackViewer?.sampleCenterPixels(48));
      expect(blueSample!.nonBackgroundPixels).toBeGreaterThan(20);
      expect(blueSample!.avgB).toBeGreaterThan(blueSample!.avgG + 40);

      await page.locator('[data-testid="track-viewer"] [data-testid="nav-mode-inspector"]').click();
      await expect(appRoot).toHaveAttribute('data-view-mode', 'inspector');
      await page.locator('[data-testid="inspector-nav-tracks"]').click();
      await expect(appRoot).toHaveAttribute('data-view-mode', 'tracks');

      await page.locator('[data-testid="track-reset-file"]').click();
      await expect(appRoot).toHaveAttribute('data-state', 'NoFile');
      await expect(page.locator('[data-testid="track-viewer"]')).toHaveCount(0);

      assertCleanMonitors(monitors);
    } finally {
      await context.close();
      await isolatedBrowser.close();
    }
  });
});
