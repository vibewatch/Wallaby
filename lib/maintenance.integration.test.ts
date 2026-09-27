import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const originalDatabaseUrl = process.env.DATABASE_URL;
let directory: string;
let dbModule: typeof import("./db");
let maintenance: typeof import("./maintenance");

beforeAll(async () => {
  directory = join(".test-runs", `maintenance-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const databaseUrl = `file:${resolve(directory, "maintenance.db")}`;
  process.env.DATABASE_URL = databaseUrl;
  await execute(join(process.cwd(), "node_modules/.bin/prisma"), ["migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  dbModule = await import("./db");
  maintenance = await import("./maintenance");
}, 30_000);

afterAll(async () => {
  await dbModule?.db.$disconnect();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("pruneExpiredRecords", () => {
  it("removes only records the app would already reject, and keeps import history", async () => {
    const { db } = dbModule;
    const now = new Date("2026-09-01T12:00:00Z");
    const past = new Date(now.getTime() - 60_000);
    const future = new Date(now.getTime() + 60_000);
    const user = await db.user.create({ data: { username: `prune-${randomUUID().slice(0, 8)}` } });
    const userId = user.id;
    const both = async (create: (expiresAt: Date, suffix: string) => Promise<unknown>) => {
      await create(past, "old");
      await create(future, "live");
    };
    await both((expiresAt, suffix) => db.signInGrant.create({ data: { userId, tokenHash: `grant-${suffix}`, expiresAt } }));
    await both((expiresAt, suffix) => db.twoFactorChallenge.create({ data: { userId, tokenHash: `challenge-${suffix}`, method: "TOTP", expiresAt } }));
    await both((expiresAt, suffix) => db.trustedDevice.create({ data: { userId, tokenHash: `device-${suffix}`, expiresAt } }));
    await both((expiresAt, suffix) => db.passwordResetToken.create({ data: { userId, tokenHash: `reset-${suffix}`, expiresAt } }));
    await both((expires, suffix) => db.session.create({ data: { userId, sessionToken: `session-${suffix}`, expires } }));
    const client = await db.oAuthClient.create({ data: { userId, publicId: randomUUID(), name: "Prune client", secretHash: "x", redirectUris: [], allowedGrantTypes: [] } });
    await both((expiresAt, suffix) => db.oAuthAccessToken.create({ data: { clientId: client.id, userId, tokenHash: `access-${suffix}`, expiresAt } }));

    const day = 24 * 60 * 60 * 1_000;
    await db.authThrottle.create({ data: { key: "stale", windowStartedAt: new Date(now.getTime() - 2 * day), updatedAt: new Date(now.getTime() - 2 * day) } });
    await db.authThrottle.create({ data: { key: "recent", windowStartedAt: past, updatedAt: past } });
    await db.authThrottle.create({ data: { key: "still-blocked", windowStartedAt: new Date(now.getTime() - 2 * day), updatedAt: new Date(now.getTime() - 2 * day), blockedUntil: future } });

    const job = async (completedAt: Date | null, status: string) => db.importJob.create({ data: {
      userId, source: "wallabag-v2", status, completedAt,
      items: { create: [{ position: 0, payload: { url: "https://example.com/a" } }, { position: 1, payload: { url: "https://example.com/b" } }] },
    } });
    const oldJob = await job(new Date(now.getTime() - 40 * day), "completed");
    const recentJob = await job(new Date(now.getTime() - 5 * day), "completed");
    const oldPending = await job(null, "pending");

    const preview = await maintenance.pruneExpiredRecords({ now, dryRun: true });
    expect(preview).toMatchObject({ signInGrants: 1, twoFactorChallenges: 1, trustedDevices: 1, passwordResetTokens: 1, sessions: 1, oauthAccessTokens: 1, authThrottles: 1, importItems: 2 });
    expect(await db.signInGrant.count()).toBe(2);

    expect(await maintenance.pruneExpiredRecords({ now })).toEqual(preview);
    expect((await db.signInGrant.findMany()).map(({ tokenHash }) => tokenHash)).toEqual(["grant-live"]);
    expect((await db.passwordResetToken.findMany()).map(({ tokenHash }) => tokenHash)).toEqual(["reset-live"]);
    expect((await db.authThrottle.findMany({ orderBy: { key: "asc" } })).map(({ key }) => key)).toEqual(["recent", "still-blocked"]);
    expect(await db.importJob.count()).toBe(3);
    expect(await db.importJobItem.count({ where: { jobId: oldJob.id } })).toBe(0);
    expect(await db.importJobItem.count({ where: { jobId: { in: [recentJob.id, oldPending.id] } } })).toBe(4);

    expect(Object.values(await maintenance.pruneExpiredRecords({ now })).every((count) => count === 0)).toBe(true);
  });
});
