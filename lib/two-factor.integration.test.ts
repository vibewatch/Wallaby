import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const originalDatabaseUrl = process.env.DATABASE_URL;
let directory: string;
let dbModule: typeof import("./db");
let twoFactor: typeof import("./two-factor");

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "wallaby-two-factor-"));
  process.env.DATABASE_URL = `file:${join(directory, "two-factor.db")}`;
  await execute(join(process.cwd(), "node_modules/.bin/prisma"), ["migrate", "deploy"], { env: { ...process.env } });
  dbModule = await import("./db");
  twoFactor = await import("./two-factor");
}, 30_000);

afterAll(async () => {
  await dbModule?.db.$disconnect();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("email challenges and trusted devices", () => {
  it("verifies delivered codes, consumes grants once, and revokes trusted devices", async () => {
    const { db } = dbModule;
    const user = await db.user.create({ data: { username: "two-factor-reader", email: "two-factor@example.test" } });
    let setupCode = "";
    await twoFactor.createEmailSetup(user.id, async ({ code, purpose, to }) => {
      expect(purpose).toBe("setup");
      expect(to).toBe(user.email);
      setupCode = code;
    });
    expect((await twoFactor.confirmEmailSetup(user.id, setupCode === "000000" ? "000001" : "000000")).ok).toBe(false);
    expect((await twoFactor.confirmEmailSetup(user.id, setupCode)).ok).toBe(true);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).twoFactorMethod).toBe("EMAIL");

    let loginCode = "";
    const challengeToken = await twoFactor.createLoginChallenge(user.id, "EMAIL", async ({ code, purpose }) => {
      expect(purpose).toBe("sign-in");
      loginCode = code;
    });
    expect(await twoFactor.getLoginChallenge(challengeToken)).toMatchObject({ method: "EMAIL" });
    expect((await twoFactor.verifyLoginChallenge(challengeToken, loginCode === "999999" ? "999998" : "999999")).ok).toBe(false);
    const verified = await twoFactor.verifyLoginChallenge(challengeToken, loginCode);
    expect(verified.ok).toBe(true);
    if (!verified.ok) throw new Error("Email challenge should have produced a sign-in grant");
    expect((await twoFactor.verifyLoginChallenge(challengeToken, loginCode)).ok).toBe(false);
    expect((await twoFactor.consumeSignInGrant(verified.grant))?.id).toBe(user.id);
    expect(await twoFactor.consumeSignInGrant(verified.grant)).toBeNull();

    const device = await twoFactor.registerTrustedDevice(user.id);
    expect(await twoFactor.isTrustedDevice(user.id, device.token)).toBe(true);
    expect(await twoFactor.revokeTrustedDevices(user.id)).toBe(1);
    expect(await twoFactor.isTrustedDevice(user.id, device.token)).toBe(false);
  });
});
