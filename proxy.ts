import { NextResponse } from "next/server";

import { auth } from "@/auth";

export const proxy = auth((request) => {
  const publicPath =
    request.nextUrl.pathname === "/auth/signin" ||
    request.nextUrl.pathname === "/auth/two-factor" ||
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

export const config = {
  matcher: ["/((?!api/|auth/signin|auth/two-factor|share|media/|feed/|_next/static|_next/image|favicon.ico).*)"],
};
