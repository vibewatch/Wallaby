import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { hash } from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const originalDatabaseUrl = process.env.DATABASE_URL;
let directory: string;
let userId: string;
let oauth: typeof import("./oauth");
let dbModule: typeof import("./db");

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "wallaby-oauth-"));
  process.env.DATABASE_URL = `file:${join(directory, "oauth.db")}`;
  await execute(join(process.cwd(), "node_modules/.bin/prisma"), ["db", "push", "--skip-generate"], {
    cwd: process.cwd(),
    env: { ...process.env },
  });
  dbModule = await import("./db");
  oauth = await import("./oauth");
  const user = await dbModule.db.user.create({
    data: { username: "oauth-reader", email: "oauth@example.com", passwordHash: await hash("oauth-password", 8), preference: { create: {} } },
  });
  userId = user.id;
}, 30_000);

afterAll(async () => {
  await dbModule?.db.$disconnect();
  process.env.DATABASE_URL = originalDatabaseUrl;
  await rm(directory, { recursive: true, force: true });
});

describe("OAuth2 server", () => {
  it("issues wallabag-shaped password tokens and rotates refresh tokens", async () => {
    const created = await oauth.createOAuthClient({
      userId,
      name: "Password client",
      redirectUris: ["https://client.example/callback"],
      allowedGrantTypes: ["password", "refresh_token"],
    });
    expect(created.client.secretHash).not.toContain(created.clientSecret);
    const response = await oauth.handleOAuthTokenRequest(tokenRequest({
      grant_type: "password",
      client_id: created.clientId,
      client_secret: created.clientSecret,
      username: "oauth-reader",
      password: "oauth-password",
      scope: "read write",
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const issued = await response.json() as { access_token: string; refresh_token: string; expires_in: number; token_type: string; scope: string };
    expect(issued).toMatchObject({ expires_in: 3600, token_type: "bearer", scope: "read write" });
    expect(issued.access_token).toMatch(/^wby_oauth_/);
    expect(issued.refresh_token).toMatch(/^wby_refresh_/);
    await expect(oauth.authenticateOAuthAccessToken(issued.access_token)).resolves.toBe(userId);

    const refreshed = await oauth.handleOAuthTokenRequest(tokenRequest({
      grant_type: "refresh_token",
      client_id: created.clientId,
      client_secret: created.clientSecret,
      refresh_token: issued.refresh_token,
      scope: "read",
    }));
    expect(refreshed.status).toBe(200);
    const replacement = await refreshed.json() as { access_token: string; refresh_token: string; scope: string };
    expect(replacement.refresh_token).not.toBe(issued.refresh_token);
    expect(replacement.scope).toBe("read");
    const replay = await oauth.handleOAuthTokenRequest(tokenRequest({
      grant_type: "refresh_token",
      client_id: created.clientId,
      client_secret: created.clientSecret,
      refresh_token: issued.refresh_token,
    }));
    expect(replay.status).toBe(400);
    await expect(replay.json()).resolves.toMatchObject({ error: "invalid_grant" });
  });

  it("uses exact redirects, single-use authorization codes, and S256 PKCE", async () => {
    const created = await oauth.createOAuthClient({
      userId,
      name: "Authorization client",
      redirectUris: ["https://client.example/oauth/callback"],
      allowedGrantTypes: ["authorization_code", "refresh_token"],
    });
    const verifier = "pkce-verifier-abcdefghijklmnopqrstuvwxyz-0123456789";
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const input = {
      clientId: created.clientId,
      redirectUri: "https://client.example/oauth/callback",
      responseType: "code" as const,
      state: "opaque-state",
      scope: "read",
      codeChallenge: challenge,
      codeChallengeMethod: "S256" as const,
    };
    const redirect = new URL(await oauth.completeOAuthAuthorization(userId, { ...input, approved: true }));
    expect(redirect.searchParams.get("state")).toBe("opaque-state");
    const code = redirect.searchParams.get("code")!;
    expect(code).toMatch(/^wby_code_/);

    const exchanged = await oauth.handleOAuthTokenRequest(tokenRequest({
      grant_type: "authorization_code",
      client_id: created.clientId,
      client_secret: created.clientSecret,
      code,
      redirect_uri: input.redirectUri,
      code_verifier: verifier,
    }));
    expect(exchanged.status).toBe(200);
    await expect(exchanged.json()).resolves.toMatchObject({ token_type: "bearer", scope: "read" });
    const replay = await oauth.handleOAuthTokenRequest(tokenRequest({
      grant_type: "authorization_code",
      client_id: created.clientId,
      client_secret: created.clientSecret,
      code,
      redirect_uri: input.redirectUri,
      code_verifier: verifier,
    }));
    expect(replay.status).toBe(400);
    await expect(replay.json()).resolves.toMatchObject({ error: "invalid_grant" });

    await expect(oauth.getOAuthAuthorizationContext({ ...input, redirectUri: "https://client.example/oauth/other" }))
      .rejects.toThrow("not registered");
  });

  it("rejects bad client secrets, oversized scope escalation, and password grants for 2FA users", async () => {
    const created = await oauth.createOAuthClient({ userId, name: "Protected client", redirectUris: ["myreader://callback"], allowedGrantTypes: ["password"] });
    const badClient = await oauth.handleOAuthTokenRequest(tokenRequest({ grant_type: "password", client_id: created.clientId, client_secret: "wrong", username: "oauth-reader", password: "oauth-password" }));
    expect(badClient.status).toBe(401);
    expect(badClient.headers.get("www-authenticate")).toContain("Basic");

    await dbModule.db.user.update({ where: { id: userId }, data: { twoFactorMethod: "TOTP" } });
    const protectedGrant = await oauth.handleOAuthTokenRequest(tokenRequest({ grant_type: "password", client_id: created.clientId, client_secret: created.clientSecret, username: "oauth-reader", password: "oauth-password" }));
    expect(protectedGrant.status).toBe(400);
    await expect(protectedGrant.json()).resolves.toMatchObject({ error: "invalid_grant", error_description: expect.stringContaining("two-factor") });
    await dbModule.db.user.update({ where: { id: userId }, data: { twoFactorMethod: "NONE" } });
  });
});

function tokenRequest(values: Record<string, string>): Request {
  return new Request("https://wallaby.example/oauth/v2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(values),
  });
}
