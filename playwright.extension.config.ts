import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  testDir: "./extension-tests",
  projects: [
    { name: "chromium-extension", testMatch: "companion.spec.ts" },
    { name: "firefox-extension", testMatch: "firefox.spec.ts" },
  ],
  timeout: 90_000,
});
