import { defineConfig, devices } from '@playwright/test';

// WebKit: the closest engine to the system WKWebView the app runs in.
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.mjs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    viewport: { width: 1040, height: 700 },
    reducedMotion: 'reduce',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'webkit', use: { ...devices['Desktop Safari'], viewport: { width: 1040, height: 700 } } }],
  webServer: { command: 'node serve.mjs', url: 'http://127.0.0.1:4173/index.html', reuseExistingServer: !process.env.CI },
});
