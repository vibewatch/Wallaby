import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

import { compare, hash } from "bcryptjs";
import type { Prisma } from "@prisma/client";
import QRCode from "qrcode";

import { db } from "@/lib/db";
import { isInstanceEmailConfigured, sendInstanceEmail } from "@/lib/mail";

export const TWO_FACTOR_CHALLENGE_COOKIE = "wallaby.two-factor";
export const TRUSTED_DEVICE_COOKIE = "wallaby.trusted-device";

const challengeLifetimeMs = 10 * 60 * 1_000;
const setupLifetimeMs = 15 * 60 * 1_000;
const signInGrantLifetimeMs = 2 * 60 * 1_000;
const trustedDeviceLifetimeMs = 15 * 24 * 60 * 60 * 1_000;
const maximumAttempts = 5;
const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const recoveryAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export type TwoFactorMethod = "NONE" | "TOTP" | "EMAIL";
export type EmailCodePurpose = "setup" | "sign-in";
export type EmailCodeSender = (input: { to: string; code: string; purpose: EmailCodePurpose }) => Promise<void>;

export function isTwoFactorMethod(value: string): value is TwoFactorMethod {
  return value === "NONE" || value === "TOTP" || value === "EMAIL";
}

export function isTwoFactorEncryptionConfigured(): boolean {
  try {
    encryptionKey();
    return true;
  } catch {
    return false;
  }
}

export function isTwoFactorEmailConfigured(): boolean {
  return isInstanceEmailConfigured();
}

export function generateTotpSecret(): string {
  return encodeBase32(randomBytes(20));
}

export function totpProvisioningUri(input: { secret: string; username: string; issuer?: string }): string {
  const issuer = input.issuer ?? "Wallaby";
  const label = `${issuer}:${input.username}`;
  const params = new URLSearchParams({ secret: input.secret, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

export function generateTotp(secret: string, now = Date.now()): string {
  const counter = BigInt(Math.floor(now / 30_000));
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(counter);
  const digest = createHmac("sha1", decodeBase32(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

export function verifyTotp(secret: string, candidate: string, now = Date.now()): boolean {
  const normalized = candidate.replace(/[\s-]+/g, "");
  if (!/^\d{6}$/.test(normalized)) return false;
  return [-1, 0, 1].some((offset) => safeEqual(generateTotp(secret, now + offset * 30_000), normalized));
}

export async function createTotpSetup(userId: string): Promise<{
  secret: string;
  provisioningUri: string;
  qrCodeDataUrl: string;
  recoveryCodes: string[];
}> {
  assertEncryptionAvailable();
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { username: true, email: true } });
  const secret = generateTotpSecret();
  const recoveryCodes = generateRecoveryCodes();
  const recoveryCodeHashes = await Promise.all(recoveryCodes.map((code) => hash(normalizeRecoveryCode(code), 10)));
  const provisioningUri = totpProvisioningUri({ secret, username: user.email || user.username });
  await db.twoFactorSetup.upsert({
    where: { userId },
    create: {
      userId,
      method: "TOTP",
      encryptedSecret: encryptTwoFactorSecret(secret),
      recoveryCodeHashes,
      expiresAt: new Date(Date.now() + setupLifetimeMs),
    },
    update: {
      method: "TOTP",
      encryptedSecret: encryptTwoFactorSecret(secret),
      emailCodeHash: null,
      recoveryCodeHashes,
      attempts: 0,
      expiresAt: new Date(Date.now() + setupLifetimeMs),
      createdAt: new Date(),
    },
  });
  const qrCodeDataUrl = await QRCode.toDataURL(provisioningUri, { errorCorrectionLevel: "M", margin: 1, width: 220 });
  return { secret, provisioningUri, qrCodeDataUrl, recoveryCodes };
}

export async function confirmTotpSetup(userId: string, code: string): Promise<{ ok: boolean; error?: string }> {
  const setup = await db.twoFactorSetup.findUnique({ where: { userId } });
  if (!setup || setup.method !== "TOTP" || !setup.encryptedSecret || setup.expiresAt <= new Date()) {
    if (setup) await db.twoFactorSetup.deleteMany({ where: { id: setup.id } });
    return { ok: false, error: "The authenticator setup expired. Start again." };
  }
  if (!verifyTotp(decryptTwoFactorSecret(setup.encryptedSecret), code)) {
    await recordSetupFailure(setup.id, setup.attempts);
    return { ok: false, error: setup.attempts + 1 >= maximumAttempts ? "Too many invalid codes. Start again." : "That authenticator code is invalid." };
  }
  const recoveryCodeHashes = jsonStringArray(setup.recoveryCodeHashes);
  const operations: Prisma.PrismaPromise<unknown>[] = [
    db.user.update({ where: { id: userId }, data: { twoFactorMethod: "TOTP", twoFactorSecret: setup.encryptedSecret, sessionVersion: { increment: 1 } } }),
    db.recoveryCode.deleteMany({ where: { userId } }),
    db.trustedDevice.deleteMany({ where: { userId } }),
    db.twoFactorChallenge.deleteMany({ where: { userId } }),
    db.signInGrant.deleteMany({ where: { userId } }),
    db.session.deleteMany({ where: { userId } }),
    db.twoFactorSetup.deleteMany({ where: { id: setup.id, userId } }),
  ];
  if (recoveryCodeHashes.length) operations.push(db.recoveryCode.createMany({ data: recoveryCodeHashes.map((codeHash) => ({ userId, codeHash })) }));
  await db.$transaction(operations);
  return { ok: true };
}

export async function createEmailSetup(userId: string, sender: EmailCodeSender = sendEmailCode): Promise<void> {
  if (!isTwoFactorEmailConfigured() && sender === sendEmailCode) throw new Error("Email two-factor delivery is not configured");
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
  if (!user.email) throw new Error("Add an email address before enabling email two-factor authentication");
  const code = generateEmailCode();
  const setup = await db.twoFactorSetup.upsert({
    where: { userId },
    create: { userId, method: "EMAIL", emailCodeHash: await hash(code, 10), expiresAt: new Date(Date.now() + setupLifetimeMs) },
    update: {
      method: "EMAIL",
      encryptedSecret: null,
      emailCodeHash: await hash(code, 10),
      recoveryCodeHashes: [],
      attempts: 0,
      expiresAt: new Date(Date.now() + setupLifetimeMs),
      createdAt: new Date(),
    },
  });
  try {
    await sender({ to: user.email, code, purpose: "setup" });
  } catch (error) {
    await db.twoFactorSetup.deleteMany({ where: { id: setup.id } });
    throw error;
  }
}

export async function confirmEmailSetup(userId: string, code: string): Promise<{ ok: boolean; error?: string }> {
  const setup = await db.twoFactorSetup.findUnique({ where: { userId } });
  if (!setup || setup.method !== "EMAIL" || !setup.emailCodeHash || setup.expiresAt <= new Date()) {
    if (setup) await db.twoFactorSetup.deleteMany({ where: { id: setup.id } });
    return { ok: false, error: "The email verification code expired. Send a new one." };
  }
  if (!/^\d{6}$/.test(code.trim()) || !(await compare(code.trim(), setup.emailCodeHash))) {
    await recordSetupFailure(setup.id, setup.attempts);
    return { ok: false, error: setup.attempts + 1 >= maximumAttempts ? "Too many invalid codes. Send a new one." : "That email verification code is invalid." };
  }
  await db.$transaction([
    db.user.update({ where: { id: userId }, data: { twoFactorMethod: "EMAIL", twoFactorSecret: null, sessionVersion: { increment: 1 } } }),
    db.recoveryCode.deleteMany({ where: { userId } }),
    db.trustedDevice.deleteMany({ where: { userId } }),
    db.twoFactorChallenge.deleteMany({ where: { userId } }),
    db.signInGrant.deleteMany({ where: { userId } }),
    db.session.deleteMany({ where: { userId } }),
    db.twoFactorSetup.deleteMany({ where: { id: setup.id, userId } }),
  ]);
  return { ok: true };
}

export async function disableTwoFactor(userId: string): Promise<void> {
  await db.$transaction([
    db.user.update({ where: { id: userId }, data: { twoFactorMethod: "NONE", twoFactorSecret: null, sessionVersion: { increment: 1 } } }),
    db.twoFactorSetup.deleteMany({ where: { userId } }),
    db.twoFactorChallenge.deleteMany({ where: { userId } }),
    db.trustedDevice.deleteMany({ where: { userId } }),
    db.recoveryCode.deleteMany({ where: { userId } }),
    db.signInGrant.deleteMany({ where: { userId } }),
    db.session.deleteMany({ where: { userId } }),
  ]);
}

export async function regenerateRecoveryCodes(userId: string): Promise<string[]> {
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { twoFactorMethod: true } });
  if (user.twoFactorMethod !== "TOTP") throw new Error("Recovery codes are available only for authenticator-app two-factor authentication");
  const recoveryCodes = generateRecoveryCodes();
  const codeHashes = await Promise.all(recoveryCodes.map((code) => hash(normalizeRecoveryCode(code), 10)));
  await db.$transaction([
    db.recoveryCode.deleteMany({ where: { userId } }),
    db.recoveryCode.createMany({ data: codeHashes.map((codeHash) => ({ userId, codeHash })) }),
  ]);
  return recoveryCodes;
}

export async function revokeTrustedDevices(userId: string): Promise<number> {
  return (await db.trustedDevice.deleteMany({ where: { userId } })).count;
}

export async function createLoginChallenge(userId: string, method: Exclude<TwoFactorMethod, "NONE">, sender: EmailCodeSender = sendEmailCode): Promise<string> {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + challengeLifetimeMs);
  let emailCodeHash: string | null = null;
  let emailCode: string | null = null;
  const user = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, twoFactorMethod: true } });
  if (user.twoFactorMethod !== method) throw new Error("Two-factor method changed");
  if (method === "EMAIL") {
    if (!user.email) throw new Error("The account has no email address for two-factor delivery");
    if (!isTwoFactorEmailConfigured() && sender === sendEmailCode) throw new Error("Email two-factor delivery is not configured");
    emailCode = generateEmailCode();
    emailCodeHash = await hash(emailCode, 10);
  }
  await db.$transaction([
    db.twoFactorChallenge.deleteMany({ where: { userId } }),
    db.signInGrant.deleteMany({ where: { userId, expiresAt: { lte: new Date() } } }),
  ]);
  const challenge = await db.twoFactorChallenge.create({ data: { userId, tokenHash: hashToken(token), method, emailCodeHash, expiresAt } });
  if (method === "EMAIL") {
    try {
      await sender({ to: user.email!, code: emailCode!, purpose: "sign-in" });
    } catch (error) {
      await db.twoFactorChallenge.deleteMany({ where: { id: challenge.id } });
      throw error;
    }
  }
  return token;
}

export async function getLoginChallenge(token: string | undefined): Promise<{ method: Exclude<TwoFactorMethod, "NONE">; destination?: string } | null> {
  if (!token) return null;
  const challenge = await db.twoFactorChallenge.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { select: { email: true, twoFactorMethod: true } } },
  });
  if (!challenge || challenge.expiresAt <= new Date() || challenge.attempts >= maximumAttempts || challenge.user.twoFactorMethod !== challenge.method) {
    if (challenge) await db.twoFactorChallenge.deleteMany({ where: { id: challenge.id } });
    return null;
  }
  if (challenge.method !== "TOTP" && challenge.method !== "EMAIL") return null;
  return { method: challenge.method, destination: challenge.method === "EMAIL" ? maskEmail(challenge.user.email) : undefined };
}

export async function verifyLoginChallenge(token: string, code: string): Promise<{ ok: true; grant: string; userId: string } | { ok: false; error: string }> {
  const challenge = await db.twoFactorChallenge.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { user: { include: { recoveryCodes: true } } },
  });
  if (!challenge || challenge.expiresAt <= new Date() || challenge.attempts >= maximumAttempts || challenge.user.twoFactorMethod !== challenge.method) {
    if (challenge) await db.twoFactorChallenge.deleteMany({ where: { id: challenge.id } });
    return { ok: false, error: "This sign-in challenge expired. Start again." };
  }

  let valid = false;
  let recoveryCodeId: string | null = null;
  if (challenge.method === "TOTP" && challenge.user.twoFactorSecret) {
    valid = verifyTotp(decryptTwoFactorSecret(challenge.user.twoFactorSecret), code);
    if (!valid) {
      const normalized = normalizeRecoveryCode(code);
      for (const recoveryCode of challenge.user.recoveryCodes) {
        if (await compare(normalized, recoveryCode.codeHash)) {
          valid = true;
          recoveryCodeId = recoveryCode.id;
          break;
        }
      }
    }
  } else if (challenge.method === "EMAIL" && challenge.emailCodeHash && /^\d{6}$/.test(code.trim())) {
    valid = await compare(code.trim(), challenge.emailCodeHash);
  }

  if (!valid) {
    const nextAttempts = challenge.attempts + 1;
    if (nextAttempts >= maximumAttempts) await db.twoFactorChallenge.deleteMany({ where: { id: challenge.id } });
    else await db.twoFactorChallenge.updateMany({ where: { id: challenge.id, attempts: challenge.attempts }, data: { attempts: { increment: 1 } } });
    return { ok: false, error: nextAttempts >= maximumAttempts ? "Too many invalid codes. Start sign-in again." : "That authentication code is invalid." };
  }

  const grant = randomToken();
  try {
    await db.$transaction(async (transaction) => {
      const consumed = await transaction.twoFactorChallenge.deleteMany({ where: { id: challenge.id, tokenHash: challenge.tokenHash } });
      if (consumed.count !== 1) throw new Error("Challenge was already used");
      if (recoveryCodeId) {
        const recovery = await transaction.recoveryCode.deleteMany({ where: { id: recoveryCodeId, userId: challenge.userId } });
        if (recovery.count !== 1) throw new Error("Recovery code was already used");
      }
      await transaction.signInGrant.create({ data: {
        userId: challenge.userId,
        tokenHash: hashToken(grant),
        expiresAt: new Date(Date.now() + signInGrantLifetimeMs),
      } });
    });
  } catch {
    return { ok: false, error: "This authentication code has already been used. Start again." };
  }
  return { ok: true, grant, userId: challenge.userId };
}

export async function cancelLoginChallenge(token: string | undefined): Promise<void> {
  if (token) await db.twoFactorChallenge.deleteMany({ where: { tokenHash: hashToken(token) } });
}

export async function issueSignInGrant(userId: string): Promise<string> {
  const grant = randomToken();
  await db.signInGrant.create({ data: { userId, tokenHash: hashToken(grant), expiresAt: new Date(Date.now() + signInGrantLifetimeMs) } });
  return grant;
}

export async function consumeSignInGrant(grant: string): Promise<{
  id: string;
  name: string | null;
  username: string;
  email: string | null;
  role: "USER" | "ADMIN";
  sessionVersion: number;
} | null> {
  const record = await db.signInGrant.findUnique({ where: { tokenHash: hashToken(grant) }, include: { user: true } });
  if (!record) return null;
  const consumed = await db.signInGrant.deleteMany({ where: { id: record.id, tokenHash: record.tokenHash } });
  if (consumed.count !== 1 || record.expiresAt <= new Date()) return null;
  return record.user;
}

export async function isTrustedDevice(userId: string, token: string | undefined): Promise<boolean> {
  if (!token) return false;
  const device = await db.trustedDevice.findUnique({ where: { tokenHash: hashToken(token) } });
  if (!device || device.userId !== userId || device.expiresAt <= new Date()) {
    if (device) await db.trustedDevice.deleteMany({ where: { id: device.id } });
    return false;
  }
  await db.trustedDevice.updateMany({ where: { id: device.id }, data: { lastUsedAt: new Date() } });
  return true;
}

export async function registerTrustedDevice(userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + trustedDeviceLifetimeMs);
  await db.trustedDevice.create({ data: { userId, tokenHash: hashToken(token), expiresAt } });
  return { token, expiresAt };
}

export function encryptTwoFactorSecret(secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

export function decryptTwoFactorSecret(payload: string): string {
  const [version, encodedIv, encodedTag, encodedCiphertext] = payload.split(":");
  if (version !== "v1" || !encodedIv || !encodedTag || encodedCiphertext === undefined) throw new Error("Unsupported encrypted two-factor secret");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(encodedIv, "base64url"));
  decipher.setAuthTag(Buffer.from(encodedTag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encodedCiphertext, "base64url")), decipher.final()]).toString("utf8");
}

export async function sendEmailCode({ to, code, purpose }: { to: string; code: string; purpose: EmailCodePurpose }): Promise<void> {
  await sendInstanceEmail({
    to,
    subject: purpose === "setup" ? "Confirm Wallaby two-factor authentication" : "Your Wallaby sign-in code",
    text: `${code} is your Wallaby ${purpose === "setup" ? "two-factor setup" : "sign-in"} code. It expires in 10 minutes. If you did not request it, you can ignore this message.`,
  });
}

function encryptionKey(): Buffer {
  const configured = process.env.TWO_FACTOR_KEY?.trim();
  if (configured) {
    const key = Buffer.from(configured, "base64");
    if (key.length !== 32) throw new Error("TWO_FACTOR_KEY must be a base64-encoded 32-byte key");
    return key;
  }
  const authSecret = process.env.AUTH_SECRET;
  if (!authSecret || authSecret.length < 16) throw new Error("TWO_FACTOR_KEY or a strong AUTH_SECRET is required for two-factor encryption");
  return createHash("sha256").update("wallaby:two-factor:v1\0").update(authSecret).digest();
}

function assertEncryptionAvailable(): void {
  encryptionKey();
}

function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += base32Alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += base32Alphabet[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(value: string): Buffer {
  const normalized = value.toUpperCase().replace(/=+$/g, "").replace(/[\s-]+/g, "");
  let bits = 0;
  let current = 0;
  const output: number[] = [];
  for (const character of normalized) {
    const index = base32Alphabet.indexOf(character);
    if (index < 0) throw new Error("Invalid base32 TOTP secret");
    current = (current << 5) | index;
    bits += 5;
    if (bits >= 8) {
      output.push((current >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (!output.length) throw new Error("Empty TOTP secret");
  return Buffer.from(output);
}

function generateRecoveryCodes(): string[] {
  return Array.from({ length: 10 }, () => {
    let raw = "";
    for (let index = 0; index < 12; index += 1) raw += recoveryAlphabet[randomInt(recoveryAlphabet.length)];
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8)}`;
  });
}

function generateEmailCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

function normalizeRecoveryCode(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function safeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function jsonStringArray(value: Prisma.JsonValue | null): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

async function recordSetupFailure(setupId: string, attempts: number): Promise<void> {
  if (attempts + 1 >= maximumAttempts) await db.twoFactorSetup.deleteMany({ where: { id: setupId } });
  else await db.twoFactorSetup.updateMany({ where: { id: setupId, attempts }, data: { attempts: { increment: 1 } } });
}

function maskEmail(email: string | null): string | undefined {
  if (!email) return undefined;
  const [local, domain] = email.split("@");
  if (!local || !domain) return undefined;
  return `${local.slice(0, 1)}${"•".repeat(Math.max(2, Math.min(6, local.length - 1)))}@${domain}`;
}
