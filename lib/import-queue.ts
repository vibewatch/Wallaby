import { createHash, randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";

import type { ImportJob, ImportJobItem, Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { createEntryWithResult, hashUrl } from "@/lib/entries";
import { parseImport, type ImportSource, type NormalizedImportEntry } from "@/lib/importers";
import { decryptPocketToken, PocketClient, readPocketJobOptions } from "@/lib/pocket";

const itemConcurrency = 3;
const maximumJobAttempts = 5;
const maximumItemAttempts = 3;
const staleLockMs = 5 * 60 * 1_000;

export type ImportWorkerResult = {
  id: string;
  status: string;
  total: number;
  imported: number;
  skipped: number;
  failed: number;
};

export async function enqueueImportFile(userId: string, source: ImportSource, filename: string, input: string): Promise<ImportJob> {
  return enqueueNormalizedImport(userId, source, parseImport(source, filename, input));
}

export async function enqueueNormalizedImport(userId: string, source: string, entries: NormalizedImportEntry[]): Promise<ImportJob> {
  if (!entries.length) throw new Error("No importable entries were provided");
  if (entries.length > 5_000) throw new Error("A single import is limited to 5,000 entries");
  const job = await db.importJob.create({ data: { userId, source, status: "pending", total: entries.length } });
  try {
    await db.importJobItem.createMany({ data: entries.map((entry, position) => ({ jobId: job.id, position, payload: encodeImportEntry(entry) })) });
  } catch (error) {
    await db.importJob.deleteMany({ where: { id: job.id } });
    throw error;
  }
  return job;
}

export async function enqueuePocketImport(userId: string, encryptedAccessToken: string, consumerKey: string, markAsRead: boolean): Promise<ImportJob> {
  return db.importJob.create({
    data: {
      userId,
      source: "pocket-api",
      status: "pending",
      remoteCredential: encryptedAccessToken,
      options: { consumerKey, markAsRead, offset: 0, remoteComplete: false },
    },
  });
}

export async function processNextImportJob(options: { workerId?: string; now?: Date } = {}): Promise<ImportWorkerResult | null> {
  const workerId = options.workerId ?? `worker-${process.pid}-${randomUUID()}`;
  const now = options.now ?? new Date();
  const claimed = await claimImportJob(undefined, workerId, now);
  if (!claimed) return null;
  return processClaimedImportJob(claimed, workerId, now);
}

export async function processImportJob(jobId: string, options: { workerId?: string; now?: Date } = {}): Promise<ImportWorkerResult | null> {
  const workerId = options.workerId ?? `worker-${process.pid}-${randomUUID()}`;
  const now = options.now ?? new Date();
  const claimed = await claimImportJob(jobId, workerId, now);
  if (!claimed) return null;
  return processClaimedImportJob(claimed, workerId, now);
}

export async function runImportWorker(options: {
  once?: boolean;
  maxJobs?: number;
  pollMs?: number;
  workerId?: string;
  signal?: AbortSignal;
} = {}): Promise<number> {
  const workerId = options.workerId ?? `worker-${process.pid}-${randomUUID()}`;
  const maxJobs = options.maxJobs ?? (options.once ? 1 : Number.POSITIVE_INFINITY);
  const pollMs = Math.max(100, Math.min(options.pollMs ?? 2_000, 60_000));
  let processed = 0;
  while (!options.signal?.aborted && processed < maxJobs) {
    const job = await processNextImportJob({ workerId });
    if (job) {
      processed += 1;
      continue;
    }
    if (options.once) break;
    await wait(pollMs, undefined, { signal: options.signal }).catch(() => undefined);
  }
  return processed;
}

async function claimImportJob(jobId: string | undefined, workerId: string, now: Date): Promise<ImportJob | null> {
  const staleBefore = new Date(now.getTime() - staleLockMs);
  await db.importJob.updateMany({
    where: { status: "processing", attempts: { gte: maximumJobAttempts }, lockedAt: { lte: staleBefore } },
    data: { status: "failed", error: "Import worker retry limit reached", completedAt: now, lockedAt: null, heartbeatAt: null, workerId: null },
  });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = await db.importJob.findFirst({
      where: {
        id: jobId,
        attempts: { lt: maximumJobAttempts },
        OR: [
          { status: "pending", availableAt: { lte: now } },
          { status: "processing", lockedAt: { lte: staleBefore } },
        ],
      },
      orderBy: [{ availableAt: "asc" }, { createdAt: "asc" }],
    });
    if (!candidate) return null;
    const claimed = await db.importJob.updateMany({
      where: { id: candidate.id, status: candidate.status, attempts: candidate.attempts, lockedAt: candidate.lockedAt },
      data: {
        status: "processing",
        attempts: { increment: 1 },
        lockedAt: now,
        heartbeatAt: now,
        workerId,
        startedAt: candidate.startedAt ?? now,
        error: null,
      },
    });
    if (claimed.count === 1) return db.importJob.findUniqueOrThrow({ where: { id: candidate.id } });
  }
  return null;
}

async function processClaimedImportJob(job: ImportJob, workerId: string, now: Date): Promise<ImportWorkerResult> {
  try {
    if (job.source === "pocket-api") await hydratePocketImport(job, workerId);
    await db.importJobItem.updateMany({ where: { jobId: job.id, status: "processing" }, data: { status: "pending", lockedAt: null, workerId: null } });
    const items = await db.importJobItem.findMany({
      where: { jobId: job.id, status: "pending", availableAt: { lte: now } },
      orderBy: { position: "asc" },
    });
    const uniqueItems = await skipRepeatedPendingItems(items);
    await mapWithConcurrency(uniqueItems, itemConcurrency, (item) => processImportItem(job, item, workerId, now));
    return reconcileImportJob(job.id, now);
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 2_000) : "Import worker failed";
    const terminal = job.attempts >= maximumJobAttempts;
    const updated = await db.importJob.update({
      where: { id: job.id },
      data: terminal
        ? { status: "failed", error: message, completedAt: now, lockedAt: null, heartbeatAt: null, workerId: null }
        : { status: "pending", error: message, availableAt: new Date(now.getTime() + retryDelayMs(job.attempts)), lockedAt: null, heartbeatAt: null, workerId: null },
    });
    return summarizeJob(updated);
  }
}

async function hydratePocketImport(job: ImportJob, workerId: string): Promise<void> {
  const options = readPocketJobOptions(job.options);
  if (options.remoteComplete) return;
  if (!job.remoteCredential) throw new Error("Pocket access token is unavailable");
  const client = new PocketClient({ consumerKey: options.consumerKey, accessToken: decryptPocketToken(job.remoteCredential) });
  let position = job.total;
  let offset = options.offset;
  for await (const page of client.retrievePages(offset, options.markAsRead)) {
    if (position + page.entries.length > 5_000) throw new Error("Pocket API imports are limited to 5,000 entries per job");
    const pageItems = page.entries.map((entry, index) => ({ jobId: job.id, position: position + index, payload: encodeImportEntry(entry) }));
    const complete = page.done;
    await db.$transaction([
      ...(pageItems.length ? [db.importJobItem.createMany({ data: pageItems })] : []),
      db.importJob.update({
        where: { id: job.id },
        data: {
          total: { increment: pageItems.length },
          options: { ...options, offset: page.nextOffset, remoteComplete: complete },
          remoteCredential: complete ? null : job.remoteCredential,
          heartbeatAt: new Date(),
          lockedAt: new Date(),
          workerId,
        },
      }),
    ]);
    position += pageItems.length;
    offset = page.nextOffset;
    if (complete) break;
  }
}

async function processImportItem(job: ImportJob, item: ImportJobItem, workerId: string, now: Date): Promise<void> {
  const claimed = await db.importJobItem.updateMany({
    where: { id: item.id, status: "pending", attempts: item.attempts, availableAt: { lte: now } },
    data: { status: "processing", attempts: { increment: 1 }, lockedAt: now, workerId, error: null },
  });
  if (claimed.count !== 1) return;
  try {
    const entry = decodeImportEntry(item.payload);
    if (item.entryId) {
      const owned = await db.entry.findFirst({ where: { id: item.entryId, userId: job.userId }, select: { id: true } });
      if (!owned) throw new Error("The imported entry disappeared before the item completed");
      await persistAnnotations(job.userId, owned.id, item.id, entry.annotations);
      await completeImportItem(item.id, owned.id);
      return;
    }
    const existing = await db.entry.findUnique({ where: { userId_urlHash: { userId: job.userId, urlHash: hashUrl(entry.url) } }, select: { id: true } });
    if (existing) {
      await db.importJobItem.update({ where: { id: item.id }, data: { status: "skipped", entryId: existing.id, lockedAt: null, workerId: null } });
      return;
    }
    const result = await createEntryWithResult(job.userId, entry);
    if (!result.created) {
      await db.importJobItem.update({ where: { id: item.id }, data: { status: "skipped", entryId: result.entry.id, lockedAt: null, workerId: null } });
      return;
    }
    await db.importJobItem.update({ where: { id: item.id }, data: { entryId: result.entry.id } });
    await persistAnnotations(job.userId, result.entry.id, item.id, entry.annotations);
    await completeImportItem(item.id, result.entry.id);
  } catch (error) {
    const entry = tryDecodeImportEntry(item.payload);
    const existing = entry ? await db.entry.findUnique({ where: { userId_urlHash: { userId: job.userId, urlHash: hashUrl(entry.url) } }, select: { id: true } }).catch(() => null) : null;
    if (existing && !item.entryId) {
      await db.importJobItem.update({ where: { id: item.id }, data: { status: "skipped", entryId: existing.id, error: null, lockedAt: null, workerId: null } });
      return;
    }
    const attempts = item.attempts + 1;
    const message = error instanceof Error ? error.message.slice(0, 2_000) : "Entry import failed";
    await db.importJobItem.update({
      where: { id: item.id },
      data: attempts >= maximumItemAttempts
        ? { status: "failed", error: message, lockedAt: null, workerId: null }
        : { status: "pending", error: message, availableAt: new Date(now.getTime() + retryDelayMs(attempts)), lockedAt: null, workerId: null },
    });
  }
}

async function completeImportItem(itemId: string, entryId: string): Promise<void> {
  await db.importJobItem.update({ where: { id: itemId }, data: { status: "completed", entryId, error: null, lockedAt: null, workerId: null } });
}

async function skipRepeatedPendingItems(items: ImportJobItem[]): Promise<ImportJobItem[]> {
  const seen = new Set<string>();
  const unique: ImportJobItem[] = [];
  const repeated: ImportJobItem[] = [];
  for (const item of items) {
    const entry = tryDecodeImportEntry(item.payload);
    const key = entry ? hashUrl(entry.url) : `invalid:${item.id}`;
    if (seen.has(key)) repeated.push(item);
    else { seen.add(key); unique.push(item); }
  }
  if (repeated.length) {
    await db.importJobItem.updateMany({
      where: { id: { in: repeated.map((item) => item.id) }, status: "pending" },
      data: { status: "skipped", error: "Duplicate URL within this import", lockedAt: null, workerId: null },
    });
  }
  return unique;
}

async function persistAnnotations(userId: string, entryId: string, itemId: string, annotations: NormalizedImportEntry["annotations"]): Promise<void> {
  for (const [index, annotation] of annotations.entries()) {
    const id = `imp_${createHash("sha256").update(`${itemId}:${index}`).digest("hex").slice(0, 28)}`;
    await db.annotation.upsert({
      where: { id },
      create: { id, userId, entryId, ...annotation },
      update: { text: annotation.text, quote: annotation.quote, ranges: annotation.ranges },
    });
  }
}

async function reconcileImportJob(jobId: string, now: Date): Promise<ImportWorkerResult> {
  const grouped = await db.importJobItem.groupBy({ by: ["status"], where: { jobId }, _count: { _all: true } });
  const counts = new Map(grouped.map((group) => [group.status, group._count._all]));
  const imported = counts.get("completed") ?? 0;
  const skipped = counts.get("skipped") ?? 0;
  const failed = counts.get("failed") ?? 0;
  const remaining = (counts.get("pending") ?? 0) + (counts.get("processing") ?? 0);
  if (remaining) {
    const next = await db.importJobItem.aggregate({ where: { jobId, status: "pending" }, _min: { availableAt: true } });
    const updated = await db.importJob.update({
      where: { id: jobId },
      data: {
        status: "pending",
        imported,
        skipped,
        failed,
        error: failed ? `${failed} entries exhausted their retry limit` : skipped ? `${skipped} duplicate entries skipped` : null,
        availableAt: next._min.availableAt ?? now,
        lockedAt: null,
        heartbeatAt: null,
        workerId: null,
      },
    });
    return summarizeJob(updated);
  }
  const status = imported + skipped === 0 && failed > 0 ? "failed" : "completed";
  const updated = await db.importJob.update({
    where: { id: jobId },
    data: {
      status,
      imported,
      skipped,
      failed,
      error: [skipped ? `${skipped} duplicate entries skipped` : "", failed ? `${failed} entries failed` : ""].filter(Boolean).join("; ") || null,
      completedAt: now,
      lockedAt: null,
      heartbeatAt: null,
      workerId: null,
      remoteCredential: null,
    },
  });
  return summarizeJob(updated);
}

function encodeImportEntry(entry: NormalizedImportEntry): Prisma.InputJsonValue {
  return {
    ...entry,
    createdAt: entry.createdAt?.toISOString() ?? null,
    publishedAt: entry.publishedAt?.toISOString() ?? null,
    originUrl: entry.originUrl ?? null,
    title: entry.title ?? null,
    content: entry.content ?? null,
  };
}

function decodeImportEntry(payload: Prisma.JsonValue): NormalizedImportEntry {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Import item payload is invalid");
  const candidate = payload as Record<string, Prisma.JsonValue>;
  if (typeof candidate.url !== "string") throw new Error("Import item URL is missing");
  const url = new URL(candidate.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Import item URL is invalid");
  if (!Array.isArray(candidate.tags) || !Array.isArray(candidate.publishedBy) || !Array.isArray(candidate.annotations)) throw new Error("Import item collections are invalid");
  return {
    url: url.toString(),
    title: typeof candidate.title === "string" ? candidate.title : undefined,
    content: typeof candidate.content === "string" ? candidate.content : undefined,
    tags: candidate.tags.filter((value): value is string => typeof value === "string"),
    archived: candidate.archived === true,
    starred: candidate.starred === true,
    createdAt: parseStoredDate(candidate.createdAt),
    publishedAt: parseStoredDate(candidate.publishedAt),
    originUrl: typeof candidate.originUrl === "string" ? candidate.originUrl : undefined,
    previewPicture: typeof candidate.previewPicture === "string" ? candidate.previewPicture : undefined,
    publishedBy: candidate.publishedBy.filter((value): value is string => typeof value === "string"),
    annotations: candidate.annotations.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const annotation = value as Record<string, Prisma.JsonValue>;
      if (typeof annotation.text !== "string" || typeof annotation.quote !== "string" || !Array.isArray(annotation.ranges)) return [];
      const ranges = annotation.ranges.flatMap((rangeValue) => {
        if (!rangeValue || typeof rangeValue !== "object" || Array.isArray(rangeValue)) return [];
        const range = rangeValue as Record<string, Prisma.JsonValue>;
        return typeof range.start === "string" && typeof range.end === "string" && typeof range.startOffset === "number" && typeof range.endOffset === "number"
          ? [{ start: range.start, startOffset: range.startOffset, end: range.end, endOffset: range.endOffset }]
          : [];
      });
      return [{ text: annotation.text, quote: annotation.quote, ranges }];
    }),
  };
}

function tryDecodeImportEntry(payload: Prisma.JsonValue): NormalizedImportEntry | null {
  try { return decodeImportEntry(payload); }
  catch { return null; }
}

function parseStoredDate(value: Prisma.JsonValue | undefined): Date | undefined {
  if (typeof value !== "string") return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function retryDelayMs(attempt: number): number {
  return Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1));
}

function summarizeJob(job: ImportJob): ImportWorkerResult {
  return { id: job.id, status: job.status, total: job.total, imported: job.imported, skipped: job.skipped, failed: job.failed };
}

async function mapWithConcurrency<T>(values: T[], concurrency: number, task: (value: T) => Promise<void>): Promise<void> {
  let index = 0;
  async function worker() {
    while (index < values.length) {
      const current = index++;
      await task(values[current]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
}
