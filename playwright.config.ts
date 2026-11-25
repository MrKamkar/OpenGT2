import { env } from 'node:process';
import { defineConfig, devices } from '@playwright/test';

const LOCAL_PREVIEW_HOST = '127.0.0.1';
const LOCAL_PREVIEW_PORT = 4173;
const LOCAL_PREVIEW_URL = `http://${LOCAL_PREVIEW_HOST}:${LOCAL_PREVIEW_PORT}/`;

const remoteBaseUrl = env['E2E_BASE_URL']?.trim();
const baseURL = remoteBaseUrl && remoteBaseUrl.length > 0 ? remoteBaseUrl : LOCAL_PREVIEW_URL;
const isCI = Boolean(env['CI']);

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: isCI,
  retries: isCI ? 2 : 0,
  workers: 1,
  timeout: 30_000,
  reporter: isCI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    launchOptions: {
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--ignore-gpu-blocklist',
      ],
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  ...(remoteBaseUrl
    ? {}
    : {
        webServer: {
          command: `npm run preview -- --host ${LOCAL_PREVIEW_HOST} --port ${LOCAL_PREVIEW_PORT} --strictPort`,
          url: LOCAL_PREVIEW_URL,
          reuseExistingServer: !isCI,
          timeout: 30_000,
        },
      }),
});
