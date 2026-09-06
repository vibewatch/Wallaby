import type { Prisma } from "@prisma/client";

export const advancedFilterNames = ["minRead", "maxRead", "createdFrom", "createdTo", "publishedFrom", "publishedTo", "domain", "language", "httpStatus", "notParsed", "hasPreview", "hasAnnotations", "isShared"] as const;

const views = new Set(["unread", "starred", "archive", "all", "annotated", "untagged", "same-domain"]);

type FilterSource = URLSearchParams | Record<string, string | string[] | undefined>;

export type EntryFilters = {
  view: string;
  query: string;
  tag: string;
  sourceEntryId: string;
  minRead: number | null;
  maxRead: number | null;
  createdFrom: Date | null;
  createdTo: Date | null;
  publishedFrom: Date | null;
  publishedTo: Date | null;
  domain: string;
  language: string;
  httpStatus: number | null;
  notParsed: boolean;
  hasPreview: boolean;
  hasAnnotations: boolean;
  isShared: boolean;
};

export function parseEntryFilters(source: FilterSource, defaultView = "unread"): EntryFilters {
  const requestedView = stringValue(source, "view");
  return {
    view: views.has(requestedView) ? requestedView : defaultView,
    query: stringValue(source, "q").slice(0, 500),
    tag: stringValue(source, "tag").slice(0, 200),
    sourceEntryId: stringValue(source, "entry").slice(0, 200),
    minRead: optionalNumber(source, "minRead", 0, 10_000),
    maxRead: optionalNumber(source, "maxRead", 0, 10_000),
    createdFrom: optionalDate(source, "createdFrom", false),
    createdTo: optionalDate(source, "createdTo", true),
    publishedFrom: optionalDate(source, "publishedFrom", false),
    publishedTo: optionalDate(source, "publishedTo", true),
    domain: stringValue(source, "domain").slice(0, 253),
    language: stringValue(source, "language").slice(0, 35),
    httpStatus: optionalNumber(source, "httpStatus", 100, 599),
    notParsed: stringValue(source, "notParsed") === "1",
    hasPreview: stringValue(source, "hasPreview") === "1",
    hasAnnotations: stringValue(source, "hasAnnotations") === "1",
    isShared: stringValue(source, "isShared") === "1",
  };
}

/**
 * `matchedIds` carries the result of a full-text search. When it is present the
 * text query is already answered — ranked and deduplicated — so the predicate
 * only has to restrict to that set. When it is `null` the search layer had no
 * index to use and the portable substring conditions apply instead.
 */
export function entryWhere(userId: string, filters: EntryFilters, readingSpeed: number, sameDomain: string | null, matchedIds: string[] | null = null): Prisma.EntryWhereInput {
  const where: Prisma.EntryWhereInput = { userId };
  if (filters.view === "unread") where.archived = false;
  if (filters.view === "archive") where.archived = true;
  if (filters.view === "starred") where.starred = true;
  if (filters.view === "annotated") where.annotations = { some: {} };
  if (filters.view === "untagged") where.tags = { none: {} };
  if (filters.view === "same-domain") where.domainName = sameDomain ?? "__wallaby_missing_domain__";
  // Cards round up to whole minutes and always display at least one minute.
  if (filters.minRead !== null || filters.maxRead !== null) where.readingTime = {
    gte: filters.minRead === null ? undefined : filters.minRead <= 1 ? 0 : Math.floor((Math.ceil(filters.minRead) - 1) * readingSpeed / 200) + 1,
    lte: filters.maxRead === null ? undefined : filters.maxRead < 1 ? -1 : Math.floor(Math.floor(filters.maxRead) * readingSpeed / 200),
  };
  if (filters.createdFrom || filters.createdTo) where.createdAt = { gte: filters.createdFrom ?? undefined, lte: filters.createdTo ?? undefined };
  if (filters.publishedFrom || filters.publishedTo) where.publishedAt = { gte: filters.publishedFrom ?? undefined, lte: filters.publishedTo ?? undefined };
  if (filters.domain) where.AND = [{ domainName: { contains: filters.domain } }];
  if (filters.language) where.language = filters.language;
  if (filters.httpStatus !== null) where.httpStatus = filters.httpStatus;
  if (filters.notParsed) where.isNotParsed = true;
  if (filters.hasPreview) where.previewPicture = { not: null };
  if (filters.hasAnnotations) where.annotations = { some: {} };
  if (filters.isShared) where.shareToken = { not: null };
  if (filters.tag) where.tags = { ...where.tags, some: { slug: filters.tag } };
  if (filters.query) {
    if (matchedIds) where.id = { in: matchedIds };
    else where.OR = [
      { title: { contains: filters.query } },
      { content: { contains: filters.query } },
      { domainName: { contains: filters.query } },
      { tags: { some: { label: { contains: filters.query } } } },
    ];
  }
  return where;
}

function stringValue(source: FilterSource, name: string): string {
  const value = source instanceof URLSearchParams ? source.get(name) : source[name];
  return typeof value === "string" ? value.trim() : "";
}

function optionalNumber(source: FilterSource, name: string, minimum: number, maximum: number): number | null {
  const text = stringValue(source, name);
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) && number >= minimum && number <= maximum ? number : null;
}

function optionalDate(source: FilterSource, name: string, endOfDay: boolean): Date | null {
  const text = stringValue(source, name);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text ? date : null;
}
