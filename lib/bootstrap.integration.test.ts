import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { PrismaClient } from "@prisma/client";
import { compare } from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const directory = resolve(".test-runs", `bootstrap-${randomUUID()}`);
const databaseUrl = `file:${join(directory, "bootstrap.db")}`;
const env = { ...process.env, DATABASE_URL: databaseUrl };
const prisma = new PrismaClient({ datasources: { db: { url: databaseUrl } } });
const run = (script: string, extra: Record<string, string> = {}) => execute(
  join(process.cwd(), "node_modules/.bin/tsx"), [script], { env: { ...env, ...extra } },
);

beforeAll(async () => {
  await mkdir(directory, { recursive: true });
  await execute(join(process.cwd(), "node_modules/.bin/prisma"), ["migrate", "deploy"], { env });
}, 30_000);

afterAll(async () => {
  await prisma.$disconnect();
  await rm(directory, { recursive: true, force: true });
});

describe("real instance setup", () => {
  it("seeds only configuration, without demo accounts or articles", async () => {
    await run("prisma/seed.ts");
    await run("prisma/seed.ts");
    expect(await prisma.user.count()).toBe(0);
    expect(await prisma.entry.count()).toBe(0);
    expect(await prisma.instanceConfiguration.count()).toBe(1);
    expect(await prisma.ignoreOriginInstanceRule.count()).toBe(3);
  });

  it("rejects a weak bootstrap password without creating an account", async () => {
    await expect(run("scripts/bootstrap-admin.ts", {
      BOOTSTRAP_ADMIN_USERNAME: "admin",
      BOOTSTRAP_ADMIN_PASSWORD: "short",
    })).rejects.toThrow("BOOTSTRAP_ADMIN_PASSWORD");
    expect(await prisma.user.count()).toBe(0);
  });

  it("creates a real administrator and never resets it during setup", async () => {
    const password = "isolated-test-admin-password";
    await run("scripts/bootstrap-admin.ts", { BOOTSTRAP_ADMIN_USERNAME: "admin", BOOTSTRAP_ADMIN_PASSWORD: password });
    const admin = await prisma.user.findUniqueOrThrow({ where: { username: "admin" }, include: { preference: true } });
    expect(admin.role).toBe("ADMIN");
    expect(admin.preference).not.toBeNull();
    expect(await compare(password, admin.passwordHash!)).toBe(true);
    await run("scripts/bootstrap-admin.ts", { BOOTSTRAP_ADMIN_USERNAME: "another-admin", BOOTSTRAP_ADMIN_PASSWORD: "do-not-reset-the-existing-password" });
    await run("prisma/seed.ts");
    expect(await prisma.user.count()).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: admin.id } })).passwordHash).toBe(admin.passwordHash);
  });
});
