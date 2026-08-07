import { NextResponse } from "next/server";

import { auth } from "@/auth";

export const proxy = auth((request) => {
  const publicPath =
    request.nextUrl.pathname === "/auth/signin" ||
    request.nextUrl.pathname === "/auth/two-factor" ||
    isInstallAsset(request.nextUrl.pathname) ||
    request.nextUrl.pathname.startsWith("/share/") ||
    request.nextUrl.pathname.startsWith("/media/") ||
    request.nextUrl.pathname.startsWith("/feed/") ||
    request.nextUrl.pathname.startsWith("/api/");
  if (!request.auth && !publicPath) {
    const signIn = new URL("/auth/signin", request.nextUrl.origin);
    signIn.searchParams.set("callbackUrl", request.nextUrl.pathname);
    return NextResponse.redirect(signIn);
  }
  return NextResponse.next();
});

/**
 * Browsers fetch the web app manifest, its icons, and the service worker
 * without credentials, so redirecting them to sign-in would silently make the
 * app un-installable. The offline shell must render while signed out too.
 * None of these carry user data.
 */
function isInstallAsset(pathname: string): boolean {
  return pathname === "/manifest.webmanifest"
    || pathname === "/apple-icon.png"
    || pathname === "/sw.js"
    || pathname === "/offline"
    || /^\/icon[-.]/.test(pathname);
}

export const config = {
  matcher: ["/((?!api/|auth/signin|auth/two-factor|share|media/|feed/|_next/static|_next/image|favicon.ico|manifest.webmanifest|apple-icon.png|sw.js|offline|icon[-.]).*)"],
};
