const { defineConfig } = require('@playwright/test');

// Browser tests run against the real frontend files with a mocked google.script.run. They use the installed
// Microsoft Edge (no browser download); set E2E_CHANNEL=chrome to use Chrome instead.
const channel = process.env.E2E_CHANNEL || 'msedge';
const device = (viewport, extra = {}) => ({ channel, viewport, ...extra });

module.exports = defineConfig({
  testDir: 'e2e',
  testMatch: '**/*.spec.js',
  outputDir: 'e2e/results',
  fullyParallel: true,
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:4173', trace: 'off' },
  webServer: { command: 'node e2e/server.js', url: 'http://127.0.0.1:4173', reuseExistingServer: true },
  projects: [
    { name: 'mobile-375', use: device({ width: 375, height: 667 }, { hasTouch: true, isMobile: true }) },
    { name: 'mobile-390', use: device({ width: 390, height: 844 }, { hasTouch: true, isMobile: true }) },
    { name: 'tablet-768', use: device({ width: 768, height: 1024 }, { hasTouch: true }) },
    { name: 'desktop-1280', use: device({ width: 1280, height: 800 }) },
  ],
});
