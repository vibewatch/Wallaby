import type { Prisma } from "@prisma/client";

type SortField = "createdAt" | "title" | "readingTime" | "publishedAt" | "id";
/** A nullable key always sorts its missing values after every present one. */
type SortKey = { field: SortField; direction: "asc" | "desc"; nullable?: boolean };
type SortValues = { id: string; createdAt: Date; title: string; readingTime: number; publishedAt: Date | null };

/**
 * Library orderings. Every ordering ends on `id` so pages never overlap or
 * skip entries that share a timestamp, title, or reading time, and so the
 * reader can step to exactly one neighbour.
 */
const orderings = {
  newest: { label: "Newest first", keys: [{ field: "createdAt", direction: "desc" }, { field: "id", direction: "desc" }] },
  oldest: { label: "Oldest first", keys: [{ field: "createdAt", direction: "asc" }, { field: "id", direction: "asc" }] },
  title: { label: "Title A–Z", keys: [{ field: "title", direction: "asc" }, { field: "id", direction: "asc" }] },
  shortest: { label: "Shortest read", keys: [{ field: "readingTime", direction: "asc" }, { field: "createdAt", direction: "desc" }, { field: "id", direction: "desc" }] },
  longest: { label: "Longest read", keys: [{ field: "readingTime", direction: "desc" }, { field: "createdAt", direction: "desc" }, { field: "id", direction: "desc" }] },
  published: { label: "Recently published", keys: [{ field: "publishedAt", direction: "desc", nullable: true }, { field: "createdAt", direction: "desc" }, { field: "id", direction: "desc" }] },
} satisfies Record<string, { label: string; keys: SortKey[] }>;

export type EntryOrdering = keyof typeof orderings;
/** `relevance` exists only while searching and falls back to newest without an index. */
export type EntrySort = EntryOrdering | "relevance";

export const entrySortOptions = Object.entries(orderings).map(([value, { label }]) => ({ value: value as EntryOrdering, label }));

export function parseEntrySort(value: string | string[] | null | undefined, searching: boolean): EntrySort {
  const requested = typeof value === "string" ? value : "";
  if (requested === "relevance" && searching) return "relevance";
  if (Object.hasOwn(orderings, requested)) return requested as EntryOrdering;
  return searching ? "relevance" : "newest";
}

export function entrySortLabel(sort: EntrySort): string {
  return sort === "relevance" ? "Most relevant first" : orderings[sort].label;
}

function sortKeys(sort: EntrySort): SortKey[] {
  return orderings[sort === "relevance" ? "newest" : sort].keys;
}

export function entryOrderBy(sort: EntrySort, reverse = false): Prisma.EntryOrderByWithRelationInput[] {
  return sortKeys(sort).map(({ field, direction, nullable }) => {
    const effective = reverse ? flip(direction) : direction;
    return { [field]: nullable ? { sort: effective, nulls: reverse ? "first" : "last" } : effective };
  });
}

/**
 * Entries strictly after (or before) `current` in this ordering, as a keyset
 * predicate. `current` need not match the list's filters, so stepping on from
 * an entry that was just archived out of Unread still lands on its neighbour.
 */
export function entriesBeyond(sort: EntrySort, current: SortValues, side: "after" | "before"): Prisma.EntryWhereInput {
  const keys = sortKeys(sort);
  const branches: Prisma.EntryWhereInput[] = [];
  keys.forEach((key, index) => {
    const beyond = beyondKey(key, current[key.field], side);
    if (!beyond) return;
    const ties = keys.slice(0, index).map((earlier) => ({ [earlier.field]: current[earlier.field] }));
    branches.push({ AND: [...ties, beyond] });
  });
  return { OR: branches };
}

function beyondKey({ field, direction, nullable }: SortKey, value: SortValues[SortField], side: "after" | "before"): Prisma.EntryWhereInput | null {
  const operator = (direction === "asc") === (side === "after") ? "gt" : "lt";
  if (value === null) {
    // Missing values come last: nothing follows them, every present value precedes them.
    return side === "after" ? null : { [field]: { not: null } };
  }
  const compared = { [field]: { [operator]: value } };
  return nullable && side === "after" ? { OR: [compared, { [field]: null }] } : compared;
}

function flip(direction: "asc" | "desc"): "asc" | "desc" {
  return direction === "asc" ? "desc" : "asc";
}
