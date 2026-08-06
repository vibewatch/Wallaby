import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const algorithm = "aes-256-gcm";

export function isCredentialEncryptionConfigured(): boolean {
  try {
    getKey();
    return true;
  } catch {
    return false;
  }
}

export function encryptSecret(value: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(algorithm, key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

export function decryptSecret(payload: string): string {
  const [version, encodedIv, encodedTag, encodedCiphertext] = payload.split(":");
  if (version !== "v1" || !encodedIv || !encodedTag || encodedCiphertext === undefined) {
    throw new Error("Unsupported encrypted credential payload");
  }
  const decipher = createDecipheriv(algorithm, getKey(), Buffer.from(encodedIv, "base64url"));
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(encodedCiphertext, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

function getKey(): Buffer {
  const raw = process.env.SITE_CREDENTIALS_KEY;
  if (!raw) throw new Error("SITE_CREDENTIALS_KEY is required for site credentials");
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("SITE_CREDENTIALS_KEY must be a base64-encoded 32-byte key");
  return key;
}
