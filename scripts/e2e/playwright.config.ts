// Monet Blackboard end-to-end suite. Run with `pnpm --filter @monet/scripts run e2e`.
//   E2E_BASE_URL   app under test (default http://localhost:3000)
//   E2E_OWNER_TOKEN the server's OWNER_LINK_TOKEN (default e2e-owner-token)
//   E2E_WORKERS    parallel workers (default 3)
//   E2E_RETRIES    retries per test (default 0, so flakiness shows up)
//   E2E_TRACE=1    keep Playwright traces for failed tests
import path from 'node:path';
import { defineConfig } from '@playwright/test';
import { BASE_URL, CHROMIUM_PATH, REPORT_DIR } from './lib/env';

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  outputDir: path.join(import.meta.dirname, '.output'),
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: Number(process.env.E2E_WORKERS || 3),
  retries: Number(process.env.E2E_RETRIES || 0),
  reporter: [
    ['list'],
    ['json', { outputFile: path.join(REPORT_DIR, 'results.json') }],
    ['html', { outputFolder: path.join(REPORT_DIR, 'html'), open: 'never' }],
    ['./lib/summary-reporter.ts'],
  ],
  use: {
    baseURL: BASE_URL,
    // Wide enough for the canvas plus the AI side panel.
    viewport: { width: 1600, height: 900 },
    launchOptions: { executablePath: CHROMIUM_PATH },
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    screenshot: 'only-on-failure',
    trace: process.env.E2E_TRACE ? 'retain-on-failure' : 'off',
  },
  projects: [
    // Fast protocol checks: REST + two WebSocket clients, no browser.
    { name: 'api', testMatch: /ws-protocol\.spec\.ts$/ },
    { name: 'browser', testIgnore: /ws-protocol\.spec\.ts$/ },
  ],
});
