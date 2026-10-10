import { describe, expect, it } from "vitest";

import { ProductionConfigurationError, validateProductionEnvironment } from "@/lib/production-config";

const valid = {
  AUTH_SECRET: "a-production-secret-that-is-longer-than-thirty-two-characters",
  DATABASE_URL: "file:/srv/wallaby/wallaby.db",
};

describe("production configuration", () => {
  it("accepts PostgreSQL and rejects malformed URLs and mismatched provider builds", () => {
    const postgres = { ...valid, DATABASE_URL: "postgresql://wallaby:test-password@postgres:5432/wallaby", DATABASE_PROVIDER: "postgresql" };
    expect(validateProductionEnvironment(postgres)).toEqual({ warnings: [] });
    expect(() => validateProductionEnvironment({ ...postgres, DATABASE_URL: "postgresql://postgres/" })).toThrow(/valid PostgreSQL/);
    expect(() => validateProductionEnvironment({ ...postgres, DATABASE_PROVIDER: "sqlite" })).toThrow(/does not match/);
    expect(() => validateProductionEnvironment({ ...valid, DATABASE_PROVIDER: "postgresql" })).toThrow(/does not match/);
  });
  it("accepts a minimal durable production configuration", () => {
    expect(validateProductionEnvironment(valid)).toEqual({ warnings: [] });
  });

  it("aggregates unsafe secrets, databases, feature flags, and partial SMTP settings", () => {
    try {
      validateProductionEnvironment({
        AUTH_SECRET: "replace-with-a-long-random-value",
        DATABASE_URL: "file:./dev.db",
        SITE_CREDENTIALS_KEY: "not-base64",
        WALLABY_BROWSER_RENDER: "sometimes",
        TWO_FACTOR_SMTP_HOST: "smtp.example.test",
        TWO_FACTOR_SMTP_PORT: "70000",
        TWO_FACTOR_SMTP_USER: "mailer",
      });
      throw new Error("Expected configuration validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ProductionConfigurationError);
      expect((error as ProductionConfigurationError).issues).toEqual(expect.arrayContaining([
        expect.stringContaining("AUTH_SECRET"),
        expect.stringContaining("development database"),
        expect.stringContaining("SITE_CREDENTIALS_KEY"),
        expect.stringContaining("WALLABY_BROWSER_RENDER"),
        expect.stringContaining("TWO_FACTOR_EMAIL_FROM"),
        expect.stringContaining("TWO_FACTOR_SMTP_PORT"),
        expect.stringContaining("provided together"),
      ]));
    }
  });

  it("allows localhost HTTP but requires HTTPS for a public AUTH_URL", () => {
    expect(() => validateProductionEnvironment({ ...valid, AUTH_URL: "http://127.0.0.1:3100" })).not.toThrow();
    expect(() => validateProductionEnvironment({ ...valid, AUTH_URL: "http://reader.example.test" })).toThrow(/HTTPS/);
    expect(() => validateProductionEnvironment({ ...valid, AUTH_URL: "https://reader.example.test/auth" })).toThrow(/without path/);
  });

  it("validates optional encryption material and reports relative database storage", () => {
    const key = Buffer.alloc(32, 7).toString("base64");
    expect(validateProductionEnvironment({
      ...valid,
      DATABASE_URL: "file:./storage/wallaby.db",
      SITE_CREDENTIALS_KEY: key,
      TWO_FACTOR_KEY: key,
      POCKET_TOKEN_KEY: key,
      NEXT_SERVER_ACTIONS_ENCRYPTION_KEY: key,
    }).warnings).toHaveLength(1);
  });
});
