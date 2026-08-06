import { defineConfig, devices } from "@playwright/test";

import { e2eEnvironment } from "./e2e/environment";

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
    baseURL: "http://127.0.0.1:3100",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop-chrome", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-chrome", use: { ...devices["Pixel 7"] } },
  ],
  webServer: {
    command: "npm run build && npm run start -- --hostname 127.0.0.1 --port 3100",
    env: e2eEnvironment,
    url: "http://127.0.0.1:3100/auth/signin",
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
