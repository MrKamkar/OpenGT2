import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { expect, test, type Download, type Page } from '@playwright/test';
import { gzipSync } from 'fflate';
import { buildGm, buildIdxContainer } from '../fixtures/buildGtimg';
import { buildSyntheticGtmodeData, buildSyntheticUnistrdb } from '../fixtures/buildGtdb';
import { buildTim } from '../fixtures/buildTim';
import { buildSyntheticVol, deterministicPayload } from '../fixtures/buildVol';

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
  readonly consoleErrors: string[];
  readonly pageErrors: string[];
}

function attachErrorMonitors(page: Page): PageErrorMonitors {
  const httpErrors: string[] = [];
  const failedRequests: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

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
    consoleErrors,
    pageErrors,
  };
}

function assertCleanMonitors(monitors: PageErrorMonitors): void {
  expect(monitors.httpErrors, 'Expected zero HTTP 4xx/5xx responses').toEqual([]);
  expect(monitors.failedRequests, 'Expected zero failed network requests').toEqual([]);
  expect(monitors.consoleErrors, 'Expected zero console.error messages').toEqual([]);
  expect(monitors.pageErrors, 'Expected zero uncaught page errors').toEqual([]);
}

function buildMultiMemberGzip(part1: Uint8Array, part2: Uint8Array): Uint8Array {
  const gz1 = gzipSync(part1, { mtime: 0 });
  const gz2 = gzipSync(part2, { mtime: 0 });
  const alignedEnd = gz1.byteLength % 4 === 0 ? gz1.byteLength : gz1.byteLength + (4 - (gz1.byteLength % 4));
  const out = new Uint8Array(alignedEnd + gz2.byteLength);
  out.set(gz1, 0);
  out.set(gz2, alignedEnd);
  return out;
}

function buildResearchFixturePayload(): Uint8Array {
  // 32 records of 0x20 bytes (1024 bytes total) with an embedded TIM magic at 0x40
  // and known LE / fixed-point values at 0x60.
  const stride = 0x20;
  const recordCount = 32;
  const buf = new Uint8Array(stride * recordCount);
  for (let r = 0; r < recordCount; r += 1) {
    const base = r * stride;
    buf[base + 0] = 0x52;
    buf[base + 1] = 0x01;
    buf[base + 2] = r & 0xff;
    buf[base + 3] = 0x00;
    buf[base + 4] = (r * 37 + 11) & 0xff;
    buf[base + 5] = (r * 73 + 19) & 0xff;
    buf[base + 12] = 0x80;
    buf[base + 13] = 0x01;
    buf[base + 14] = 0x22;
    buf[base + 15] = 0x01;
    buf[base + 16] = 0x33;
    buf[base + 17] = 0x44;
    buf[base + 24] = 0xff;
    buf[base + 25] = 0x02;
    buf[base + 26] = 0xaa;
    buf[base + 27] = 0x55;
  }
  // Embedded TIM signature at 0x40
  buf.set([0x10, 0x00, 0x00, 0x00, 0x08, 0x00, 0x00, 0x00], 0x40);
  // Known int16 LE at 0x60: 0x1000 (+4096 => fixed 4.12 = 1.000000, fixed 1.15 = 0.125000)
  const view = new DataView(buf.buffer);
  view.setInt16(0x60, 0x1000, true);
  view.setInt16(0x62, 0x4000, true);
  return buf;
}

function buildBlindTexturePayload(): Uint8Array {
  // 32 B 16-entry 15-bit LE CLUT at 0x00 + 16x8 4 bpp pixels (64 B) at 0x20 = 96 B total.
  const buf = new Uint8Array(0x20 + 64);
  const view = new DataView(buf.buffer);
  view.setUint16(0x00, 0x0000, true); // 0: transparent black
  view.setUint16(0x02, 0x001f, true); // 1: pure red (bits 0..4)
  view.setUint16(0x04, 0x7c00, true); // 2: pure blue (bits 10..14)
  view.setUint16(0x06, 0x03e0, true); // 3: pure green (bits 5..9)

  buf.fill(0x33, 0x20);
  // First byte at 0x20: even pixel (0,0) = 1 (red), odd pixel (1,0) = 2 (blue)
  buf[0x20] = 0x21;
  return buf;
}

function createExplorerFixtureArchive() {
  const packedPlain = deterministicPayload(640, 3);
  const packedGz = gzipSync(packedPlain, { mtime: 0 });
  const researchPlain = buildResearchFixturePayload();
  const researchGz = gzipSync(researchPlain, { mtime: 0 });
  const hiddenPlain = deterministicPayload(512, 7);
  const hiddenGz = gzipSync(hiddenPlain, { mtime: 0 });
  const fakeGzBytes = new TextEncoder().encode('PLAIN_CONTENT_WITH_GZ_NAME');
  const readmeBytes = new TextEncoder().encode('OpenGT2 synthetic explorer fixture');
  const deepBytes = deterministicPayload(64, 11);
  const multiGzBytes = buildMultiMemberGzip(
    deterministicPayload(128, 13),
    deterministicPayload(96, 17),
  );
  const blindTexBytes = buildBlindTexturePayload();

  // 11,600 zero-byte entries in bulk/ to verify >11k virtualization without large payloads.
  const bulkFiles = Array.from({ length: 11_600 }, (_, i) => ({
    kind: 'file' as const,
    name: `b_${String(i).padStart(5, '0')}.dat`,
    data: new Uint8Array(0),
    unixTime: 945_000_000,
  }));

  const built = buildSyntheticVol([
    { kind: 'file', name: 'readme.txt', data: readmeBytes, unixTime: 945_000_001 },
    {
      kind: 'dir',
      name: 'cars',
      unixTime: 945_000_010,
      children: [
        { kind: 'file', name: 'packed.dat.gz', data: packedGz, unixTime: 945_000_020 },
        { kind: 'file', name: 'research.dat.gz', data: researchGz, unixTime: 945_000_025 },
        { kind: 'file', name: 'hidden_gz.bin', data: hiddenGz, unixTime: 945_000_030 },
        { kind: 'file', name: 'fake.gz', data: fakeGzBytes, unixTime: 945_000_040 },
        { kind: 'file', name: 'multi_gz.bin', data: multiGzBytes, unixTime: 945_000_050 },
        { kind: 'file', name: 'blind_tex.bin', data: blindTexBytes, unixTime: 945_000_055 },
        {
          kind: 'dir',
          name: 'sub',
          unixTime: 945_000_060,
          children: [
            {
              kind: 'dir',
              name: 'deep',
              unixTime: 945_000_070,
              children: [{ kind: 'file', name: 'leaf.bin', data: deepBytes, unixTime: 945_000_080 }],
            },
          ],
        },
      ],
    },
    { kind: 'dir', name: 'emptyDir', unixTime: 945_000_090, children: [] },
    { kind: 'dir', name: 'bulk', unixTime: 945_000_100, children: bulkFiles },
  ]);

  return {
    built,
    packedPlain,
    packedGz,
    researchPlain,
    researchGz,
    hiddenPlain,
    hiddenGz,
    fakeGzBytes,
    multiGzBytes,
    blindTexBytes,
    totalFiles: 8 + bulkFiles.length,
  };
}

test.describe('OpenGT2 M2.8 Explorer', () => {
  test('handles non-VOL file cleanly, virtualizes >11k entries, lazily probes gzip, and keeps search isolated from InputManager', async ({
    page,
    baseURL,
  }) => {
    expect(baseURL).toBeTruthy();
    const monitors = attachErrorMonitors(page);
    const fixture = createExplorerFixtureArchive();

    await page.goto(buildPageUrl(baseURL ?? 'http://127.0.0.1:4173/', 'debug=1'), {
      waitUntil: 'load',
    });

    const appRoot = page.locator('#app');
    await expect(appRoot).toHaveAttribute('data-worker', 'ready', { timeout: 10_000 });
    await expect(appRoot).toHaveAttribute('data-webgl2', 'ready');

    // 1. Non-VOL file shows readable error without console.error.
    await page.locator('[data-testid="file-input"]').setInputFiles({
      name: 'NOT_A_VOL.VOL',
      mimeType: 'application/octet-stream',
      buffer: Buffer.alloc(1024, 0),
    });

    const archivePanel = page.locator('[data-testid="archive-panel"]');
    await expect(archivePanel).toHaveAttribute('data-vol-state', 'error', { timeout: 10_000 });
    await expect(page.locator('[data-testid="archive-error"]')).toContainText('GTFS');
    assertCleanMonitors(monitors);

    // 2. Load synthetic VOL with >11,600 entries.
    await page.locator('[data-testid="reset-file-button"]').click();
    await page.locator('[data-testid="file-input"]').setInputFiles({
      name: 'SYNTHETIC_GT2.VOL',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from(fixture.built.bytes),
    });

    await expect(archivePanel).toHaveAttribute('data-vol-state', 'ready', { timeout: 15_000 });
    await expect(page.locator('[data-testid="vol-listed-files"]')).toHaveText(String(fixture.totalFiles));
    await expect(page.locator('canvas.ogt2-canvas')).toBeVisible();

    // 3. Switch to "Wszystkie pliki" -> >11k rows virtualized in DOM (< 60 DOM row nodes).
    await page.locator('[data-testid="tree-all"]').click();
    const countLabel = page.locator('[data-testid="explorer-count"]');
    await expect(countLabel).toHaveAttribute('data-count', String(fixture.totalFiles));

    const renderedCount = await page.locator('[data-testid="explorer-row"]').count();
    expect(renderedCount).toBeGreaterThan(0);
    expect(renderedCount).toBeLessThan(60);

    // Scroll list to the middle and verify virtualized range advances.
    const list = page.locator('[data-testid="explorer-list"]');
    await list.evaluate((el) => {
      el.scrollTop = 5000 * 28;
      el.dispatchEvent(new Event('scroll'));
    });
    await expect
      .poll(async () => Number((await list.getAttribute('data-range-start')) ?? '0'))
      .toBeGreaterThan(4000);
    expect(await page.locator('[data-testid="explorer-row"]').count()).toBeLessThan(60);

    // 4. Navigate to `cars` directory and verify columns + lazy gzip magic detection.
    await page.locator('[data-testid="tree-dir"][data-path="cars"]').click();
    await expect(page.locator('[data-testid="explorer-scope"]')).toHaveText('/cars');

    const packedRow = page.locator('[data-testid="explorer-row"][data-path="cars/packed.dat.gz"]');
    const hiddenRow = page.locator('[data-testid="explorer-row"][data-path="cars/hidden_gz.bin"]');
    const fakeRow = page.locator('[data-testid="explorer-row"][data-path="cars/fake.gz"]');

    await expect(packedRow.locator('.ogt2-col-date')).toHaveText(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/);
    await expect(packedRow.locator('.ogt2-col-gzip')).toHaveAttribute('data-gzip', 'gzip', {
      timeout: 5_000,
    });
    await expect(hiddenRow.locator('.ogt2-col-gzip')).toHaveAttribute('data-gzip', 'gzip', {
      timeout: 5_000,
    });
    await expect(fakeRow.locator('.ogt2-col-gzip')).toHaveAttribute('data-gzip', 'plain', {
      timeout: 5_000,
    });

    // 5. Search input does not collide with InputManager (WASD/ArrowUp/Space).
    await page.locator('[data-testid="tree-all"]').click();
    const search = page.locator('[data-testid="explorer-search"]');
    await search.click();
    await search.fill('');
    await page.keyboard.type('packed');
    await page.keyboard.press('Space');
    await page.keyboard.press('ArrowUp');

    const inputSnapshot = await page.evaluate(() => window.__input?.getSnapshot());
    expect(inputSnapshot?.pressedCodes).toEqual([]);
    expect(inputSnapshot?.activeActions).toEqual([]);

    await search.fill('packed');
    await expect(countLabel).toHaveAttribute('data-count', '1');
    await expect(page.locator('[data-testid="explorer-row"][data-path="cars/packed.dat.gz"]')).toBeVisible();

    assertCleanMonitors(monitors);
  });

  test('supports M2.9 file actions: hex placeholder, raw/decompressed downloads, and multi-member gzip error without console.error', async ({
    page,
    baseURL,
  }) => {
    expect(baseURL).toBeTruthy();
    const monitors = attachErrorMonitors(page);
    const fixture = createExplorerFixtureArchive();

    await page.goto(buildPageUrl(baseURL ?? 'http://127.0.0.1:4173/'), {
      waitUntil: 'load',
    });

    const appRoot = page.locator('#app');
    await expect(appRoot).toHaveAttribute('data-worker', 'ready', { timeout: 10_000 });

    await page.locator('[data-testid="file-input"]').setInputFiles({
      name: 'SYNTHETIC_GT2.VOL',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from(fixture.built.bytes),
    });

    const archivePanel = page.locator('[data-testid="archive-panel"]');
    await expect(archivePanel).toHaveAttribute('data-vol-state', 'ready', { timeout: 15_000 });

    await page.locator('[data-testid="tree-dir"][data-path="cars"]').click();

    const readDownloadBytes = async (download: Download): Promise<Uint8Array> => {
      const filePath = await download.path();
      expect(filePath).toBeTruthy();
      return new Uint8Array(await readFile(filePath as string));
    };

    // 1. Select packed.dat.gz: hex viewer opens, raw download, and decompressed download.
    await page.locator('[data-testid="explorer-row"][data-path="cars/packed.dat.gz"]').click();
    await expect(page.locator('[data-testid="details-name"]')).toHaveText('packed.dat.gz');

    await page.locator('[data-testid="action-hex-preview"]').click();
    await expect(page.locator('[data-testid="hex-viewer"]')).toBeVisible();
    await expect(page.locator('[data-testid="hex-current-hash"]')).toHaveText(
      '#hex=cars%2Fpacked.dat.gz&off=0x0',
    );
    await expect(page.locator('[data-testid="hex-row"]').first()).toBeVisible();

    const rawDownloadPromise = page.waitForEvent('download');
    await page.locator('[data-testid="action-download-raw"]').click();
    const rawDownload = await rawDownloadPromise;
    expect(rawDownload.suggestedFilename()).toBe('packed.dat.gz');
    expect(await readDownloadBytes(rawDownload)).toEqual(fixture.packedGz);

    const unpackBtn = page.locator('[data-testid="action-download-decompressed"]');
    await expect(unpackBtn).toBeEnabled({ timeout: 5_000 });
    const unpackedDownloadPromise = page.waitForEvent('download');
    await unpackBtn.click();
    const unpackedDownload = await unpackedDownloadPromise;
    expect(unpackedDownload.suggestedFilename()).toBe('packed.dat');
    expect(await readDownloadBytes(unpackedDownload)).toEqual(fixture.packedPlain);

    // 2. Select hidden_gz.bin (gzip without .gz extension): decompresses as hidden_gz.bin.unpacked.
    await page.locator('[data-testid="explorer-row"][data-path="cars/hidden_gz.bin"]').click();
    await expect(unpackBtn).toBeEnabled({ timeout: 5_000 });
    const hiddenUnpackedPromise = page.waitForEvent('download');
    await unpackBtn.click();
    const hiddenDownload = await hiddenUnpackedPromise;
    expect(hiddenDownload.suggestedFilename()).toBe('hidden_gz.bin.unpacked');
    expect(await readDownloadBytes(hiddenDownload)).toEqual(fixture.hiddenPlain);

    // 3. Select fake.gz (plain bytes with .gz extension): unpack button stays disabled.
    await page.locator('[data-testid="explorer-row"][data-path="cars/fake.gz"]').click();
    await expect(page.locator('[data-testid="details-gzip"]')).toHaveAttribute('data-gzip', 'plain', {
      timeout: 5_000,
    });
    await expect(unpackBtn).toBeDisabled();

    // 4. Select multi_gz.bin (multi-member container): unpack shows clean UI error without console.error, raw download works.
    await page.locator('[data-testid="explorer-row"][data-path="cars/multi_gz.bin"]').click();
    await expect(unpackBtn).toBeEnabled({ timeout: 5_000 });
    await unpackBtn.click();
    const status = page.locator('[data-testid="action-status"]');
    await expect(status).toHaveAttribute('data-status', 'error', { timeout: 5_000 });
    await expect(status).toContainText('multi-member gzip container');

    const multiRawPromise = page.waitForEvent('download');
    await page.locator('[data-testid="action-download-raw"]').click();
    const multiRaw = await multiRawPromise;
    expect(multiRaw.suggestedFilename()).toBe('multi_gz.bin');
    expect(await readDownloadBytes(multiRaw)).toEqual(fixture.multiGzBytes);

    assertCleanMonitors(monitors);
  });

  test('supports M3.1–M3.4 research tools: hexview (raw + gunzip + LE/fixed-point), worker scanner, analyzer, and format classifier without console.error', async ({
    page,
    baseURL,
  }) => {
    expect(baseURL).toBeTruthy();
    const monitors = attachErrorMonitors(page);
    const fixture = createExplorerFixtureArchive();

    await page.goto(buildPageUrl(baseURL ?? 'http://127.0.0.1:4173/', 'debug=1'), {
      waitUntil: 'load',
    });

    const appRoot = page.locator('#app');
    await expect(appRoot).toHaveAttribute('data-worker', 'ready', { timeout: 10_000 });

    await page.locator('[data-testid="file-input"]').setInputFiles({
      name: 'SYNTHETIC_GT2.VOL',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from(fixture.built.bytes),
    });

    const archivePanel = page.locator('[data-testid="archive-panel"]');
    await expect(archivePanel).toHaveAttribute('data-vol-state', 'ready', { timeout: 15_000 });

    await page.locator('[data-testid="tree-dir"][data-path="cars"]').click();
    await page.locator('[data-testid="explorer-row"][data-path="cars/research.dat.gz"]').click();

    // 1. Format classifier in explorer details (M3.4)
    await expect(page.locator('[data-testid="details-format"]')).toHaveAttribute('data-format-id', 'gzip', {
      timeout: 5_000,
    });
    await expect(page.locator('[data-testid="details-format"]')).toContainText('[E3]');

    // 2. All <input> and <select> elements have id & name (DevTools Issues check)
    const missingIds = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('input, select')];
      return nodes
        .filter((node) => !node.id || !node.getAttribute('name'))
        .map((node) => node.outerHTML);
    });
    expect(missingIds).toEqual([]);

    // 3. Open Hex Viewer (raw -> gunzip) and verify byte interpretations + InputManager isolation (M3.1)
    await page.locator('[data-testid="action-hex-preview"]').click();
    await expect(page.locator('[data-testid="hex-viewer"]')).toBeVisible();
    await expect(page.locator('[data-testid="hex-format"]')).toHaveAttribute('data-format-id', 'gzip');

    await page.locator('[data-testid="hex-mode-gunzip"]').click();
    await expect(page.locator('[data-testid="hex-current-hash"]')).toContainText('mode=gunzip');
    await expect(page.locator('[data-testid="hex-format"]')).toHaveAttribute('data-format-id', 'unknown');

    // Jump to 0x60 where int16 LE = 0x1000 (+4096 -> 1.000000 in 4.12)
    const hexOffInput = page.locator('[data-testid="hex-offset-input"]');
    await hexOffInput.click();
    await hexOffInput.fill('0x60');
    await page.keyboard.press('KeyW');
    const snapDuringHexInput = await page.evaluate(() => window.__input?.getSnapshot());
    expect(snapDuringHexInput?.pressedCodes).toEqual([]);

    await hexOffInput.fill('0x60');
    await page.locator('[data-testid="hex-jump-button"]').click();
    await expect(page.locator('[data-testid="hex-interp-s16"]')).toHaveText('4096');
    await expect(page.locator('[data-testid="hex-interp-q412"]')).toHaveText('1.000000');
    await expect(page.locator('[data-testid="hex-interp-q115"]')).toHaveText('0.125000');

    // 4. Signature scanner in Worker (M3.2): scan decompressed research.dat.gz for TIM preset -> hit at 0x40
    await page.locator('[data-testid="scanner-preset-tim"]').click();
    await page.locator('[data-testid="scanner-mode-select"]').selectOption('gunzip');
    await page.locator('[data-testid="scanner-run-button"]').click();

    const firstHit = page.locator('[data-testid="scanner-hit"]').first();
    await expect(firstHit).toBeVisible({ timeout: 10_000 });
    await expect(firstHit).toHaveAttribute('data-offset', String(0x40));

    // Clicking the hit updates hex viewer route to offset 0x40
    await firstHit.locator('[data-testid="scanner-hit-jump"]').click();
    await expect(page.locator('[data-testid="hex-current-hash"]')).toContainText('off=0x40');

    // 5. Analyzer (M3.3): entropy SVG, histogram SVG, and stride 0x20 detection
    await page.locator('[data-testid="analyzer-mode-select"]').selectOption('gunzip');
    await page.locator('[data-testid="analyzer-run-button"]').click();
    await expect(page.locator('[data-testid="analyzer-entropy-chart"]')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="analyzer-histogram-chart"]')).toBeVisible();
    await expect(page.locator('[data-testid="analyzer-stride-row"]').first()).toHaveAttribute(
      'data-stride',
      String(0x20),
    );

    // 6. Narrow viewport keeps Name column visible
    await page.setViewportSize({ width: 375, height: 812 });
    const nameBox = await page
      .locator('[data-testid="explorer-row"][data-path="cars/research.dat.gz"] .ogt2-col-name')
      .boundingBox();
    expect(nameBox).not.toBeNull();
    expect(nameBox!.width).toBeGreaterThanOrEqual(120);

    assertCleanMonitors(monitors);
  });

  test('supports M3.5–M3.7 research tools (structview, evidence pack <= 64 B, blindimage 1x/2x/4x) and full Hex ASCII column without console.error', async ({
    page,
    baseURL,
  }) => {
    expect(baseURL).toBeTruthy();
    const monitors = attachErrorMonitors(page);
    const fixture = createExplorerFixtureArchive();

    await page.goto(buildPageUrl(baseURL ?? 'http://127.0.0.1:4173/', 'debug=1'), {
      waitUntil: 'load',
    });

    const appRoot = page.locator('#app');
    await expect(appRoot).toHaveAttribute('data-worker', 'ready', { timeout: 10_000 });

    await page.locator('[data-testid="file-input"]').setInputFiles({
      name: 'SYNTHETIC_GT2.VOL',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from(fixture.built.bytes),
    });

    const archivePanel = page.locator('[data-testid="archive-panel"]');
    await expect(archivePanel).toHaveAttribute('data-vol-state', 'ready', { timeout: 15_000 });

    // Every <input>, <select>, and <textarea> has non-empty id & name
    const missingIds = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('input, select, textarea')];
      return nodes
        .filter((node) => !node.id || !node.getAttribute('name'))
        .map((node) => node.outerHTML);
    });
    expect(missingIds).toEqual([]);

    await page.locator('[data-testid="tree-dir"][data-path="cars"]').click();
    await page.locator('[data-testid="explorer-row"][data-path="cars/research.dat.gz"]').click();

    // 1. Hex Viewer ASCII column check (all 16 chars inside list viewport)
    await page.locator('[data-testid="action-hex-preview"]').click();
    await page.locator('[data-testid="hex-mode-gunzip"]').click();
    const firstHexRow = page.locator('[data-testid="hex-row"]').first();
    await expect(firstHexRow).toBeVisible();
    const asciiVisible = await page.evaluate(() => {
      const list = document.querySelector('[data-testid="hex-list"]');
      const row = document.querySelector('[data-testid="hex-row"]');
      if (!list || !row) return false;
      const listRect = list.getBoundingClientRect();
      const chars = [...row.querySelectorAll('.ogt2-hex-char')];
      return (
        chars.length === 16 &&
        chars.every((ch) => {
          const r = ch.getBoundingClientRect();
          return r.width > 0 && r.left >= listRect.left - 1 && r.right <= listRect.right + 1;
        })
      );
    });
    expect(asciiVisible).toBe(true);

    // 2. M3.5 Struct Array Viewer: decode 32 records of 0x20 B and export JSON
    await page.locator('[data-testid="struct-mode-select"]').selectOption('gunzip');
    await page.locator('[data-testid="struct-offset-input"]').fill('0x0');
    await page.locator('[data-testid="struct-stride-input"]').fill('0x20');
    await page.locator('[data-testid="struct-count-input"]').fill('32');
    await page.locator('[data-testid="struct-decode-button"]').click();

    await expect(page.locator('[data-testid="struct-row"]')).toHaveCount(32, { timeout: 10_000 });

    const structDownloadPromise = page.waitForEvent('download');
    await page.locator('[data-testid="struct-download-json"]').click();
    const structDownload = await structDownloadPromise;
    const structPath = await structDownload.path();
    expect(structPath).toBeTruthy();
    const structJson = JSON.parse(await readFile(structPath as string, 'utf8')) as Record<string, unknown>;
    expect(structJson['schemaVersion']).toBe(1);
    expect(structJson['stride']).toBe(32);
    expect(structJson['count']).toBe(32);

    // 3. M3.6 Evidence Pack: quick-add from Hex Viewer & Scanner + hard 64 B rejection + JSON export
    await page.locator('[data-testid="hex-offset-input"]').fill('0x60');
    await page.locator('[data-testid="hex-length-input"]').fill('4');
    await page.locator('[data-testid="hex-jump-button"]').click();
    await expect(page.locator('[data-testid="hex-interp-s16"]')).toHaveText('4096');
    await page.locator('[data-testid="hex-add-evidence"]').click();
    await expect(page.locator('[data-testid="evidence-item"]')).toHaveCount(1);

    await page.locator('[data-testid="scanner-preset-tim"]').click();
    await page.locator('[data-testid="scanner-mode-select"]').selectOption('gunzip');
    await page.locator('[data-testid="scanner-run-button"]').click();
    const firstHit = page.locator('[data-testid="scanner-hit"]').first();
    await expect(firstHit).toBeVisible({ timeout: 10_000 });
    await firstHit.locator('[data-testid="scanner-hit-evidence"]').click();
    await expect(page.locator('[data-testid="evidence-item"]')).toHaveCount(2);

    // Reject > 64 B hex sample
    const tooLongHex = Array.from({ length: 65 }, () => 'AA').join(' ');
    await page.locator('[data-testid="evidence-sample-input"]').fill(tooLongHex);
    await page.locator('[data-testid="evidence-add-button"]').click();
    await expect(page.locator('[data-testid="evidence-error"]')).toContainText('64 B');
    await expect(page.locator('[data-testid="evidence-item"]')).toHaveCount(2);

    const evidenceDownloadPromise = page.waitForEvent('download');
    await page.locator('[data-testid="evidence-download-json"]').click();
    const evidenceDownload = await evidenceDownloadPromise;
    const evidencePath = await evidenceDownload.path();
    expect(evidencePath).toBeTruthy();
    const evidenceJson = JSON.parse(await readFile(evidencePath as string, 'utf8')) as {
      maxHexSampleBytes: number;
      entries: Array<{ hexSample?: string }>;
    };
    expect(evidenceJson.maxHexSampleBytes).toBe(64);
    expect(evidenceJson.entries).toHaveLength(2);
    for (const entry of evidenceJson.entries) {
      if (entry.hexSample !== undefined) {
        expect(entry.hexSample.split(' ').length).toBeLessThanOrEqual(64);
      }
    }

    // 4. M3.7 Blind Image Viewer: render 16x8 4 bpp with CLUT, verify pixel colors, zoom 2x/4x, main WebGL2 untouched
    await page.locator('[data-testid="explorer-row"][data-path="cars/blind_tex.bin"]').click();
    await expect(page.locator('[data-testid="blind-panel"]')).toBeVisible();
    await page.locator('[data-testid="blind-offset-input"]').fill('0x20');
    await page.locator('[data-testid="blind-width-input"]').fill('16');
    await page.locator('[data-testid="blind-height-input"]').fill('8');
    await page.locator('[data-testid="blind-bpp-select"]').selectOption('4');
    await page.locator('[data-testid="blind-palette-input"]').fill('0x0');
    await page.locator('[data-testid="blind-render-button"]').click();

    const blindCanvas = page.locator('[data-testid="blind-canvas"]');
    await expect(blindCanvas).toHaveAttribute('data-rendered-width', '16', { timeout: 5_000 });
    await expect(blindCanvas).toHaveAttribute('data-rendered-height', '8');

    const firstPixels = await blindCanvas.evaluate((node) => {
      const c = node as HTMLCanvasElement;
      const ctx = c.getContext('2d');
      if (!ctx) return null;
      const data = ctx.getImageData(0, 0, 2, 1).data;
      return Array.from(data);
    });
    expect(firstPixels).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);

    await page.locator('[data-testid="blind-zoom-2"]').click();
    await expect(blindCanvas).toHaveAttribute('data-zoom', '2');
    await expect(blindCanvas).toHaveCSS('width', '32px');
    await expect(blindCanvas).toHaveCSS('height', '16px');

    await page.locator('[data-testid="blind-zoom-4"]').click();
    await expect(blindCanvas).toHaveAttribute('data-zoom', '4');
    await expect(blindCanvas).toHaveCSS('width', '64px');
    await expect(blindCanvas).toHaveCSS('height', '32px');

    const imageRendering = await blindCanvas.evaluate(
      (node) => window.getComputedStyle(node).imageRendering,
    );
    expect(imageRendering).toBe('pixelated');

    // Main WebGL2 canvas remains untouched (ready and empty)
    await expect(appRoot).toHaveAttribute('data-webgl2', 'ready');

    assertCleanMonitors(monitors);
  });

  test('supports M4.6–M4.8 2D image viewer, CLUT switch, GM container, lazy thumbnail gallery, and PNG export without console.error', async ({
    page,
    baseURL,
  }) => {
    expect(baseURL).toBeTruthy();
    const monitors = attachErrorMonitors(page);

    // 1. 4 bpp TIM (4x2) with 2 CLUT palettes: pal0[1]=red, pal1[1]=green
    const timMultiClut = buildTim({
      pixelMode: 0,
      clutPalettes: [
        [0x0000, 0x001f],
        [0x0000, 0x03e0],
      ],
      imageVramWidth: 1,
      imageHeight: 2,
      pixelData: new Uint8Array([0x01, 0x00, 0x00, 0x00]),
    });

    // 2. .tim.gz with doubled img.bnum quirk
    const timQuirkGz = gzipSync(
      buildTim({
        pixelMode: 0,
        clutPalettes: [[0x8000, 0x7c00]],
        imageVramWidth: 1,
        imageHeight: 2,
        pixelData: new Uint8Array([0x11, 0x00, 0x00, 0x00]),
        doubleImgBnumQuirk: true,
      }),
      { mtime: 0 },
    );

    // 3. Synthetic GM .idx + .dat container (2 entries, mangled-4)
    const gmSheet = new Uint8Array(2048);
    gmSheet[0] = 0x11;
    const gm0 = buildGm({
      positions: [{ kind: 'solid', tileX: 0, tileY: 0, tileIndexOrColor: 0x001f, solidFlags: 1 }],
      palettes: [
        [0x0000, 0x001f],
        [0x0000, 0x03e0],
      ],
      tileCount: 1,
      packedPixelBytes: gmSheet,
    });
    const gm1 = buildGm({
      positions: [{ kind: 'solid', tileX: 0, tileY: 0, tileIndexOrColor: 0x7c00, solidFlags: 1 }],
      palettes: [[0x0000, 0x7c00]],
      tileCount: 1,
    });
    const gmBundle = buildIdxContainer([gm0, gm1], 'mangled-4', { gzipMembers: true });

    const m4Vol = buildSyntheticVol([
      {
        kind: 'dir',
        name: 'ui',
        unixTime: 945_000_010,
        children: [
          { kind: 'file', name: 'multi_clut.tim', data: timMultiClut, unixTime: 945_000_020 },
          { kind: 'file', name: 'quirk.tim.gz', data: timQuirkGz, unixTime: 945_000_030 },
          { kind: 'file', name: 'menu_table.idx', data: gmBundle.idx, unixTime: 945_000_040 },
          { kind: 'file', name: 'menu_fg.dat', data: gmBundle.dat, unixTime: 945_000_050 },
        ],
      },
      { kind: 'dir', name: 'empty', unixTime: 945_000_060, children: [] },
    ]);

    await page.goto(buildPageUrl(baseURL ?? 'http://127.0.0.1:4173/'), {
      waitUntil: 'load',
    });

    const appRoot = page.locator('#app');
    await expect(appRoot).toHaveAttribute('data-worker', 'ready', { timeout: 10_000 });

    await page.locator('[data-testid="file-input"]').setInputFiles({
      name: 'SYNTHETIC_M4.VOL',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from(m4Vol.bytes),
    });

    const archivePanel = page.locator('[data-testid="archive-panel"]');
    await expect(archivePanel).toHaveAttribute('data-vol-state', 'ready', { timeout: 15_000 });

    await page.locator('[data-testid="tree-dir"][data-path="ui"]').click();

    // Open multi_clut.tim in M4.6 viewer
    await page.locator('[data-testid="explorer-row"][data-path="ui/multi_clut.tim"]').click();
    const viewerCanvas = page.locator('[data-testid="image-viewer-canvas"]');
    await expect(viewerCanvas).toHaveAttribute('data-rendered-width', '4', { timeout: 10_000 });
    await expect(viewerCanvas).toHaveAttribute('data-rendered-height', '2');

    const imgRendering = await viewerCanvas.evaluate(
      (node) => window.getComputedStyle(node).imageRendering,
    );
    expect(imgRendering).toBe('pixelated');

    const readFirstPixel = () =>
      viewerCanvas.evaluate((node) => {
        const c = node as HTMLCanvasElement;
        const ctx = c.getContext('2d');
        return ctx ? Array.from(ctx.getImageData(0, 0, 1, 1).data) : null;
      });

    expect(await readFirstPixel()).toEqual([255, 0, 0, 255]);

    // Switch CLUT palette 0 -> 1 and verify rendered pixels update
    await page.locator('[data-testid="image-palette-select"]').selectOption('1');
    await expect(viewerCanvas).toHaveAttribute('data-palette-index', '1', { timeout: 5_000 });
    expect(await readFirstPixel()).toEqual([0, 255, 0, 255]);

    // M4.8 local PNG export
    const pngDownloadPromise = page.waitForEvent('download');
    await page.locator('[data-testid="image-export-png"]').click();
    const pngDownload = await pngDownloadPromise;
    expect(pngDownload.suggestedFilename()).toBe('multi_clut_pal01.png');
    const pngPath = await pngDownload.path();
    expect(pngPath).toBeTruthy();
    const pngBytes = new Uint8Array(await readFile(pngPath as string));
    expect(Array.from(pngBytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);

    // Verify .tim.gz quirk warning
    await page.locator('[data-testid="explorer-row"][data-path="ui/quirk.tim.gz"]').click();
    await expect(page.locator('[data-testid="image-viewer-warnings"]')).toBeVisible({
      timeout: 5_000,
    });
    await expect(page.locator('[data-testid="image-viewer-warnings"]')).toContainText('bnum');

    // Open GM .dat container, verify auto-paired .idx, entry navigation #0 -> #1, and tileSheet mode
    await page.locator('[data-testid="explorer-row"][data-path="ui/menu_fg.dat"]').click();
    await expect(viewerCanvas).toHaveAttribute('data-rendered-width', '512', { timeout: 10_000 });
    await expect(viewerCanvas).toHaveAttribute('data-rendered-height', '504');
    await expect(page.locator('[data-testid="image-meta-container"]')).toContainText(
      'menu_table.idx',
    );
    expect(await readFirstPixel()).toEqual([255, 0, 0, 255]);

    await page.locator('[data-testid="image-entry-next"]').click();
    await expect(viewerCanvas).toHaveAttribute('data-entry-index', '1', { timeout: 5_000 });
    expect(await readFirstPixel()).toEqual([0, 0, 255, 255]);

    await page.locator('[data-testid="image-entry-prev"]').click();
    await expect(viewerCanvas).toHaveAttribute('data-entry-index', '0', { timeout: 5_000 });
    await page.locator('[data-testid="image-view-mode-select"]').selectOption('tileSheet');
    await expect(viewerCanvas).toHaveAttribute('data-rendered-height', '8', { timeout: 5_000 });
    await expect(page.locator('[data-testid="image-palette-select"]')).toBeEnabled();

    // M4.7 lazy thumbnail gallery
    await page.locator('[data-testid="explorer-view-gallery"]').click();
    await expect(page.locator('[data-testid="thumbnail-gallery"]')).toBeVisible();
    const timCard = page.locator('[data-testid="gallery-card"][data-path="ui/multi_clut.tim"]');
    await expect(timCard).toHaveAttribute('data-thumb-state', 'ready', { timeout: 10_000 });
    await timCard.click();
    await expect(viewerCanvas).toHaveAttribute('data-rendered-width', '4', { timeout: 5_000 });

    // All <input>, <select>, and <textarea> have non-empty id & name
    const missingIds = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('input, select, textarea')];
      return nodes
        .filter((node) => !node.id || !node.getAttribute('name'))
        .map((node) => node.outerHTML);
    });
    expect(missingIds).toEqual([]);

    // Main WebGL2 canvas remains untouched (ready and empty)
    await expect(appRoot).toHaveAttribute('data-webgl2', 'ready');

    assertCleanMonitors(monitors);
  });

  test('M5.6 Car Catalog decodes synthetic gtmode_data + unistrdb in Worker, filters, sorts, and shows E3/E2/E0 details', async ({
    page,
    baseURL,
  }) => {
    const monitors = attachErrorMonitors(page);

    const makeCarRecord = (
      carId: number,
      firstIdx: number,
      secondIdx: number,
      year: number,
      newPrice: number,
    ) => ({
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
      rimsCode3: 1,
      manufacturerId: 2,
      nameFirstPartIndex: firstIdx,
      nameSecondPartIndex: secondIdx,
      unk_0x40: 0,
      year,
      unk_0x42: 0,
      newPrice,
    });

    const makeDimRecord = (carId: number, weightKg: number) => ({
      carId,
      unk_0x04: 0x11223344,
      length: 4150,
      height: 1290,
      unk_0x0c: 0,
      weightKg,
      rmWeightMultiplier: 65,
      unk_0x11: 0,
      unk_0x12: 0,
    });

    const makeEngRecord = (carId: number, ps: number) => ({
      carId,
      engineTypeNameIndex: 6,
      engineTypeName2Index: 7,
      unk_0x08: 0,
      unk_0x0a: 0,
      bandAcceleration: new Array<number>(16).fill(0xffff),
      engineCc: 1998,
      ps,
      maxPowerRpmRaw: 750,
      torqueKgmRaw: 310,
      torqueRpmStringIndex: 8,
      baseUnits: [100, 0, 0, 80, 75],
      bandRpms: new Array<number>(16).fill(0xff),
      bandPointCount: 10,
    });

    const engData = buildSyntheticGtmodeData({
      cars: [
        makeCarRecord(0x10000001, 0, 1, 95, 22000),
        makeCarRecord(0x10000002, 2, 3, 98, 48000),
        makeCarRecord(0x10000003, 4, 5, 99, 15000),
      ],
      dimensions: [
        makeDimRecord(0x10000001, 1180),
        makeDimRecord(0x10000002, 990),
        makeDimRecord(0x10000003, 1340),
      ],
      engines: [
        makeEngRecord(0x10000001, 180),
        makeEngRecord(0x10000002, 340),
        makeEngRecord(0x10000003, 120),
      ],
    });
    const engStrings = buildSyntheticUnistrdb([
      'Proto',
      'Alpha',
      'Proto',
      'Beta',
      'Proto',
      'Gamma',
      'I4',
      'DOHC',
      '5500 rpm',
    ]);

    const usaData = buildSyntheticGtmodeData({
      cars: [makeCarRecord(0x20000001, 0, 1, 97, 39000)],
      dimensions: [makeDimRecord(0x20000001, 1110)],
      engines: [makeEngRecord(0x20000001, 290)],
    });
    const usaStrings = buildSyntheticUnistrdb([
      'Metric',
      'Delta',
      'Metric',
      'Delta',
      'Metric',
      'Delta',
      'V6',
      'SOHC',
      '6000 rpm',
    ]);

    const carVol = buildSyntheticVol([
      {
        kind: 'dir',
        name: 'carparam',
        children: [
          { kind: 'file', name: 'eng_gtmode_data.dat.gz', data: gzipSync(engData, { mtime: 0 }) },
          { kind: 'file', name: 'eng_unistrdb.dat.gz', data: gzipSync(engStrings, { mtime: 0 }) },
          { kind: 'file', name: 'usa_gtmode_data.dat.gz', data: gzipSync(usaData, { mtime: 0 }) },
          { kind: 'file', name: 'usa_unistrdb.dat.gz', data: gzipSync(usaStrings, { mtime: 0 }) },
        ],
      },
      { kind: 'dir', name: 'empty', unixTime: 945_000_060, children: [] },
    ]);

    await page.goto(buildPageUrl(baseURL ?? 'http://127.0.0.1:4173/', 'debug=1'), {
      waitUntil: 'load',
    });

    const appRoot = page.locator('#app');
    await expect(appRoot).toHaveAttribute('data-worker', 'ready', { timeout: 10_000 });

    await page.locator('[data-testid="file-input"]').setInputFiles({
      name: 'SYNTHETIC_CARS.VOL',
      mimeType: 'application/octet-stream',
      buffer: Buffer.from(carVol.bytes),
    });

    const archivePanel = page.locator('[data-testid="archive-panel"]');
    await expect(archivePanel).toHaveAttribute('data-vol-state', 'ready', { timeout: 15_000 });

    await page.locator('[data-testid="archive-tab-cars"]').click();
    await expect(page.locator('[data-testid="car-catalog-panel"]')).toBeVisible();
    await expect(page.locator('[data-testid="car-catalog-count"]')).toHaveText('3 cars', {
      timeout: 10_000,
    });
    await expect(page.locator('[data-testid="car-catalog-region"]')).toHaveValue('eng');

    // Sort by PS descending -> Proto Beta (340 PS) first
    await page.locator('[data-testid="car-sort-ps"]').click();
    const firstRowAfterPs = page.locator('[data-testid="car-catalog-row"]').first();
    await expect(firstRowAfterPs).toContainText('Proto Beta');
    await firstRowAfterPs.click();

    // Details panel shows E3, E2, E0 badges
    const details = page.locator('[data-testid="car-catalog-details"]');
    await expect(details).toContainText('Proto Beta');
    await expect(details.locator('[data-evidence="E3"]').first()).toBeVisible();
    await expect(details.locator('[data-evidence="E2"]').first()).toBeVisible();
    await expect(details.locator('[data-evidence="E0"]').first()).toBeVisible();

    // Filter with WSAD keys without triggering InputManager
    const carSearch = page.locator('[data-testid="car-catalog-search"]');
    await carSearch.click();
    await carSearch.pressSequentially('gamma');
    await expect(page.locator('[data-testid="car-catalog-count"]')).toHaveText('1 / 3 cars');
    await expect(page.locator('[data-testid="car-catalog-row"]')).toHaveCount(1);
    const inputSnapshot = await page.evaluate(() => window.__input?.getSnapshot());
    expect(inputSnapshot?.pressedCodes).toEqual([]);
    expect(inputSnapshot?.activeActions).toEqual([]);

    // Switch regional variant to USA
    await carSearch.fill('');
    await page.locator('[data-testid="car-catalog-region"]').selectOption('usa');
    await expect(page.locator('[data-testid="car-catalog-count"]')).toHaveText('1 cars', {
      timeout: 10_000,
    });
    await expect(page.locator('[data-testid="car-catalog-row"]').first()).toContainText('Metric Delta');

    // Verify all <input>, <select>, <textarea> have unique non-empty id and name
    const formIssues = await page.evaluate(() => {
      const nodes = [...document.querySelectorAll('input, select, textarea')];
      const ids = new Set<string>();
      const names = new Set<string>();
      const problems: string[] = [];
      for (const node of nodes) {
        const id = node.id;
        const name = node.getAttribute('name') ?? '';
        if (!id || !name) {
          problems.push(`missing:${node.outerHTML}`);
        } else {
          if (ids.has(id)) problems.push(`dup-id:${id}`);
          if (names.has(name)) problems.push(`dup-name:${name}`);
          ids.add(id);
          names.add(name);
        }
      }
      return problems;
    });
    expect(formIssues).toEqual([]);

    assertCleanMonitors(monitors);
  });
});
