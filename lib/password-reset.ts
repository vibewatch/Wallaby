import { createHash, randomBytes } from "node:crypto";

import { hash } from "bcryptjs";

import { checkAuthThrottle, clearIdentityThrottle, recordAuthFailure } from "@/lib/auth-throttle";
import { db } from "@/lib/db";
import { isInstanceEmailConfigured, sendInstanceEmail } from "@/lib/mail";

/**
 * Self-service password reset by emailed link. It is only offered when the
 * instance can send email and knows its public address (`AUTH_URL`); links are
 * never built from request headers, which an attacker could forge to point a
 * victim's reset link at their own host.
 */

type HeaderSource = { get(name: string): string | null } | undefined;
export type PasswordResetSender = (input: { to: string; url: string }) => Promise<void>;

const tokenLifetimeMs = 30 * 60 * 1_000;
const requestWindowMs = 60 * 60 * 1_000;
const maximumRequestsPerWindow = 3;
const throttlePrefix = "password-reset:";

export function passwordResetOrigin(): string | null {
  try {
    const url = new URL(process.env.AUTH_URL ?? "");
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

export function isPasswordResetAvailable(): boolean {
  return isInstanceEmailConfigured() && passwordResetOrigin() !== null;
}

export async function sendPasswordResetEmail({ to, url }: { to: string; url: string }): Promise<void> {
  await sendInstanceEmail({
    to,
    subject: "Reset your Wallaby password",
    text: `Someone asked to reset the password for your Wallaby account. To choose a new password, open this link within 30 minutes:\n\n${url}\n\nThe link works once. If you did not ask for this, you can ignore this message; your password has not changed.`,
  });
}

export type PasswordResetRequest =
  | { status: "limited" }
  /** `deliver` is present only when an email is due. The caller runs it after
   *  responding, so the reply takes the same time whether or not the account
   *  exists. */
  | { status: "accepted"; deliver?: () => Promise<void> };

export async function requestPasswordReset(
  identifier: string,
  { headers, send = sendPasswordResetEmail, now = new Date() }: { headers?: HeaderSource; send?: PasswordResetSender; now?: Date } = {},
): Promise<PasswordResetRequest> {
  const origin = passwordResetOrigin();
  if (!origin) throw new Error("Password reset requires AUTH_URL");
  const normalized = identifier.normalize("NFKC").trim();
  // Every request counts, whether or not the account exists, so the throttle
  // itself reveals nothing and cannot be used to flood a mailbox.
  const throttleId = `${throttlePrefix}${normalized}`;
  if ((await checkAuthThrottle(throttleId, headers, now)).limited) return { status: "limited" };
  await recordAuthFailure(throttleId, headers, now);
  if (normalized.length === 0 || normalized.length > 320) return { status: "accepted" };

  const user = await db.user.findFirst({
    where: { OR: [{ username: normalized }, { email: normalized.toLowerCase() }] },
    select: { id: true, email: true },
  });
  if (!user?.email) return { status: "accepted" };
  const recent = await db.passwordResetToken.count({ where: { userId: user.id, createdAt: { gt: new Date(now.getTime() - requestWindowMs) } } });
  if (recent >= maximumRequestsPerWindow) return { status: "accepted" };

  const token = randomBytes(32).toString("base64url");
  await db.passwordResetToken.create({ data: { userId: user.id, tokenHash: digest(token), expiresAt: new Date(now.getTime() + tokenLifetimeMs), createdAt: now } });
  const to = user.email;
  return { status: "accepted", deliver: () => send({ to, url: `${origin}/auth/reset/${token}` }) };
}

/** Whether a reset link can still be used, without using it. */
export async function isPasswordResetTokenValid(token: string, now = new Date()): Promise<boolean> {
  if (!wellFormed(token)) return false;
  const record = await db.passwordResetToken.findUnique({ where: { tokenHash: digest(token) }, select: { expiresAt: true } });
  return Boolean(record && record.expiresAt > now);
}

/**
 * Sets a new password from a reset link and signs the account out everywhere.
 * Two-factor authentication stays on: the link proves control of the mailbox,
 * not of the second factor.
 */
export async function resetPassword(token: string, password: string, now = new Date()): Promise<"reset" | "invalid"> {
  if (!wellFormed(token)) return "invalid";
  const record = await db.passwordResetToken.findUnique({ where: { tokenHash: digest(token) }, select: { id: true, userId: true, expiresAt: true } });
  if (!record || record.expiresAt <= now) return "invalid";
  const passwordHash = await hash(password, 12);
  const user = await db.$transaction(async (transaction) => {
    // Consuming the token is the claim: of two concurrent uses, one wins.
    const consumed = await transaction.passwordResetToken.deleteMany({ where: { id: record.id, expiresAt: { gt: now } } });
    if (consumed.count === 0) return null;
    const updated = await transaction.user.update({
      where: { id: record.userId },
      data: { passwordHash, sessionVersion: { increment: 1 } },
      select: { username: true, email: true },
    });
    await transaction.passwordResetToken.deleteMany({ where: { userId: record.userId } });
    await transaction.session.deleteMany({ where: { userId: record.userId } });
    await transaction.trustedDevice.deleteMany({ where: { userId: record.userId } });
    await transaction.twoFactorChallenge.deleteMany({ where: { userId: record.userId } });
    await transaction.signInGrant.deleteMany({ where: { userId: record.userId } });
    return updated;
  });
  if (!user) return "invalid";
  // Failed guesses at the old password should not lock out the new one.
  await clearIdentityThrottle(user.username);
  if (user.email) await clearIdentityThrottle(user.email);
  return "reset";
}

function wellFormed(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
