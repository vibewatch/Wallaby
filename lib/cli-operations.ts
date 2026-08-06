import type { User } from "@prisma/client";

import { deleteEntriesWithMedia } from "@/lib/article-images";
import { db } from "@/lib/db";
import { createEntryWithResult, parseTags, reloadEntry } from "@/lib/entries";
import { renderExport, type TextExportFormat } from "@/lib/exports";
import { enqueueImportFile, processImportJob, type ImportWorkerResult } from "@/lib/import-queue";
import type { ImportSource } from "@/lib/importers";

type UserIdentity = Pick<User, "id" | "username" | "email">;

export async function findCliUser(identifier: string, useUserId = false): Promise<UserIdentity> {
  const value = identifier.trim();
  if (!value) throw new Error("A username, email address, or user ID is required");
  const user = useUserId
    ? await db.user.findUnique({ where: { id: value }, select: { id: true, username: true, email: true } })
    : await db.user.findFirst({ where: { OR: [{ username: value }, { email: value.toLowerCase() }] }, select: { id: true, username: true, email: true } });
  if (!user) throw new Error(`No Wallaby user matches “${value}”`);
  return user;
}

export function cliImporterSource(value: string): ImportSource {
  const normalized = value.trim().toLowerCase().replaceAll("_", "-");
  if (["v1", "v2", "wallabag"].includes(normalized)) return "wallabag";
  if (["firefox", "chrome", "browser"].includes(normalized)) return "browser";
  if (["pocket", "pocket-csv", "pocket-html"].includes(normalized)) return "pocket";
  if (["delicious", "pinboard"].includes(normalized)) return "pinboard";
  if (["instapaper", "readability", "shaarli", "omnivore", "elcurator", "auto"].includes(normalized)) return normalized as ImportSource;
  throw new Error(`Unsupported importer “${value}”`);
}

export async function importLibrary(input: {
  userId: string;
  source: ImportSource;
  filename: string;
  contents: string;
  markAsRead?: boolean;
  disableContentUpdate?: boolean;
  queueOnly?: boolean;
}): Promise<ImportWorkerResult> {
  const job = await enqueueImportFile(input.userId, input.source, input.filename, input.contents);
  if (input.markAsRead || input.disableContentUpdate) {
    const items = await db.importJobItem.findMany({ where: { jobId: job.id }, select: { id: true, payload: true } });
    await db.$transaction(items.map((item) => {
      if (!item.payload || typeof item.payload !== "object" || Array.isArray(item.payload)) throw new Error("Import item payload is invalid");
      return db.importJobItem.update({
        where: { id: item.id },
        data: { payload: {
          ...item.payload,
          ...(input.markAsRead ? { archived: true } : {}),
          ...(input.disableContentUpdate && typeof item.payload.content !== "string" ? { content: "<p></p>" } : {}),
        } },
      });
    }));
  }
  if (input.queueOnly) return { id: job.id, status: job.status, total: job.total, imported: 0, skipped: 0, failed: 0 };
  const processed = await processImportJob(job.id);
  if (!processed) throw new Error("The newly queued import could not be claimed");
  return processed;
}

export async function importSingleUrl(input: { userId: string; url: string; tags?: string; markAsRead?: boolean }) {
  return createEntryWithResult(input.userId, { url: input.url, tags: parseTags(input.tags), archived: input.markAsRead });
}

export async function exportLibrary(userId: string, format: TextExportFormat = "json"): Promise<string> {
  const entries = await db.entry.findMany({ where: { userId }, include: { tags: true, annotations: true }, orderBy: { createdAt: "desc" } });
  return renderExport(entries, format).body;
}

export async function reloadLibraries(input: {
  userId?: string;
  onlyNotParsed?: boolean;
  reloader?: (userId: string, entryId: string) => Promise<unknown>;
} = {}): Promise<{ total: number; reloaded: number; failed: number }> {
  const entries = await db.entry.findMany({
    where: { userId: input.userId, ...(input.onlyNotParsed ? { isNotParsed: true } : {}) },
    select: { id: true, userId: true },
    orderBy: { createdAt: "asc" },
  });
  const reloader = input.reloader ?? reloadEntry;
  let reloaded = 0;
  let failed = 0;
  for (const entry of entries) {
    try { await reloader(entry.userId, entry.id); reloaded += 1; }
    catch { failed += 1; }
  }
  return { total: entries.length, reloaded, failed };
}

export async function cleanDuplicateEntries(userId?: string): Promise<{ users: number; duplicates: number }> {
  const users = await db.user.findMany({ where: { id: userId }, select: { id: true } });
  let duplicates = 0;
  for (const user of users) {
    const entries = await db.entry.findMany({
      where: { userId: user.id },
      include: { tags: { select: { id: true } } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    const survivors = new Map<string, typeof entries[number]>();
    for (const entry of entries) {
      const key = comparableUrl(entry.url);
      const survivor = survivors.get(key);
      if (!survivor) { survivors.set(key, entry); continue; }
      const archived = survivor.archived || entry.archived;
      const archivedAt = survivor.archivedAt ?? entry.archivedAt;
      const starred = survivor.starred || entry.starred;
      const starredAt = survivor.starredAt ?? entry.starredAt;
      await db.$transaction([
        db.annotation.updateMany({ where: { entryId: entry.id, userId: user.id }, data: { entryId: survivor.id } }),
        db.entry.update({
          where: { id: survivor.id },
          data: {
            archived,
            archivedAt,
            starred,
            starredAt,
            tags: { connect: entry.tags.map(({ id }) => ({ id })) },
          },
        }),
      ]);
      await deleteEntriesWithMedia(user.id, { id: entry.id });
      Object.assign(survivor, { archived, archivedAt, starred, starredAt });
      duplicates += 1;
    }
  }
  return { users: users.length, duplicates };
}

function comparableUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString();
}
