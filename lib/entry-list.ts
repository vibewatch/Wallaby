import { db } from "@/lib/db";
import { advancedFilterNames, parseEntryFilters } from "@/lib/entry-filters";
import { entriesBeyond, entryOrderBy, parseEntrySort } from "@/lib/entry-sort";
import { resolveEntryQuery } from "@/lib/search";

/**
 * An entry opened from the library remembers which list it came from, as that
 * list's query string in `?list=`. The reader uses it to return to the same
 * page of the same results and to step to the neighbouring entries. Only
 * library parameters survive, and the value is only ever used as a query on
 * `/entries`, so it cannot redirect anywhere else.
 */

const listKeys = new Set<string>(["view", "q", "tag", "entry", "sort", "page", ...advancedFilterNames]);
const MAX_LIST_LENGTH = 2_000;

type Params = Record<string, string | string[] | undefined>;

export function listQuery(params: Params | URLSearchParams): string {
  const query = new URLSearchParams();
  const entries = params instanceof URLSearchParams ? params.entries() : Object.entries(params);
  for (const [key, value] of entries) {
    if (listKeys.has(key) && typeof value === "string" && value.trim()) query.set(key, value.trim().slice(0, 500));
  }
  const text = query.toString();
  return text.length <= MAX_LIST_LENGTH ? text : "";
}

export function readListParam(value: string | string[] | undefined): string {
  return typeof value === "string" && value.length <= MAX_LIST_LENGTH * 3 ? listQuery(new URLSearchParams(value)) : "";
}

export function libraryHref(list: string): string {
  return list ? `/entries?${list}` : "/entries";
}

export function entryHref(entryId: string, list: string): string {
  return list ? `/entries/${entryId}?list=${encodeURIComponent(list)}` : `/entries/${entryId}`;
}

export const afterArchiveChoices = ["stay", "next", "list"] as const;
export type AfterArchive = (typeof afterArchiveChoices)[number];

export function parseAfterArchive(value: string | null | undefined): AfterArchive {
  return (afterArchiveChoices as readonly string[]).includes(value ?? "") ? value as AfterArchive : "stay";
}

type Neighbour = { id: string; title: string };
type CurrentEntry = { id: string; createdAt: Date; title: string; readingTime: number; publishedAt: Date | null };

export async function findListNeighbours(userId: string, list: string, current: CurrentEntry, readingSpeed: number): Promise<{ previous: Neighbour | null; next: Neighbour | null }> {
  const params = new URLSearchParams(list);
  const filters = parseEntryFilters(params);
  const sort = parseEntrySort(params.get("sort"), Boolean(filters.query));
  const sameDomain = filters.view === "same-domain" && filters.sourceEntryId
    ? (await db.entry.findFirst({ where: { id: filters.sourceEntryId, userId }, select: { domainName: true } }))?.domainName
    : null;
  const { where, ranked } = await resolveEntryQuery(userId, filters, { readingSpeed, sameDomain });
  const select = { id: true, title: true };

  if (sort === "relevance" && ranked) {
    // Relevance has no column to seek on; step through the ranked ids instead.
    const index = ranked.indexOf(current.id);
    if (index === -1) return { previous: null, next: null };
    const [previous, next] = await Promise.all([
      index > 0 ? db.entry.findFirst({ where: { AND: [where, { id: ranked[index - 1] }] }, select }) : null,
      index + 1 < ranked.length ? db.entry.findFirst({ where: { AND: [where, { id: ranked[index + 1] }] }, select }) : null,
    ]);
    return { previous, next };
  }

  const [previous, next] = await Promise.all([
    db.entry.findFirst({ where: { AND: [where, entriesBeyond(sort, current, "before")] }, orderBy: entryOrderBy(sort, true), select }),
    db.entry.findFirst({ where: { AND: [where, entriesBeyond(sort, current, "after")] }, orderBy: entryOrderBy(sort), select }),
  ]);
  return { previous, next };
}
