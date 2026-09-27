import { db } from "@/lib/db";

/**
 * Deletes rows that can no longer be used: expired sign-in, two-factor, reset,
 * OAuth, and Pocket credentials, stale throttle counters, and the per-item
 * payloads of imports that finished long ago. Job summaries are kept, so the
 * import history stays visible. Every rule only removes records that the app
 * already rejects, so pruning never changes behaviour; it only bounds growth.
 */

const throttleRetentionMs = 24 * 60 * 60 * 1_000;
const defaultImportRetentionDays = 30;

export type PruneCounts = Record<string, number>;

type Rule = { count: () => Promise<number>; remove: () => Promise<{ count: number }> };

export async function pruneExpiredRecords({ now = new Date(), dryRun = false, importRetentionDays = defaultImportRetentionDays }: { now?: Date; dryRun?: boolean; importRetentionDays?: number } = {}): Promise<PruneCounts> {
  const expires = { expires: { lt: now } };
  const expiresAt = { expiresAt: { lt: now } };
  const throttles = { updatedAt: { lt: new Date(now.getTime() - throttleRetentionMs) }, OR: [{ blockedUntil: null }, { blockedUntil: { lt: now } }] };
  const importItems = { job: { status: { in: ["completed", "failed"] }, completedAt: { lt: new Date(now.getTime() - importRetentionDays * 24 * 60 * 60 * 1_000) } } };
  const rules: Record<string, Rule> = {
    sessions: { count: () => db.session.count({ where: expires }), remove: () => db.session.deleteMany({ where: expires }) },
    verificationTokens: { count: () => db.verificationToken.count({ where: expires }), remove: () => db.verificationToken.deleteMany({ where: expires }) },
    signInGrants: { count: () => db.signInGrant.count({ where: expiresAt }), remove: () => db.signInGrant.deleteMany({ where: expiresAt }) },
    twoFactorChallenges: { count: () => db.twoFactorChallenge.count({ where: expiresAt }), remove: () => db.twoFactorChallenge.deleteMany({ where: expiresAt }) },
    twoFactorSetups: { count: () => db.twoFactorSetup.count({ where: expiresAt }), remove: () => db.twoFactorSetup.deleteMany({ where: expiresAt }) },
    trustedDevices: { count: () => db.trustedDevice.count({ where: expiresAt }), remove: () => db.trustedDevice.deleteMany({ where: expiresAt }) },
    passwordResetTokens: { count: () => db.passwordResetToken.count({ where: expiresAt }), remove: () => db.passwordResetToken.deleteMany({ where: expiresAt }) },
    oauthAuthorizationCodes: { count: () => db.oAuthAuthorizationCode.count({ where: expiresAt }), remove: () => db.oAuthAuthorizationCode.deleteMany({ where: expiresAt }) },
    oauthAccessTokens: { count: () => db.oAuthAccessToken.count({ where: expiresAt }), remove: () => db.oAuthAccessToken.deleteMany({ where: expiresAt }) },
    oauthRefreshTokens: { count: () => db.oAuthRefreshToken.count({ where: expiresAt }), remove: () => db.oAuthRefreshToken.deleteMany({ where: expiresAt }) },
    pocketAuthorizations: { count: () => db.pocketAuthorization.count({ where: expiresAt }), remove: () => db.pocketAuthorization.deleteMany({ where: expiresAt }) },
    authThrottles: { count: () => db.authThrottle.count({ where: throttles }), remove: () => db.authThrottle.deleteMany({ where: throttles }) },
    importItems: { count: () => db.importJobItem.count({ where: importItems }), remove: () => db.importJobItem.deleteMany({ where: importItems }) },
  };
  const counts: PruneCounts = {};
  for (const [name, rule] of Object.entries(rules)) {
    counts[name] = dryRun ? await rule.count() : (await rule.remove()).count;
  }
  return counts;
}
