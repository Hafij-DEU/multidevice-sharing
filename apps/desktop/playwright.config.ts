import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  testMatch: '*.spec.ts',
  workers: 1,
  // CI runners are slow 2-core VMs: a test with two or three app instances sometimes starves there
  // (a loopback connection times out). One retry there; a real failure fails twice.
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  reporter: [['list']],
});
