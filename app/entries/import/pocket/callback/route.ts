import { NextResponse } from "next/server";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { enqueuePocketImport } from "@/lib/import-queue";
import { decryptPocketToken, encryptPocketToken, PocketClient } from "@/lib/pocket";

export async function GET(request: Request) {
  const user = (await auth())?.user;
  const destination = new URL("/entries/import", request.url);
  if (!user?.id) {
    const signIn = new URL("/auth/signin", request.url);
    signIn.searchParams.set("callbackUrl", "/entries/import/pocket/callback");
    return NextResponse.redirect(signIn);
  }
  const authorization = await db.pocketAuthorization.findUnique({ where: { userId: user.id } });
  const preference = await db.userPreference.findUnique({ where: { userId: user.id }, select: { pocketConsumerKey: true } });
  if (!authorization || authorization.expiresAt <= new Date() || !preference?.pocketConsumerKey) {
    if (authorization) await db.pocketAuthorization.deleteMany({ where: { id: authorization.id, userId: user.id } });
    destination.searchParams.set("pocket", "expired");
    return NextResponse.redirect(destination);
  }
  await db.pocketAuthorization.deleteMany({ where: { id: authorization.id, userId: user.id } });
  try {
    const requestToken = decryptPocketToken(authorization.encryptedRequestToken);
    const granted = await new PocketClient({ consumerKey: preference.pocketConsumerKey }).authorize(requestToken);
    await enqueuePocketImport(user.id, encryptPocketToken(granted.accessToken), preference.pocketConsumerKey, authorization.markAsRead);
    destination.searchParams.set("pocket", "queued");
  } catch {
    destination.searchParams.set("pocket", "failed");
  }
  return NextResponse.redirect(destination);
}
