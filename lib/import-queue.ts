import { createHash, randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";

import type { ImportJob, ImportJobItem, Prisma } from "@prisma/client";

import { db } from "@/lib/db";
import { createEntryWithResult, finalizeEntryCreation, hashUrl } from "@/lib/entries";
import { parseImport, type ImportSource, type NormalizedImportEntry } from "@/lib/importers";
import { decryptPocketToken, PocketClient, readPocketJobOptions } from "@/lib/pocket";

const itemConcurrency = 3;
const maximumJobAttempts = 5;
const maximumItemAttempts = 3;
const staleLockMs = 5 * 60 * 1_000;
const heartbeatIntervalMs = 30_000;

class ImportClaimLostError extends Error {
  constructor() {
    super("Import job claim is no longer owned by this worker");
    this.name = "ImportClaimLostError";
  }
}

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
  return db.importJob.create({
    data: {
      userId,
      source,
      status: "pending",
      total: entries.length,
      items: { createMany: { data: entries.map((entry, position) => ({ position, payload: encodeImportEntry(entry) })) } },
    },
  });
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
  return processClaimedImportJob(claimed, now);
}

export async function processImportJob(jobId: string, options: { workerId?: string; now?: Date } = {}): Promise<ImportWorkerResult | null> {
  const workerId = options.workerId ?? `worker-${process.pid}-${randomUUID()}`;
  const now = options.now ?? new Date();
  const claimed = await claimImportJob(jobId, workerId, now);
  if (!claimed) return null;
  return processClaimedImportJob(claimed, now);
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
    await wait(pollMs, undefined, { signal: options.signal }).catch((error: unknown) => {
      if (!options.signal?.aborted) throw error;
    });
  }
  return processed;
}

async function claimImportJob(jobId: string | undefined, workerId: string, now: Date): Promise<ImportJob | null> {
  const staleBefore = new Date(now.getTime() - staleLockMs);
  const exhausted = await db.importJob.findMany({
    where: {
      id: jobId,
      attempts: { gte: maximumJobAttempts },
      OR: [{ status: "pending" }, { status: "processing", lockedAt: { lte: staleBefore } }],
    },
  });
  for (const job of exhausted) {
    await db.$transaction(async (transaction) => {
      const claimId = `${workerId}:${randomUUID()}`;
      const claimed = await transaction.importJob.updateMany({
        where: { id: job.id, status: job.status, attempts: job.attempts, lockedAt: job.lockedAt, workerId: job.workerId },
        data: { status: "processing", lockedAt: now, heartbeatAt: now, workerId: claimId },
      });
      if (claimed.count !== 1) return;
      await reconcileImportJob({ ...job, status: "processing", workerId: claimId }, now, "Import worker retry limit reached", transaction);
    });
  }
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
    const claimId = `${workerId}:${randomUUID()}`;
    const claimed = await db.importJob.updateMany({
      where: { id: candidate.id, status: candidate.status, attempts: candidate.attempts, lockedAt: candidate.lockedAt, workerId: candidate.workerId },
      data: {
        status: "processing",
        attempts: { increment: 1 },
        lockedAt: now,
        heartbeatAt: now,
        workerId: claimId,
        startedAt: candidate.startedAt ?? now,
        error: null,
      },
    });
    if (claimed.count === 1) return db.importJob.findFirst({ where: { id: candidate.id, status: "processing", workerId: claimId } });
  }
  return null;
}

async function processClaimedImportJob(job: ImportJob, now: Date): Promise<ImportWorkerResult | null> {
  const heartbeat = startImportHeartbeat(job, now);
  try {
    if (job.source === "pocket-api") await hydratePocketImport(job);
    await db.importJobItem.updateMany({
      where: { jobId: job.id, status: { in: ["pending", "processing"] }, attempts: { gte: maximumItemAttempts }, job: jobClaimWhere(job) },
      data: { status: "failed", error: "Import item retry limit reached", lockedAt: null, workerId: null },
    });
    await db.importJobItem.updateMany({
      where: { jobId: job.id, status: "processing", job: jobClaimWhere(job) },
      data: { status: "pending", lockedAt: null, workerId: null },
    });
    const processingAt = new Date(Math.max(now.getTime(), Date.now()));
    const items = await db.importJobItem.findMany({
      where: { jobId: job.id, status: "pending", availableAt: { lte: processingAt } },
      orderBy: { position: "asc" },
    });
    const uniqueItems = await skipRepeatedPendingItems(job, items);
    await mapWithConcurrency(uniqueItems, itemConcurrency, (item) => {
      heartbeat.check();
      return processImportItem(job, item, processingAt);
    });
    await heartbeat.stop();
    heartbeat.check();
    return await reconcileImportJob(job, now);
  } catch (error) {
    await heartbeat.stop();
    if (error instanceof ImportClaimLostError) return null;
    const message = error instanceof Error ? error.message.slice(0, 2_000) : "Import worker failed";
    try {
      if (job.attempts >= maximumJobAttempts) return await reconcileImportJob(job, now, message);
      const updated = await db.$transaction((transaction) => updateClaimedJob(job, {
        status: "pending",
        error: message,
        availableAt: new Date(now.getTime() + retryDelayMs(job.attempts)),
        lockedAt: null,
        heartbeatAt: null,
        workerId: null,
      }, transaction));
      return summarizeJob(updated);
    } catch (retryError) {
      if (retryError instanceof ImportClaimLostError) return null;
      throw retryError;
    }
  } finally {
    await heartbeat.stop();
  }
}

function jobClaimWhere(job: ImportJob) {
  return { id: job.id, status: "processing", workerId: job.workerId, attempts: job.attempts };
}

async function renewImportClaim(job: ImportJob, now: Date, client: Prisma.TransactionClient = db): Promise<void> {
  const renewed = await client.importJob.updateMany({
    where: jobClaimWhere(job),
    data: { lockedAt: now, heartbeatAt: now },
  });
  if (renewed.count !== 1) throw new ImportClaimLostError();
}

async function updateClaimedJob(job: ImportJob, data: Prisma.ImportJobUpdateManyMutationInput, client: Prisma.TransactionClient): Promise<ImportJob> {
  const updated = await client.importJob.updateMany({ where: jobClaimWhere(job), data });
  if (updated.count !== 1) throw new ImportClaimLostError();
  return client.importJob.findUniqueOrThrow({ where: { id: job.id } });
}

async function updateClaimedItem(
  job: ImportJob,
  item: ImportJobItem,
  data: Prisma.ImportJobItemUpdateManyMutationInput,
  client: Prisma.TransactionClient = db,
): Promise<void> {
  const updated = await client.importJobItem.updateMany({
    where: { id: item.id, status: "processing", workerId: job.workerId, attempts: item.attempts + 1, job: jobClaimWhere(job) },
    data,
  });
  if (updated.count !== 1) throw new ImportClaimLostError();
}

function startImportHeartbeat(job: ImportJob, now: Date) {
  const started = Date.now();
  let inFlight: Promise<void> | undefined;
  let failure: { error: unknown } | undefined;
  const timer = setInterval(() => {
    if (inFlight || failure) return;
    const heartbeatAt = new Date(now.getTime() + Date.now() - started);
    inFlight = renewImportClaim(job, heartbeatAt).catch((error: unknown) => {
      failure = { error };
    }).finally(() => { inFlight = undefined; });
  }, heartbeatIntervalMs);
  return {
    check() { if (failure) throw failure.error; },
    async stop() {
      clearInterval(timer);
      await inFlight;
    },
  };
}

async function hydratePocketImport(job: ImportJob): Promise<void> {
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
    await db.$transaction(async (transaction) => {
      await updateClaimedJob(job, {
        total: { increment: pageItems.length },
        options: { ...options, offset: page.nextOffset, remoteComplete: complete },
        remoteCredential: complete ? null : job.remoteCredential,
        heartbeatAt: new Date(),
        lockedAt: new Date(),
      }, transaction);
      if (pageItems.length) await transaction.importJobItem.createMany({ data: pageItems });
    });
    position += pageItems.length;
    offset = page.nextOffset;
    if (complete) break;
  }
}

async function processImportItem(job: ImportJob, item: ImportJobItem, now: Date): Promise<void> {
  const claimed = await db.importJobItem.updateMany({
    where: { id: item.id, status: "pending", attempts: item.attempts, availableAt: { lte: now }, job: jobClaimWhere(job) },
    data: { status: "processing", attempts: { increment: 1 }, lockedAt: now, workerId: job.workerId, error: null },
  });
  if (claimed.count !== 1) throw new ImportClaimLostError();
  let importedEntryId = item.entryId;
  try {
    const entry = decodeImportEntry(item.payload);
    if (item.entryId) {
      const owned = await db.entry.findFirst({ where: { id: item.entryId, userId: job.userId }, select: { id: true } });
      if (!owned) throw new Error("The imported entry disappeared before the item completed");
      await finalizeEntryCreation(job.userId, owned.id, (transaction, entryId) => updateClaimedItem(job, item, { entryId }, transaction));
      await completeImportItem(job, item, owned.id, entry.annotations);
      return;
    }
    const existing = await db.entry.findUnique({ where: { userId_urlHash: { userId: job.userId, urlHash: hashUrl(entry.url) } }, select: { id: true } });
    if (existing) {
      await updateClaimedItem(job, item, { status: "skipped", entryId: existing.id, lockedAt: null, workerId: null });
      return;
    }
    const result = await createEntryWithResult(job.userId, entry, async (transaction, entryId) => {
      await updateClaimedItem(job, item, { entryId }, transaction);
      importedEntryId = entryId;
    });
    if (!result.created) {
      await updateClaimedItem(job, item, { status: "skipped", entryId: result.entry.id, lockedAt: null, workerId: null });
      return;
    }
    await completeImportItem(job, item, result.entry.id, entry.annotations);
  } catch (error) {
    if (error instanceof ImportClaimLostError) throw error;
    const entry = tryDecodeImportEntry(item.payload);
    const existing = entry && !importedEntryId ? await db.entry.findUnique({ where: { userId_urlHash: { userId: job.userId, urlHash: hashUrl(entry.url) } }, select: { id: true } }) : null;
    if (existing) {
      await updateClaimedItem(job, item, { status: "skipped", entryId: existing.id, error: null, lockedAt: null, workerId: null });
      return;
    }
    const attempts = item.attempts + 1;
    const message = error instanceof Error ? error.message.slice(0, 2_000) : "Entry import failed";
    await updateClaimedItem(job, item, attempts >= maximumItemAttempts
      ? { status: "failed", error: message, lockedAt: null, workerId: null }
      : { status: "pending", error: message, availableAt: new Date(now.getTime() + retryDelayMs(attempts)), lockedAt: null, workerId: null });
  }
}

async function completeImportItem(job: ImportJob, item: ImportJobItem, entryId: string, annotations: NormalizedImportEntry["annotations"]): Promise<void> {
  await db.$transaction(async (transaction) => {
    await updateClaimedItem(job, item, { entryId }, transaction);
    await persistAnnotations(transaction, job.userId, entryId, item.id, annotations);
    await updateClaimedItem(job, item, { status: "completed", entryId, error: null, lockedAt: null, workerId: null }, transaction);
  });
}

async function skipRepeatedPendingItems(job: ImportJob, items: ImportJobItem[]): Promise<ImportJobItem[]> {
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
    const skipped = await db.importJobItem.updateMany({
      where: { id: { in: repeated.map((item) => item.id) }, status: "pending", job: jobClaimWhere(job) },
      data: { status: "skipped", error: "Duplicate URL within this import", lockedAt: null, workerId: null },
    });
    if (skipped.count !== repeated.length) throw new ImportClaimLostError();
  }
  return unique;
}

async function persistAnnotations(client: Prisma.TransactionClient, userId: string, entryId: string, itemId: string, annotations: NormalizedImportEntry["annotations"]): Promise<void> {
  for (const [index, annotation] of annotations.entries()) {
    const id = `imp_${createHash("sha256").update(`${itemId}:${index}`).digest("hex").slice(0, 28)}`;
    await client.annotation.upsert({
      where: { id },
      create: { id, userId, entryId, ...annotation },
      update: { text: annotation.text, quote: annotation.quote, ranges: annotation.ranges },
    });
  }
}

async function reconcileImportJob(
  job: ImportJob,
  now: Date,
  failure?: string,
  client?: Prisma.TransactionClient,
): Promise<ImportWorkerResult> {
  if (!client) return db.$transaction((transaction) => reconcileImportJob(job, now, failure, transaction));
  await renewImportClaim(job, now, client);
  const jobId = job.id;
  if (failure || job.attempts >= maximumJobAttempts) {
    await client.importJobItem.updateMany({
      where: { jobId, status: { in: ["pending", "processing"] }, job: jobClaimWhere(job) },
      data: { status: "failed", error: failure ?? "Import worker retry limit reached", lockedAt: null, workerId: null },
    });
  }
  const grouped = await client.importJobItem.groupBy({ by: ["status"], where: { jobId }, _count: { _all: true } });
  const counts = new Map(grouped.map((group) => [group.status, group._count._all]));
  const imported = counts.get("completed") ?? 0;
  const skipped = counts.get("skipped") ?? 0;
  const failed = counts.get("failed") ?? 0;
  const remaining = (counts.get("pending") ?? 0) + (counts.get("processing") ?? 0);
  if (remaining) {
    const next = await client.importJobItem.aggregate({ where: { jobId, status: "pending" }, _min: { availableAt: true } });
    const updated = await updateClaimedJob(job, {
      status: "pending",
      imported,
      skipped,
      failed,
      error: failed ? `${failed} entries exhausted their retry limit` : skipped ? `${skipped} duplicate entries skipped` : null,
      availableAt: next._min.availableAt ?? now,
      lockedAt: null,
      heartbeatAt: null,
      workerId: null,
    }, client);
    return summarizeJob(updated);
  }
  const status = failure || imported + skipped === 0 && failed > 0 ? "failed" : "completed";
  const updated = await updateClaimedJob(job, {
    status,
    imported,
    skipped,
    failed,
    error: failure ?? ([skipped ? `${skipped} duplicate entries skipped` : "", failed ? `${failed} entries failed` : ""].filter(Boolean).join("; ") || null),
    completedAt: now,
    lockedAt: null,
    heartbeatAt: null,
    workerId: null,
    remoteCredential: null,
  }, client);
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
  let failure: { error: unknown } | undefined;
  async function worker() {
    while (!failure && index < values.length) {
      const current = index++;
      try { await task(values[current]); }
      catch (error) { failure ??= { error }; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  if (failure) throw failure.error;
}
