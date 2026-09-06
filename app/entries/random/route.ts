import { randomInt } from "node:crypto";

import { auth } from "@/auth";
import { db } from "@/lib/db";
import { parseEntryFilters } from "@/lib/entry-filters";
import { resolveEntryQuery } from "@/lib/search";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user?.id) return redirectTo("/auth/signin");
  const userId = session.user.id;
  const query = new URL(request.url).searchParams;
  const filters = parseEntryFilters(query, "all");
  const [preference, sourceEntry] = await Promise.all([
    db.userPreference.findUnique({ where: { userId }, select: { readingSpeed: true } }),
    filters.view === "same-domain" && filters.sourceEntryId
      ? db.entry.findFirst({ where: { id: filters.sourceEntryId, userId }, select: { domainName: true } })
      : null,
  ]);
  const { where } = await resolveEntryQuery(userId, filters, {
    readingSpeed: preference?.readingSpeed,
    sameDomain: sourceEntry?.domainName,
  });
  query.set("view", filters.view);
  query.delete("page");
  const libraryUrl = `/entries?${query}`;
  const total = await db.entry.count({ where });
  if (!total) return redirectTo(libraryUrl);
  const entry = await db.entry.findFirst({ where, orderBy: { id: "asc" }, skip: randomInt(total), select: { id: true } });
  return redirectTo(entry ? `/entries/${entry.id}` : libraryUrl);
}

function redirectTo(location: string): Response {
  return new Response(null, { status: 307, headers: { location } });
}
