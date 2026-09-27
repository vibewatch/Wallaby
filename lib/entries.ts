import { createHash, randomBytes } from "node:crypto";

import type { Prisma } from "@prisma/client";
import type { Content } from "@wallaby/extractor";

import { localizeEntryImages } from "@/lib/article-images";
import { db } from "@/lib/db";
import { parseEntryUrl } from "@/lib/entry-url";
import { getExtractor } from "@/lib/extractor";
import { resolveEntryRedirect } from "@/lib/ignore-origin";
import { findSiteCredential } from "@/lib/site-credentials";
import { parseTags, stripHtml } from "@/lib/text";
import { applyTaggingRules } from "@/lib/rules";

export { parseTags, stripHtml } from "@/lib/text";

export type EntryInput = {
  url: string;
  title?: string | null;
  /** A caller-supplied title that yields to the extracted one, e.g. the bookmarked tab's title. */
  fallbackTitle?: string | null;
  content?: string | null;
  tags?: string[];
  archived?: boolean;
  starred?: boolean;
  createdAt?: Date;
  publishedAt?: Date;
  originUrl?: string;
  previewPicture?: string;
  publishedBy?: string[];
};

type EntryPublicationGuard = (transaction: Prisma.TransactionClient, entryId: string) => Promise<void>;

export function hashUrl(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

export function slugify(value: string): string {
  return value
    .normalize("NFKD")
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

/** Labels made only of symbols slugify to nothing; hash them so they stay distinct. */
export function tagSlug(label: string): string {
  return slugify(label) || hashUrl(label).slice(0, 12);
}

export function connectTags(userId: string, labels: string[]): Prisma.TagCreateOrConnectWithoutEntriesInput[] {
  return labels.map((label) => ({
    where: { userId_slug: { userId, slug: tagSlug(label) } },
    create: { userId, label, slug: tagSlug(label) },
  }));
}

export async function createEntry(userId: string, input: EntryInput) {
  return (await createEntryWithResult(userId, input)).entry;
}

export async function createEntryWithResult(
  userId: string,
  input: EntryInput,
  beforePublish?: EntryPublicationGuard,
) {
  const normalized = parseEntryUrl(input.url);
  const givenUrl = normalized.toString();
  const existing = await db.entry.findUnique({
    where: { userId_urlHash: { userId, urlHash: hashUrl(givenUrl) } },
    include: { tags: true, annotations: true },
  });
  if (existing) return { entry: existing, created: false as const };

  let extracted: Content | undefined;
  let extractionError: string | null = null;
  try {
    const credential = input.content ? undefined : await findSiteCredential(userId, normalized.hostname);
    extracted = await getExtractor().fetchContent(normalized, input.content ?? undefined, credential);
  } catch (error) {
    extractionError = error instanceof Error ? error.message : "Unknown extraction error";
  }

  const effectiveUrl = extracted?.url ?? givenUrl;
  const resolvedUrl = await resolveEntryRedirect(userId, givenUrl, effectiveUrl, input.originUrl ?? null);
  const domainName = new URL(resolvedUrl.url).hostname;
  const plainText = stripHtml(extracted?.html ?? input.content ?? "");
  const title = input.title?.trim() || extracted?.title || input.fallbackTitle?.trim() || normalized.pathname.split("/").filter(Boolean).at(-1) || domainName;
  const tagConnections = connectTags(userId, parseTags(input.tags));

  const persist = (client: Prisma.TransactionClient) => client.entry.create({
    data: {
      userId,
      uid: randomBytes(12).toString("base64url").slice(0, 23),
      title: title.slice(0, 1_000),
      url: resolvedUrl.url,
      givenUrl,
      originUrl: resolvedUrl.originUrl,
      urlHash: hashUrl(givenUrl),
      content: extracted?.html ?? input.content ?? "",
      summary: extracted?.summary || excerpt(plainText),
      archived: Boolean(input.archived),
      archivedAt: input.archived ? new Date() : null,
      starred: Boolean(input.starred),
      starredAt: input.starred ? new Date() : null,
      publishedAt: extracted?.date ? new Date(extracted.date) : input.publishedAt ?? null,
      publishedBy: extracted?.authors?.length ? extracted.authors : input.publishedBy ?? [],
      mimeType: extracted?.mimeType,
      language: extracted?.language,
      readingTime: readingTime(plainText),
      domainName,
      previewPicture: extracted?.image ?? input.previewPicture,
      httpStatus: extracted?.status,
      headers: extracted?.headers,
      isNotParsed: extracted?.isNotParsed ?? true,
      extractionError,
      createdAt: input.createdAt,
      tags: { connectOrCreate: tagConnections },
    },
    include: { tags: true, annotations: true },
  });
  // An import's provenance must commit with its entry, before any post-save work.
  const created = beforePublish
    ? await db.$transaction(async (transaction) => {
        const entry = await persist(transaction);
        await beforePublish(transaction, entry.id);
        return entry;
      })
    : await persist(db);
  await finalizeEntryCreation(userId, created.id, beforePublish);
  return { entry: await db.entry.findUniqueOrThrow({ where: { id: created.id }, include: { tags: true, annotations: true } }), created: true as const };
}

export async function finalizeEntryCreation(userId: string, entryId: string, beforePublish?: EntryPublicationGuard): Promise<void> {
  try { await localizeEntryImages(entryId, { beforePublish }); }
  catch (error) {
    if (beforePublish) throw error;
    console.warn(JSON.stringify({
      level: "warn",
      event: "entry.image_capture.failed",
      service: "wallaby",
      errorType: error instanceof Error ? error.name : "UnknownError",
      timestamp: new Date().toISOString(),
    }));
  }
  if (beforePublish) {
    await db.$transaction(async (transaction) => {
      await beforePublish(transaction, entryId);
      await applyTaggingRules(userId, entryId, transaction);
    });
  } else await applyTaggingRules(userId, entryId);
}

/** Labels for tag autocomplete, most used first. */
export async function tagSuggestions(userId: string): Promise<string[]> {
  const tags = await db.tag.findMany({ where: { userId }, select: { label: true }, orderBy: [{ entries: { _count: "desc" } }, { label: "asc" }], take: 1_000 });
  return tags.map(({ label }) => label);
}

export class EntryNotFoundError extends Error {
  constructor() {
    super("Entry not found");
    this.name = "EntryNotFoundError";
  }
}

export async function reloadEntry(userId: string, entryId: string) {
  const entry = await db.entry.findFirst({ where: { id: entryId, userId } });
  if (!entry) throw new EntryNotFoundError();
  const url = new URL(entry.givenUrl);
  const credential = await findSiteCredential(userId, url.hostname);
  const extracted = await getExtractor().fetchContent(url, undefined, credential);
  const plainText = stripHtml(extracted.html);
  const resolvedUrl = await resolveEntryRedirect(userId, entry.url, extracted.url, entry.originUrl);
  await db.entry.update({
    where: { id: entry.id },
    data: {
      title: extracted.title || entry.title,
      url: resolvedUrl.url,
      originUrl: resolvedUrl.originUrl,
      content: extracted.html,
      summary: extracted.summary || excerpt(plainText),
      publishedAt: extracted.date ? new Date(extracted.date) : entry.publishedAt,
      publishedBy: extracted.authors,
      mimeType: extracted.mimeType,
      language: extracted.language,
      readingTime: readingTime(plainText),
      domainName: new URL(resolvedUrl.url).hostname,
      previewPicture: extracted.image,
      httpStatus: extracted.status,
      headers: extracted.headers,
      isNotParsed: extracted.isNotParsed,
      extractionError: null,
    },
    include: { tags: true, annotations: true },
  });
  try { return await localizeEntryImages(entry.id); }
  catch { return db.entry.findUniqueOrThrow({ where: { id: entry.id }, include: { tags: true, annotations: true } }); }
}

export function readingTime(text: string, wordsPerMinute = 200): number {
  const words = text.match(/[\p{L}\p{N}]+/gu)?.length ?? 0;
  return words ? Math.max(1, Math.ceil(words / wordsPerMinute)) : 0;
}

function excerpt(value: string, length = 250): string {
  if (value.length <= length) return value;
  return `${value.slice(0, length).replace(/\s+\S*$/, "")} …`;
}
