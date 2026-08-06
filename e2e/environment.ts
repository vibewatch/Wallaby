import { resolve } from "node:path";

export const e2eRuntimeRoot = resolve(process.cwd(), ".tmp", "e2e");

export const e2eEnvironment: Record<string, string> = {
  DATABASE_URL: `file:${resolve(e2eRuntimeRoot, "wallaby.db")}`,
  AUTH_SECRET: "wallaby-e2e-auth-secret-with-at-least-32-characters",
  AUTH_TRUST_HOST: "true",
  AUTH_URL: "http://127.0.0.1:3100",
  WALLABY_MEDIA_DIR: resolve(e2eRuntimeRoot, "media"),
};
