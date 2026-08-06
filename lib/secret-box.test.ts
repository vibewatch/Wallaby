import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { decryptSecret, encryptSecret, isCredentialEncryptionConfigured } from "./secret-box";

const originalKey = process.env.SITE_CREDENTIALS_KEY;

beforeAll(() => {
  process.env.SITE_CREDENTIALS_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
});

afterAll(() => {
  process.env.SITE_CREDENTIALS_KEY = originalKey;
});

describe("site credential encryption", () => {
  it("round trips with authenticated encryption and a random nonce", () => {
    const first = encryptSecret("reader@example.com");
    const second = encryptSecret("reader@example.com");
    expect(first).not.toBe(second);
    expect(decryptSecret(first)).toBe("reader@example.com");
    expect(isCredentialEncryptionConfigured()).toBe(true);
  });

  it("rejects a modified ciphertext", () => {
    const encrypted = encryptSecret("private-password");
    const parts = encrypted.split(":");
    const ciphertext = Buffer.from(parts[3], "base64url");
    ciphertext[0] ^= 0xff;
    parts[3] = ciphertext.toString("base64url");
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });
});
