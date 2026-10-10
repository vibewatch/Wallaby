import { resolve } from "node:path";

export const e2eRuntimeRoot = resolve(process.cwd(), ".tmp", "e2e");

/** The port of the SMTP sink the password-reset spec listens on. */
export const e2eMailPort = 2526;

export const e2eEnvironment: Record<string, string> = {
  DATABASE_URL: `file:${resolve(e2eRuntimeRoot, "wallaby.db")}`,
  AUTH_SECRET: "wallaby-e2e-auth-secret-with-at-least-32-characters",
  SITE_CREDENTIALS_KEY: Buffer.alloc(32, 1).toString("base64"),
  TWO_FACTOR_KEY: Buffer.alloc(32, 2).toString("base64"),
  POCKET_TOKEN_KEY: Buffer.alloc(32, 3).toString("base64"),
  AUTH_TRUST_HOST: "true",
  AUTH_URL: "http://127.0.0.1:3100",
  WALLABY_MEDIA_DIR: resolve(e2eRuntimeRoot, "media"),
  TWO_FACTOR_SMTP_HOST: "127.0.0.1",
  TWO_FACTOR_SMTP_PORT: String(e2eMailPort),
  TWO_FACTOR_SMTP_SECURITY: "none",
  TWO_FACTOR_EMAIL_FROM: "Wallaby <wallaby@example.test>",
};
