import { createHash } from "node:crypto";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { authenticateOAuthAccessToken } from "@/lib/oauth";
import { apiError } from "@/lib/api-response";

export async function authenticateApiRequest(request: Request): Promise<string | null> {
  const session = await auth();
  if (session?.user?.id) return session.user.id;

  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return null;
  const rawToken = authorization.slice(7).trim();
  const oauthUserId = await authenticateOAuthAccessToken(rawToken);
  if (oauthUserId) return oauthUserId;
  const hash = createHash("sha256").update(rawToken).digest("hex");
  const token = await db.apiToken.findUnique({ where: { tokenHash: hash } });
  if (!token || (token.expiresAt && token.expiresAt < new Date())) return null;
  await db.apiToken.update({ where: { id: token.id }, data: { lastUsedAt: new Date() } });
  return token.userId;
}

export function unauthorized() {
  return apiError(401, "access_denied", "OAuth2 authentication required");
}
