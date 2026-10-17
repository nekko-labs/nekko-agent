import { join } from 'node:path';
import { defineConfig } from '@playwright/test';
import { shots } from './paths';

// Consolidated end-to-end journeys over the real renderer in a hidden Electron
// window (see e2e/README.md). Run: npm run test:e2e -w @nekko-agent/desktop
export default defineConfig({
  testDir: __dirname,
  testMatch: '*.e2e.ts',
  globalSetup: join(__dirname, 'global-setup.ts'),
  outputDir: join(shots, 'results'),
  timeout: 120_000,
  expect: { timeout: 5_000 },
  // One Electron per spec file; journeys are independent, so files can run side by side.
  fullyParallel: false,
  workers: process.env.CI ? 1 : 2,
  retries: 0,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['html', { outputFolder: join(shots, 'report'), open: 'never' }]],
});
