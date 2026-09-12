// @ts-check
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 60 * 1000,
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  use: {
    baseURL: 'http://127.0.0.1:8901',
    trace: 'retain-on-failure',
  },
  webServer: {
    // Serve tĩnh từ root repo (config chạy với cwd=web/ nên lùi 1 cấp)
    command: 'python -m http.server 8901 --directory ..',
    url: 'http://127.0.0.1:8901/web/index.html',
    reuseExistingServer: !process.env.CI,
    timeout: 30 * 1000,
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
