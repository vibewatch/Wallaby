import { defineConfig, devices } from "@playwright/test";

import { e2eBaseUrl, e2eEnvironment, e2ePort } from "./e2e/environment";

Object.assign(process.env, e2eEnvironment);

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: "list",
  use: {
    baseURL: e2eBaseUrl,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop-chrome", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chrome", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: `npm run build && npm run start -- --hostname 127.0.0.1 --port ${e2ePort}`,
    env: e2eEnvironment,
    url: `${e2eBaseUrl}/auth/signin`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
