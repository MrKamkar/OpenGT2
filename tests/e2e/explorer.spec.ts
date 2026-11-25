import { Buffer } from 'node:buffer';
import { expect, test, type Page } from '@playwright/test';
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

function createExplorerFixtureArchive() {
  const packedPlain = deterministicPayload(640, 3);
  const packedGz = gzipSync(packedPlain, { mtime: 0 });
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
    hiddenPlain,
    hiddenGz,
    fakeGzBytes,
    multiGzBytes,
    totalFiles: 6 + bulkFiles.length,
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
});
