import { Buffer } from 'node:buffer';
import { expect, test, type Page } from '@playwright/test';

const SYNTHETIC_FILE_NAME = 'SYNTHETIC_SMOKE.VOL';
// 1.50 MiB (1,572,864 B) — synthetic zeroed buffer generated on the fly in memory.
const SYNTHETIC_FILE_BYTES = 1_572_864;
const EXPECTED_FILE_SIZE_LABEL = '1.50 MB';

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
  expect(monitors.httpErrors, 'Expected zero HTTP 4xx/5xx responses (no 404s)').toEqual([]);
  expect(monitors.failedRequests, 'Expected zero failed network requests').toEqual([]);
  expect(monitors.consoleErrors, 'Expected zero console.error messages').toEqual([]);
  expect(monitors.pageErrors, 'Expected zero uncaught page errors').toEqual([]);
}

test.describe('OpenGT2 M0 smoke suite', () => {
  test('loads cleanly without 404/console errors, starts module worker, and hides window.__input without ?debug=1', async ({
    page,
    baseURL,
  }) => {
    expect(baseURL).toBeTruthy();
    const monitors = attachErrorMonitors(page);

    await page.goto(buildPageUrl(baseURL ?? 'http://127.0.0.1:4173/'), {
      waitUntil: 'load',
    });

    const appRoot = page.locator('#app');
    await expect(appRoot).toHaveAttribute('data-engine', 'opengt2');
    await expect(appRoot).toHaveAttribute('data-worker', 'ready', { timeout: 10_000 });
    await expect(page.locator('canvas.ogt2-canvas')).toBeVisible();

    const hasDebugHook = await page.evaluate(() => '__input' in window);
    expect(hasDebugHook).toBe(false);

    assertCleanMonitors(monitors);
  });

  test('with ?debug=1 displays synthetic file metadata and reacts to W, ArrowUp, and Space via window.__input', async ({
    page,
    baseURL,
  }) => {
    expect(baseURL).toBeTruthy();
    const monitors = attachErrorMonitors(page);

    await page.goto(buildPageUrl(baseURL ?? 'http://127.0.0.1:4173/', 'debug=1'), {
      waitUntil: 'load',
    });

    const appRoot = page.locator('#app');
    await expect(appRoot).toHaveAttribute('data-engine', 'opengt2');
    await expect(appRoot).toHaveAttribute('data-worker', 'ready', { timeout: 10_000 });

    // Generate synthetic buffer in-memory (zero game assets in repo).
    const syntheticBuffer = Buffer.alloc(SYNTHETIC_FILE_BYTES, 0);
    await page.locator('[data-testid="file-input"]').setInputFiles({
      name: SYNTHETIC_FILE_NAME,
      mimeType: 'application/octet-stream',
      buffer: syntheticBuffer,
    });

    await expect(appRoot).toHaveAttribute('data-state', 'Ready');
    await expect(page.locator('[data-testid="file-name"]')).toHaveText(SYNTHETIC_FILE_NAME);
    await expect(page.locator('[data-testid="file-size"]')).toHaveText(EXPECTED_FILE_SIZE_LABEL);

    // M1.5: verify short fingerprint is rendered with full 64-hex SHA-256 tooltip/attribute.
    const fpLocator = page.locator('[data-testid="file-fingerprint"]');
    await expect(fpLocator).toBeVisible();
    await expect(fpLocator).toHaveAttribute('data-full-fingerprint', /^[0-9a-f]{64}$/);
    const shortFpText = (await fpLocator.textContent()) ?? '';
    expect(shortFpText.length).toBeGreaterThan(0);
    expect(shortFpText.length).toBeLessThan(64);

    // UI regression check: capability badges stay strictly inside their tile bounds.
    const capOverflowCount = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.ogt2-cap-item'));
      let overflows = 0;
      for (const item of items) {
        const badge = item.querySelector('.ogt2-cap-badge');
        if (badge === null) {
          continue;
        }
        const itemRect = item.getBoundingClientRect();
        const badgeRect = badge.getBoundingClientRect();
        if (badgeRect.right > itemRect.right + 0.5 || badgeRect.left < itemRect.left - 0.5) {
          overflows += 1;
        }
      }
      return overflows;
    });
    expect(capOverflowCount).toBe(0);

    // M1.7: verify "Clear Local Data" clears local storage/cache cleanly with UI confirmation.
    await page.locator('[data-testid="clear-data-button"]').click();
    await expect(page.locator('[data-testid="clear-data-status"]')).toBeVisible();

    // Verify window.__input is exposed in ?debug=1 mode.
    const hasDebugHook = await page.evaluate(() => typeof window.__input?.getSnapshot === 'function');
    expect(hasDebugHook).toBe(true);

    // Focus canvas as required by ROADMAP §1.6 before dispatching keyboard input.
    const canvas = page.locator('canvas.ogt2-canvas');
    await canvas.focus();

    // Test W -> menuUp (default menu context).
    await page.keyboard.down('KeyW');
    const afterW = await page.evaluate(() => window.__input?.getSnapshot());
    expect(afterW?.pressedCodes).toContain('KeyW');
    expect(afterW?.activeActions).toContain('menuUp');
    expect(afterW?.axes.moveY).toBe(1);
    await page.keyboard.up('KeyW');

    // Test ArrowUp -> menuUp (WSAD + arrows simultaneously).
    await page.keyboard.down('ArrowUp');
    const afterArrowUp = await page.evaluate(() => window.__input?.getSnapshot());
    expect(afterArrowUp?.pressedCodes).toContain('ArrowUp');
    expect(afterArrowUp?.activeActions).toContain('menuUp');
    expect(afterArrowUp?.axes.moveY).toBe(1);
    await page.keyboard.up('ArrowUp');

    // Test Space -> menuConfirm.
    await page.keyboard.down('Space');
    const afterSpace = await page.evaluate(() => window.__input?.getSnapshot());
    expect(afterSpace?.pressedCodes).toContain('Space');
    expect(afterSpace?.activeActions).toContain('menuConfirm');
    await page.keyboard.up('Space');

    // Also verify race context bindings for W, ArrowUp, and Space.
    await page.evaluate(() => window.__input?.setContext('race'));

    await page.keyboard.down('KeyW');
    expect(await page.evaluate(() => window.__input?.isActionActive('throttle'))).toBe(true);
    await page.keyboard.up('KeyW');

    await page.keyboard.down('ArrowUp');
    expect(await page.evaluate(() => window.__input?.isActionActive('throttle'))).toBe(true);
    await page.keyboard.up('ArrowUp');

    await page.keyboard.down('Space');
    expect(await page.evaluate(() => window.__input?.isActionActive('handbrake'))).toBe(true);
    await page.keyboard.up('Space');

    const finalSnapshot = await page.evaluate(() => window.__input?.getSnapshot());
    expect(finalSnapshot?.pressedCodes).toEqual([]);

    assertCleanMonitors(monitors);
  });
});
