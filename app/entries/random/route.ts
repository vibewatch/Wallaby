import { randomInt } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { auth } from "@/auth";
import { db } from "@/lib/db";

const views = new Set(["all", "unread", "archive", "starred", "annotated", "untagged"]);

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return redirectTo("/auth/signin");
  const query = new URL(request.url).searchParams;
  const view = views.has(query.get("view") ?? "") ? query.get("view")! : "all";
  const tag = query.get("tag")?.trim();
  const where: Prisma.EntryWhereInput = { userId: session.user.id };
  if (view === "unread") where.archived = false;
  if (view === "archive") where.archived = true;
  if (view === "starred") where.starred = true;
  if (view === "annotated") where.annotations = { some: {} };
  if (view === "untagged") where.tags = { none: {} };
  if (tag) where.tags = { some: { slug: tag } };
  const total = await db.entry.count({ where });
  if (!total) return redirectTo(`/entries?view=${view}`);
  const entry = await db.entry.findFirst({ where, orderBy: { id: "asc" }, skip: randomInt(total), select: { id: true } });
  return redirectTo(`/entries/${entry!.id}`);
}

function redirectTo(location: string): Response {
  return new Response(null, { status: 307, headers: { location } });
}
