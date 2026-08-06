import type { User } from "@prisma/client";
import { compare } from "bcryptjs";

import { checkAuthThrottle, clearIdentityThrottle, recordAuthFailure } from "@/lib/auth-throttle";
import { db } from "@/lib/db";

type HeaderSource = { get(name: string): string | null } | undefined;
type PasswordVerification =
  | { status: "authenticated"; user: User }
  | { status: "invalid" | "limited" };

const dummyPasswordHash = "$2b$12$.nbEhCr3rkKmnHJ2u55HDuXi.bxzrKCzVU5qj5mm5dIlw/nobpD6.";

export async function verifyPasswordCredentials(identifier: string, password: string, headers?: HeaderSource): Promise<PasswordVerification> {
  const normalized = identifier.normalize("NFKC").trim();
  if ((await checkAuthThrottle(normalized, headers)).limited) return { status: "limited" };
  const bounded = normalized.length > 0 && normalized.length <= 320 && password.length > 0 && password.length <= 200;
  const user = bounded
    ? await db.user.findFirst({ where: { OR: [{ username: normalized }, { email: normalized.toLowerCase() }] } })
    : null;
  const valid = await compare(password.slice(0, 200), user?.passwordHash ?? dummyPasswordHash);
  if (!bounded || !user?.passwordHash || !valid) {
    const failure = await recordAuthFailure(normalized, headers);
    return { status: failure.limited ? "limited" : "invalid" };
  }
  await clearIdentityThrottle(normalized);
  return { status: "authenticated", user };
}
