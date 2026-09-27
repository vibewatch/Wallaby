import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { compare } from "bcryptjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const originalEnv = { DATABASE_URL: process.env.DATABASE_URL, AUTH_URL: process.env.AUTH_URL };
let directory: string;
let dbModule: typeof import("./db");
let reset: typeof import("./password-reset");
let throttle: typeof import("./auth-throttle");

type Sent = { to: string; url: string };

beforeAll(async () => {
  directory = join(".test-runs", `password-reset-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const databaseUrl = `file:${resolve(directory, "reset.db")}`;
  process.env.DATABASE_URL = databaseUrl;
  process.env.AUTH_URL = "https://read.example";
  await execute(join(process.cwd(), "node_modules/.bin/prisma"), ["migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  dbModule = await import("./db");
  reset = await import("./password-reset");
  throttle = await import("./auth-throttle");
}, 30_000);

afterAll(async () => {
  await dbModule?.db.$disconnect();
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

beforeEach(async () => {
  await dbModule.db.authThrottle.deleteMany();
});

async function createUser(overrides: { email?: string | null } = {}) {
  const name = `reader-${randomUUID().slice(0, 8)}`;
  return dbModule.db.user.create({
    data: { username: name, email: overrides.email === undefined ? `${name}@example.com` : overrides.email, passwordHash: "$2b$04$invalidinvalidinvalidinvalidinvalidinvalidinvalidinva" },
  });
}

async function requestLink(identifier: string, address = "203.0.113.9", now?: Date): Promise<{ status: string; sent: Sent[] }> {
  const sent: Sent[] = [];
  const headers = new Headers({ "x-forwarded-for": address });
  const result = await reset.requestPasswordReset(identifier, { headers, now, send: async (message) => { sent.push(message); } });
  if (result.status === "accepted" && result.deliver) await result.deliver();
  return { status: result.status, sent };
}

function tokenFrom(url: string): string {
  const match = /^https:\/\/read\.example\/auth\/reset\/([A-Za-z0-9_-]{43})$/.exec(url);
  if (!match) throw new Error(`Unexpected reset link ${url}`);
  return match[1];
}

describe("requestPasswordReset", () => {
  it("emails a single-use link built from AUTH_URL, found by username or email", async () => {
    const user = await createUser();
    const byName = await requestLink(user.username);
    const byEmail = await requestLink(user.email!.toUpperCase());
    expect(byName.sent).toEqual([{ to: user.email, url: expect.stringMatching(/^https:\/\/read\.example\/auth\/reset\//) }]);
    expect(byEmail.sent).toHaveLength(1);
    const stored = await dbModule.db.passwordResetToken.findMany({ where: { userId: user.id } });
    expect(stored).toHaveLength(2);
    // Only a digest is kept.
    expect(stored.map(({ tokenHash }) => tokenHash)).not.toContain(tokenFrom(byName.sent[0].url));
  });

  it("answers the same for unknown accounts and accounts without email", async () => {
    const withoutEmail = await createUser({ email: null });
    expect(await requestLink("nobody-here")).toEqual({ status: "accepted", sent: [] });
    expect(await requestLink(withoutEmail.username)).toEqual({ status: "accepted", sent: [] });
  });

  it("sends at most three links an hour to one account", async () => {
    const user = await createUser();
    const now = new Date();
    const sent = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const result = await requestLink(user.username, `198.51.100.${attempt}`, now);
      expect(result.status).toBe("accepted");
      sent.push(...result.sent);
    }
    expect(sent).toHaveLength(3);
    const later = await requestLink(user.username, "198.51.100.99", new Date(now.getTime() + 61 * 60 * 1_000));
    expect(later.sent).toHaveLength(1);
  });

  it("throttles repeated requests for one identifier", async () => {
    let status = "accepted";
    for (let attempt = 0; attempt < 9; attempt += 1) status = (await requestLink("hammered", `192.0.2.${attempt}`)).status;
    expect(status).toBe("limited");
  });

  it("refuses to run without a public origin", async () => {
    process.env.AUTH_URL = "";
    try {
      expect(reset.isPasswordResetAvailable()).toBe(false);
      await expect(reset.requestPasswordReset("anyone")).rejects.toThrow("AUTH_URL");
    } finally {
      process.env.AUTH_URL = "https://read.example";
    }
  });
});

describe("resetPassword", () => {
  it("sets the password once, signs out everywhere, and revokes other links", async () => {
    const user = await createUser();
    const first = tokenFrom((await requestLink(user.username)).sent[0].url);
    const second = tokenFrom((await requestLink(user.username)).sent[0].url);
    await dbModule.db.session.create({ data: { sessionToken: randomUUID(), userId: user.id, expires: new Date(Date.now() + 60_000) } });
    await dbModule.db.trustedDevice.create({ data: { userId: user.id, tokenHash: randomUUID(), expiresAt: new Date(Date.now() + 60_000) } });
    await throttle.recordAuthFailure(user.username);

    expect(await reset.isPasswordResetTokenValid(first)).toBe(true);
    expect(await reset.resetPassword(first, "a new passphrase")).toBe("reset");

    const updated = await dbModule.db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(await compare("a new passphrase", updated.passwordHash!)).toBe(true);
    expect(updated.sessionVersion).toBe(user.sessionVersion + 1);
    expect(updated.twoFactorMethod).toBe(user.twoFactorMethod);
    expect(await dbModule.db.session.count({ where: { userId: user.id } })).toBe(0);
    expect(await dbModule.db.trustedDevice.count({ where: { userId: user.id } })).toBe(0);
    expect(await dbModule.db.authThrottle.count({ where: { key: throttle.identityThrottleKey(user.username) } })).toBe(0);

    expect(await reset.resetPassword(first, "another passphrase")).toBe("invalid");
    expect(await reset.isPasswordResetTokenValid(second)).toBe(false);
    expect(await reset.resetPassword(second, "another passphrase")).toBe("invalid");
  });

  it("lets only one of two concurrent uses win", async () => {
    const user = await createUser();
    const token = tokenFrom((await requestLink(user.username)).sent[0].url);
    const results = await Promise.all([reset.resetPassword(token, "first passphrase"), reset.resetPassword(token, "second passphrase")]);
    expect([...results].sort()).toEqual(["invalid", "reset"]);
  });

  it("rejects expired and malformed tokens", async () => {
    const user = await createUser();
    const token = tokenFrom((await requestLink(user.username)).sent[0].url);
    const later = new Date(Date.now() + 31 * 60 * 1_000);
    expect(await reset.isPasswordResetTokenValid(token, later)).toBe(false);
    expect(await reset.resetPassword(token, "a new passphrase", later)).toBe("invalid");
    expect(await reset.resetPassword("../../etc", "a new passphrase")).toBe("invalid");
    expect(await reset.resetPassword(`${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`, "a new passphrase")).toBe("invalid");
  });
});
