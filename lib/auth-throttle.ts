import { createHash } from "node:crypto";
import { isIP } from "node:net";

import { db } from "@/lib/db";

type HeaderSource = { get(name: string): string | null } | undefined;
type ThrottleKey = { key: string; maximum: number };

const windowMs = 15 * 60 * 1_000;
const blockMs = 15 * 60 * 1_000;
const retentionMs = 24 * 60 * 60 * 1_000;

export type AuthThrottleDecision = { limited: boolean; retryAfterSeconds: number };

export async function checkAuthThrottle(identifier: string, headers?: HeaderSource, now = new Date()): Promise<AuthThrottleDecision> {
  const rules = throttleKeys(identifier, headers);
  const records = await db.authThrottle.findMany({ where: { key: { in: rules.map(({ key }) => key) } } });
  const blockedUntil = records.reduce<Date | null>((latest, record) => {
    if (!record.blockedUntil || record.blockedUntil <= now) return latest;
    return !latest || record.blockedUntil > latest ? record.blockedUntil : latest;
  }, null);
  return blockedUntil
    ? { limited: true, retryAfterSeconds: Math.max(1, Math.ceil((blockedUntil.getTime() - now.getTime()) / 1_000)) }
    : { limited: false, retryAfterSeconds: 0 };
}

export async function recordAuthFailure(identifier: string, headers?: HeaderSource, now = new Date()): Promise<AuthThrottleDecision> {
  const rules = throttleKeys(identifier, headers);
  const latestBlock = await db.$transaction(async (transaction) => {
    let transactionBlock: Date | null = null;
    await transaction.authThrottle.deleteMany({ where: { updatedAt: { lt: new Date(now.getTime() - retentionMs) } } });
    for (const rule of rules) {
      const current = await transaction.authThrottle.findUnique({ where: { key: rule.key } });
      const expired = !current || current.windowStartedAt <= new Date(now.getTime() - windowMs) || Boolean(current.blockedUntil && current.blockedUntil <= now);
      const failures = expired ? 1 : current.failures + 1;
      const blockedUntil = failures >= rule.maximum ? new Date(now.getTime() + blockMs) : null;
      await transaction.authThrottle.upsert({
        where: { key: rule.key },
        create: { key: rule.key, failures, windowStartedAt: now, blockedUntil },
        update: { failures, windowStartedAt: expired ? now : current.windowStartedAt, blockedUntil },
      });
      if (blockedUntil && (!transactionBlock || blockedUntil > transactionBlock)) transactionBlock = blockedUntil;
    }
    return transactionBlock;
  });
  return latestBlock
    ? { limited: true, retryAfterSeconds: Math.max(1, Math.ceil((latestBlock.getTime() - now.getTime()) / 1_000)) }
    : { limited: false, retryAfterSeconds: 0 };
}

export async function clearIdentityThrottle(identifier: string): Promise<void> {
  await db.authThrottle.deleteMany({ where: { key: identityThrottleKey(identifier) } });
}

export function identityThrottleKey(identifier: string): string {
  return `identity:${digest(identifier.normalize("NFKC").trim().toLowerCase().slice(0, 320))}`;
}

export function clientAddress(headers?: HeaderSource): string | null {
  const forwarded = headers?.get("x-forwarded-for")?.split(",", 1)[0].trim();
  const candidate = forwarded || headers?.get("x-real-ip")?.trim();
  return candidate && isIP(candidate) ? candidate : null;
}

function throttleKeys(identifier: string, headers?: HeaderSource): ThrottleKey[] {
  const keys: ThrottleKey[] = [{ key: identityThrottleKey(identifier), maximum: 8 }];
  const address = clientAddress(headers);
  if (address) keys.push({ key: `address:${digest(address)}`, maximum: 40 });
  return keys;
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
