import { Buffer } from 'node:buffer';
import { chromium, expect, test, type Page } from '@playwright/test';
import { gzipSync } from 'fflate';
import { CDO_FACE_TYPE_UV_QUAD } from '../../src/formats/car/cdo';
import { encodeCarId } from '../../src/formats/gtdb';
import { buildSyntheticCdo } from '../fixtures/buildCdo';
import { buildSyntheticCdp } from '../fixtures/buildCdp';
import { buildSyntheticGtmodeData, buildSyntheticUnistrdb } from '../fixtures/buildGtdb';
import { buildSyntheticTro, type SyntheticSegmentSpec } from '../fixtures/buildTro';
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

function createSyntheticDriveVol(): Uint8Array {
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
          [-3000, 0, -4000, 0],
          [3000, 0, -4000, 0],
          [3000, 2600, 4000, 0],
          [-3000, 2600, 4000, 0],
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

  const pal = new Array<number>(16).fill(0x03e0);
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

  // 6 flat road segments covering Z in [+64, -320] m so car accelerates cleanly along -Z.
  const segments: SyntheticSegmentSpec[] = [];
  for (let cellIdx = -1; cellIdx < 5; cellIdx += 1) {
    const cellCenterRawY = cellIdx * 4096 + 2048;
    segments.push({
      prevSegment: cellIdx <= -1 ? 0 : cellIdx,
      nextSegment: cellIdx >= 4 ? 0 : cellIdx + 2,
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

  const tro = buildSyntheticTro({
    trackLengthRaw: 65536 * 320,
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
  });

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
        { kind: 'file', name: 'syn_drive.tro.gz', data: gzipSync(tro, { mtime: 0 }) },
        { kind: 'file', name: 'syn_drive.trp.gz', data: gzipSync(trp, { mtime: 0 }) },
      ],
    },
  ]).bytes;
}

test.describe('OpenGT2 M9.9 Drive Mode Integration & Recovery', () => {
  test('switches to Drive tab, renders track+car in HD & PS1, drives via KeyW/ArrowUp, resets via KeyR, pauses, and recovers from WEBGL_lose_context', async ({
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
      const volBytes = createSyntheticDriveVol();

      await page.goto(buildPageUrl(resolvedBaseUrl, 'debug=1'), { waitUntil: 'load' });
      const appRoot = page.locator('#app');
      await expect(appRoot).toHaveAttribute('data-worker', 'ready', { timeout: 10_000 });
      await expect(appRoot).toHaveAttribute('data-webgl2', 'ready');

      await page.locator('[data-testid="file-input"]').setInputFiles({
        name: 'SYNTHETIC_DRIVE_VOL.VOL',
        mimeType: 'application/octet-stream',
        buffer: Buffer.from(volBytes),
      });

      await expect(page.locator('[data-testid="car-viewer"]')).toBeVisible({ timeout: 15_000 });
      await page.locator('[data-testid="car-viewer"] [data-testid="nav-mode-drive"]').click();
      await expect(appRoot).toHaveAttribute('data-view-mode', 'drive');
      await expect(page.locator('[data-testid="drive-view"]')).toBeVisible();

      // Wait until both CarModel and TrackModel finish loading in DriveSession.
      await expect
        .poll(async () => page.evaluate(() => window.__drive?.getSnapshot().ready === true), {
          timeout: 15_000,
        })
        .toBe(true);

      // 1. Verify non-empty combined HD render and zero WebGL errors.
      const hdSample = await page.evaluate(() => window.__drive?.sampleCenterPixels(64));
      expect(hdSample).toBeDefined();
      expect(hdSample!.nonBackgroundPixels).toBeGreaterThan(20);

      const initialStats = await page.evaluate(() => window.__drive?.getDebugStats());
      expect(initialStats?.glError.hasError).toBe(false);
      expect(initialStats?.glErrorCount).toBe(0);
      const carLoadsBefore = initialStats?.carCacheStats.workerLoads ?? 0;
      const trackLoadsBefore = initialStats?.trackCacheStats.workerLoads ?? 0;

      // 2. Accelerate with KeyW and verify HUD speed > 0 and forward -Z travel.
      const startZ = await page.evaluate(() => window.__drive?.getTelemetry().pose.position.z ?? 0);
      await page.keyboard.down('KeyW');
      await expect
        .poll(async () => Number(await page.locator('[data-testid="drive-hud-speed"]').textContent()))
        .toBeGreaterThan(10);
      await page.keyboard.up('KeyW');

      const zAfterW = await page.evaluate(() => window.__drive?.getTelemetry().pose.position.z ?? 0);
      expect(zAfterW).toBeLessThan(startZ - 1);

      // Verify ArrowUp also accelerates identically.
      await page.keyboard.down('ArrowUp');
      await page.waitForTimeout(200);
      await page.keyboard.up('ArrowUp');
      const speedAfterArrow = Number(
        await page.locator('[data-testid="drive-hud-speed"]').textContent(),
      );
      expect(speedAfterArrow).toBeGreaterThan(10);

      // 3. Cycle camera preset with KeyC, verify ?debug=1 Free Cam toggle (UI + KeyF), toggle Pause, and reset with KeyR.
      await page.keyboard.press('KeyC', { delay: 80 });
      await expect(page.locator('[data-testid="drive-hud-camera"]')).toHaveText('Chase Close');

      const freeCamCheckbox = page.locator('[data-testid="drive-freecam-toggle"]');
      await freeCamCheckbox.click();
      await expect(page.locator('[data-testid="drive-hud-camera"]')).toHaveText('Debug Free Cam');
      await expect
        .poll(async () => page.evaluate(() => window.__drive?.getSnapshot().debugFreeCamActive))
        .toBe(true);

      await page.keyboard.press('KeyF', { delay: 80 });
      await expect(page.locator('[data-testid="drive-hud-camera"]')).toHaveText('Chase Close');
      await expect
        .poll(async () => page.evaluate(() => window.__drive?.getSnapshot().debugFreeCamActive))
        .toBe(false);

      await page.keyboard.press('KeyP', { delay: 80 });
      await expect(page.locator('[data-testid="drive-pause-overlay"]')).toBeVisible();
      await page.keyboard.press('Escape', { delay: 80 });
      await expect(page.locator('[data-testid="drive-pause-overlay"]')).toBeHidden();

      await page.keyboard.press('KeyR', { delay: 80 });
      await expect
        .poll(async () => Number(await page.locator('[data-testid="drive-hud-speed"]').textContent()))
        .toBe(0);

      // 4. Toggle ABS On/Off in Drive Setup and verify HUD + session state.
      await expect(page.locator('[data-testid="drive-hud-abs"]')).toHaveText('ABS');
      await page.locator('[data-testid="drive-abs-off"]').click();
      await expect(page.locator('[data-testid="drive-hud-abs"]')).toHaveText('ABS OFF');
      await expect
        .poll(async () => page.evaluate(() => window.__drive?.getSnapshot().absEnabled))
        .toBe(false);
      await page.locator('[data-testid="drive-abs-on"]').click();
      await expect(page.locator('[data-testid="drive-hud-abs"]')).toHaveText('ABS');
      await expect
        .poll(async () => page.evaluate(() => window.__drive?.getSnapshot().absEnabled))
        .toBe(true);

      // 5. Toggle HD -> PS1 without reloading VOL and verify non-empty render.
      await page.locator('[data-testid="drive-mode-ps1"]').click();
      await expect
        .poll(async () => page.evaluate(() => window.__drive?.getSnapshot().renderMode))
        .toBe('ps1');

      const ps1Sample = await page.evaluate(() => window.__drive?.sampleCenterPixels(64));
      expect(ps1Sample).toBeDefined();
      expect(ps1Sample!.nonBackgroundPixels).toBeGreaterThan(20);

      const statsAfterPs1 = await page.evaluate(() => window.__drive?.getDebugStats());
      expect(statsAfterPs1?.carCacheStats.workerLoads).toBe(carLoadsBefore);
      expect(statsAfterPs1?.trackCacheStats.workerLoads).toBe(trackLoadsBefore);

      // 5. Simulate WEBGL_lose_context and verify recovery from cache without extra worker loads.
      await page.evaluate(() => {
        const canvas = document.querySelector('canvas.ogt2-canvas') as HTMLCanvasElement | null;
        const gl = canvas?.getContext('webgl2');
        const ext = gl?.getExtension('WEBGL_lose_context');
        ext?.loseContext();
        setTimeout(() => {
          ext?.restoreContext();
        }, 50);
      });

      await expect
        .poll(async () => page.evaluate(() => window.__drive?.getSnapshot().restoredCount ?? 0))
        .toBeGreaterThanOrEqual(1);

      const restoredSample = await page.evaluate(() => window.__drive?.sampleCenterPixels(64));
      expect(restoredSample!.nonBackgroundPixels).toBeGreaterThan(20);

      const finalStats = await page.evaluate(() => window.__drive?.getDebugStats());
      expect(finalStats?.glErrorCount).toBe(0);
      expect(finalStats?.carCacheStats.workerLoads).toBe(carLoadsBefore);
      expect(finalStats?.trackCacheStats.workerLoads).toBe(trackLoadsBefore);

      assertCleanMonitors(monitors);
    } finally {
      await context.close();
      await isolatedBrowser.close();
    }
  });
});
