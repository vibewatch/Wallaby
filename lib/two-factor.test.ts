import { afterEach, describe, expect, it } from "vitest";

import { db } from "./db";
import { confirmEmailSetup, consumeSignInGrant, createEmailSetup, createLoginChallenge, decryptTwoFactorSecret, encryptTwoFactorSecret, generateTotp, generateTotpSecret, getLoginChallenge, isTwoFactorMethod, registerTrustedDevice, revokeTrustedDevices, totpProvisioningUri, verifyLoginChallenge, verifyTotp, isTrustedDevice } from "./two-factor";

const originalAuthSecret = process.env.AUTH_SECRET;
const originalTwoFactorKey = process.env.TWO_FACTOR_KEY;
const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

afterEach(() => {
  process.env.AUTH_SECRET = originalAuthSecret;
  if (originalTwoFactorKey === undefined) delete process.env.TWO_FACTOR_KEY;
  else process.env.TWO_FACTOR_KEY = originalTwoFactorKey;
});

describe("TOTP interoperability", () => {
  it.each([
    [59_000, "287082"],
    [1_111_111_109_000, "081804"],
    [1_111_111_111_000, "050471"],
    [1_234_567_890_000, "005924"],
    [2_000_000_000_000, "279037"],
    [20_000_000_000_000, "353130"],
  ])("matches the six-digit RFC 6238 SHA-1 result at %i ms", (now, code) => {
    expect(generateTotp(rfcSecret, now)).toBe(code);
    expect(verifyTotp(rfcSecret, code, now)).toBe(true);
  });

  it("accepts one adjacent time step but rejects malformed and older codes", () => {
    const now = 1_700_000_000_000;
    const previous = generateTotp(rfcSecret, now - 30_000);
    expect(verifyTotp(rfcSecret, previous, now)).toBe(true);
    expect(verifyTotp(rfcSecret, generateTotp(rfcSecret, now - 60_000), now)).toBe(false);
    expect(verifyTotp(rfcSecret, "12345", now)).toBe(false);
  });
});

describe("two-factor secret storage", () => {
  it("encrypts secrets with authenticated AES and rejects tampering", () => {
    process.env.TWO_FACTOR_KEY = Buffer.alloc(32, 7).toString("base64");
    const secret = generateTotpSecret();
    const encrypted = encryptTwoFactorSecret(secret);
    expect(encrypted).not.toContain(secret);
    expect(decryptTwoFactorSecret(encrypted)).toBe(secret);
    const parts = encrypted.split(":");
    const middle = Math.floor(parts[3].length / 2);
    parts[3] = `${parts[3].slice(0, middle)}${parts[3][middle] === "A" ? "B" : "A"}${parts[3].slice(middle + 1)}`;
    expect(() => decryptTwoFactorSecret(parts.join(":"))).toThrow();
  });

  it("builds an interoperable provisioning URI without leaking unsupported methods", () => {
    const uri = new URL(totpProvisioningUri({ secret: rfcSecret, username: "reader@example.test" }));
    expect(uri.protocol).toBe("otpauth:");
    expect(decodeURIComponent(uri.pathname)).toBe("/Wallaby:reader@example.test");
    expect(uri.searchParams.get("secret")).toBe(rfcSecret);
    expect(uri.searchParams.get("issuer")).toBe("Wallaby");
    expect(isTwoFactorMethod("TOTP")).toBe(true);
    expect(isTwoFactorMethod("SMS")).toBe(false);
  });
});

describe("email challenges and trusted devices", () => {
  it("verifies delivered codes, consumes grants once, and revokes trusted devices", async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await db.user.create({ data: { username: `two-factor-unit-${unique}`, email: `two-factor-unit-${unique}@example.test` } });
    try {
      let setupCode = "";
      await createEmailSetup(user.id, async ({ code, purpose, to }) => {
        expect(purpose).toBe("setup");
        expect(to).toBe(user.email);
        setupCode = code;
      });
      expect((await confirmEmailSetup(user.id, setupCode === "000000" ? "000001" : "000000")).ok).toBe(false);
      expect((await confirmEmailSetup(user.id, setupCode)).ok).toBe(true);
      expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).twoFactorMethod).toBe("EMAIL");

      let loginCode = "";
      const challengeToken = await createLoginChallenge(user.id, "EMAIL", async ({ code, purpose }) => {
        expect(purpose).toBe("sign-in");
        loginCode = code;
      });
      expect(await getLoginChallenge(challengeToken)).toMatchObject({ method: "EMAIL" });
      expect((await verifyLoginChallenge(challengeToken, loginCode === "999999" ? "999998" : "999999")).ok).toBe(false);
      const verified = await verifyLoginChallenge(challengeToken, loginCode);
      expect(verified.ok).toBe(true);
      if (!verified.ok) throw new Error("Email challenge should have produced a sign-in grant");
      expect((await verifyLoginChallenge(challengeToken, loginCode)).ok).toBe(false);
      expect((await consumeSignInGrant(verified.grant))?.id).toBe(user.id);
      expect(await consumeSignInGrant(verified.grant)).toBeNull();

      const device = await registerTrustedDevice(user.id);
      expect(await isTrustedDevice(user.id, device.token)).toBe(true);
      expect(await revokeTrustedDevices(user.id)).toBe(1);
      expect(await isTrustedDevice(user.id, device.token)).toBe(false);
    } finally {
      await db.user.deleteMany({ where: { id: user.id } });
    }
  });
});
