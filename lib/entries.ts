import { createHash, randomBytes } from "node:crypto";

import type { Prisma } from "@prisma/client";
import type { Content } from "@wallaby/extractor";

import { localizeEntryImages } from "@/lib/article-images";
import { db } from "@/lib/db";
import { getExtractor } from "@/lib/extractor";
import { resolveEntryRedirect } from "@/lib/ignore-origin";
import { findSiteCredential } from "@/lib/site-credentials";
import { parseTags, stripHtml } from "@/lib/text";
import { applyTaggingRules } from "@/lib/rules";

export { parseTags, stripHtml } from "@/lib/text";

export type EntryInput = {
  url: string;
  title?: string | null;
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

export async function createEntry(userId: string, input: EntryInput) {
  return (await createEntryWithResult(userId, input)).entry;
}

export async function createEntryWithResult(
  userId: string,
  input: EntryInput,
  onCreate?: (transaction: Prisma.TransactionClient, entryId: string) => Promise<void>,
) {
  const normalized = new URL(input.url.match(/^https?:\/\//i) ? input.url : `https://${input.url}`);
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
  const title = input.title?.trim() || extracted?.title || normalized.pathname.split("/").filter(Boolean).at(-1) || domainName;
  const tags = parseTags(input.tags);
  const tagConnections: Prisma.TagCreateOrConnectWithoutEntriesInput[] = tags.map((label) => ({
    where: { userId_slug: { userId, slug: slugify(label) || hashUrl(label).slice(0, 12) } },
    create: { userId, label, slug: slugify(label) || hashUrl(label).slice(0, 12) },
  }));

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
  const created = onCreate
    ? await db.$transaction(async (transaction) => {
        const entry = await persist(transaction);
        await onCreate(transaction, entry.id);
        return entry;
      })
    : await persist(db);
  try { await localizeEntryImages(created.id); }
  catch { /* Image capture is best-effort; the sanitized remote references remain readable. */ }
  await applyTaggingRules(userId, created.id);
  return { entry: await db.entry.findUniqueOrThrow({ where: { id: created.id }, include: { tags: true, annotations: true } }), created: true as const };
}

export async function reloadEntry(userId: string, entryId: string) {
  const entry = await db.entry.findFirst({ where: { id: entryId, userId } });
  if (!entry) throw new Error("Entry not found");
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
