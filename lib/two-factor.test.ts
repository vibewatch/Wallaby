import { afterEach, describe, expect, it } from "vitest";

import { decryptTwoFactorSecret, encryptTwoFactorSecret, generateTotp, generateTotpSecret, isTwoFactorMethod, totpProvisioningUri, verifyTotp } from "./two-factor";

const originalAuthSecret = process.env.AUTH_SECRET;
const originalTwoFactorKey = process.env.TWO_FACTOR_KEY;
const rfcSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

afterEach(() => {
  if (originalAuthSecret === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = originalAuthSecret;
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
