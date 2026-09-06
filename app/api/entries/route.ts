import { randomBytes } from "node:crypto";

import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { authenticateApiRequest, unauthorized } from "@/lib/api-auth";
import { apiError, apiRequestObject } from "@/lib/api-response";
import { db } from "@/lib/db";
import { serializeEntry } from "@/lib/entry-serializer";
import { createEntryWithResult, parseTags, slugify } from "@/lib/entries";
import { getExtractor } from "@/lib/extractor";
import { pageNumber, positiveInteger } from "@/lib/pagination";

export async function GET(request: Request) {
  const userId = await authenticateApiRequest(request);
  if (!userId) return unauthorized();
  const params = new URL(request.url).searchParams;
  const perPage = Math.min(100, positiveInteger(params.get("perPage") ?? params.get("per_page") ?? params.get("limit"), 30));
  const page = pageNumber(params.get("page"), perPage);
  const where: Prisma.EntryWhereInput = { userId };
  if (params.has("archive")) where.archived = params.get("archive") === "1";
  if (params.has("starred")) where.starred = params.get("starred") === "1";
  if (params.has("public")) where.shareToken = params.get("public") === "1" ? { not: null } : null;
  const notParsed = params.get("notParsed") ?? params.get("not_parsed");
  if (notParsed !== null) where.isNotParsed = notParsed === "1";
  if (params.has("annotations")) where.annotations = params.get("annotations") === "1" ? { some: {} } : { none: {} };
  if (params.get("domain_name") ?? params.get("domain")) where.domainName = params.get("domain_name") ?? params.get("domain");
  if (params.get("http_status") && validHttpStatus(params.get("http_status")!)) where.httpStatus = Number(params.get("http_status"));
  const tagSlugs = parseTags(params.get("tags")).map(slugForApi);
  if (tagSlugs.length) where.AND = tagSlugs.map((slug) => ({ tags: { some: { slug } } }));
  const since = params.get("updated_since") ?? params.get("since");
  if (since) where.updatedAt = { gte: dateFromApi(since) };
  const sortAliases: Record<string, Prisma.EntryScalarFieldEnum> = { created: "createdAt", updated: "updatedAt", archived: "archivedAt", starred: "starredAt", published: "publishedAt" };
  const requestedSort = (params.get("sort") ?? "created").toLowerCase();
  const sort = sortAliases[requestedSort] ?? (["createdAt", "updatedAt", "publishedAt", "archivedAt", "starredAt"].includes(requestedSort) ? requestedSort as Prisma.EntryScalarFieldEnum : null);
  if (!sort) return apiError(400, "invalid_parameter", `Sort “${requestedSort}” is invalid`);
  const order = (params.get("order") ?? "desc").toLowerCase();
  if (order !== "asc" && order !== "desc") return apiError(400, "invalid_parameter", `Order “${order}” is invalid`);
  const detail = (params.get("detail") ?? "full").toLowerCase();
  if (detail !== "metadata" && detail !== "full") return apiError(400, "invalid_parameter", `Detail “${detail}” is invalid; allowed: full or metadata`);

  const [entries, total] = await Promise.all([
    db.entry.findMany({ where, include: { tags: true, annotations: true, user: { select: { id: true, name: true, username: true, email: true } } }, orderBy: { [sort]: order }, skip: (page - 1) * perPage, take: perPage }),
    db.entry.count({ where }),
  ]);
  const pages = Math.max(1, Math.ceil(total / perPage));
  return Response.json({
    page,
    limit: perPage,
    pages,
    total,
    _embedded: { items: entries.map((entry) => serializeEntry(entry, { detail })) },
    _links: {
      self: { href: pageLink(request, page, perPage) },
      first: { href: pageLink(request, 1, perPage) },
      last: { href: pageLink(request, pages, perPage) },
      ...(page > 1 ? { prev: { href: pageLink(request, page - 1, perPage) } } : {}),
      ...(page < pages ? { next: { href: pageLink(request, page + 1, perPage) } } : {}),
    },
  });
}

export async function POST(request: Request) {
  const userId = await authenticateApiRequest(request);
  if (!userId) return unauthorized();
  const body = await apiRequestObject(request);
  const parsed = z.object({
    url: z.string().min(1),
    title: z.string().optional(),
    content: z.string().optional(),
    tags: z.union([z.array(z.string()), z.string()]).optional(),
    archive: apiFlag.optional(),
    starred: apiFlag.optional(),
    public: apiFlag.optional(),
    language: z.string().max(50).optional(),
    preview_picture: z.string().url().max(2_000).optional(),
    published_at: z.union([z.string(), z.number()]).optional(),
    authors: z.union([z.string(), z.array(z.string())]).optional(),
    origin_url: z.string().url().max(2_000).optional(),
  }).safeParse(body);
  if (!parsed.success) return apiError(400, "invalid_entry", "The entry payload is invalid", parsed.error.issues);

  let normalizedUrl: string;
  try {
    const url = new URL(parsed.data.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    normalizedUrl = url.toString();
  } catch { return apiError(400, "invalid_url", `The url “${parsed.data.url}” is not a valid HTTP URL`); }

  const { entry: base, created } = await createEntryWithResult(userId, {
    url: normalizedUrl,
    title: parsed.data.title,
    content: parsed.data.content,
    tags: parseTags(parsed.data.tags),
    archived: parsed.data.archive,
    starred: parsed.data.starred,
    publishedAt: parseApiDate(parsed.data.published_at),
    publishedBy: parseAuthors(parsed.data.authors),
    originUrl: parsed.data.origin_url,
    previewPicture: parsed.data.preview_picture,
  });
  const labels = parseTags(parsed.data.tags);
  const content = !created && parsed.data.content ? getExtractor().cleanupHtml(parsed.data.content, normalizedUrl) : undefined;
  const archived = parsed.data.archive ?? base.archived;
  const starred = parsed.data.starred ?? base.starred;
  const entry = await db.entry.update({
    where: { id: base.id },
    data: {
      title: parsed.data.title?.trim() || undefined,
      content,
      language: parsed.data.language,
      previewPicture: created ? undefined : parsed.data.preview_picture,
      publishedAt: parseApiDate(parsed.data.published_at),
      publishedBy: parseAuthors(parsed.data.authors),
      originUrl: parsed.data.origin_url,
      archived,
      archivedAt: archived ? base.archivedAt ?? new Date() : null,
      starred,
      starredAt: starred ? base.starredAt ?? new Date() : null,
      shareToken: parsed.data.public === undefined ? undefined : parsed.data.public ? base.shareToken ?? randomBytes(24).toString("base64url") : null,
      sharedAt: parsed.data.public === undefined ? undefined : parsed.data.public ? base.sharedAt ?? new Date() : null,
      tags: labels.length ? { connectOrCreate: labels.map((label) => ({ where: { userId_slug: { userId, slug: slugify(label) } }, create: { userId, label, slug: slugify(label) } })) } : undefined,
    },
    include: { tags: true, annotations: true, user: { select: { id: true, name: true, username: true, email: true } } },
  });
  const compatibilityAlias = /\.(json|xml)$/.test(new URL(request.url).pathname);
  return Response.json(serializeEntry(entry), { status: compatibilityAlias ? 200 : 201 });
}

function dateFromApi(value: string): Date {
  return /^\d+$/.test(value) ? new Date(Number(value) * 1_000) : new Date(value);
}

function slugForApi(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
}

function validHttpStatus(value: string): boolean {
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599;
}

const apiFlag = z.union([z.boolean(), z.number(), z.string()]).transform((value, context) => {
  if (value === true || value === 1 || value === "1" || value === "true") return true;
  if (value === false || value === 0 || value === "0" || value === "false") return false;
  context.addIssue({ code: z.ZodIssueCode.custom, message: "Expected a boolean or 0/1" });
  return z.NEVER;
});

function pageLink(request: Request, page: number, perPage: number): string {
  const url = new URL(request.url);
  url.searchParams.set("page", String(page));
  url.searchParams.set("perPage", String(perPage));
  url.searchParams.delete("per_page");
  url.searchParams.delete("limit");
  return `${url.pathname}${url.search}`;
}

function parseApiDate(value: string | number | undefined): Date | undefined {
  if (value === undefined || value === "") return undefined;
  const date = typeof value === "number" || /^\d+$/.test(String(value)) ? new Date(Number(value) * 1_000) : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseAuthors(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const values = Array.isArray(value) ? value : value.split(",");
  return values.map((author) => author.trim()).filter(Boolean).slice(0, 100);
}
