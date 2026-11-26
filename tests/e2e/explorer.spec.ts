import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { expect, test, type Download, type Page } from '@playwright/test';
import { gzipSync } from 'fflate';
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
    totalFiles: 7 + bulkFiles.length,
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
    await expect(status).toContainText('wieloczęściowym kontenerem gzip');

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

    // 6. Narrow viewport keeps NAZWA column visible
    await page.setViewportSize({ width: 375, height: 812 });
    const nameBox = await page
      .locator('[data-testid="explorer-row"][data-path="cars/research.dat.gz"] .ogt2-col-name')
      .boundingBox();
    expect(nameBox).not.toBeNull();
    expect(nameBox!.width).toBeGreaterThanOrEqual(120);

    assertCleanMonitors(monitors);
  });
});
