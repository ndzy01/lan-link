import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: 'test-results/cases',
  reporter: [['list'], ['json', { outputFile: 'test-results/results.json' }]],
  use: {
    baseURL: process.env.TEST_BASE_URL || 'http://127.0.0.1:5290/demo/',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  // The invoking task owns and records its temporary preview server.
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', ...(process.env.CI ? {} : { channel: 'chrome' }) } },
    { name: 'webkit', use: { browserName: 'webkit' } },
  ],
});
