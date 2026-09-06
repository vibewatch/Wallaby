import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { NormalizedImportEntry } from "./importers";
import { encryptPocketToken } from "./pocket";

const execute = promisify(execFile);
const originalDatabaseUrl = process.env.DATABASE_URL;
let directory: string;
let databaseUrl: string;
let userId: string;
let queue: typeof import("./import-queue");
let dbModule: typeof import("./db");
let cli: typeof import("./cli-operations");

beforeAll(async () => {
  directory = join(".test-runs", `import-queue-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  databaseUrl = `file:${resolve(directory, "queue.db")}`;
  process.env.DATABASE_URL = databaseUrl;
  await execute(join(process.cwd(), "node_modules/.bin/prisma"), ["migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  dbModule = await import("./db");
  queue = await import("./import-queue");
  cli = await import("./cli-operations");
  const user = await dbModule.db.user.create({ data: { username: `queue-${Date.now()}`, preference: { create: {} } } });
  userId = user.id;
}, 30_000);

beforeEach(() => {
  vi.stubGlobal("fetch", async () => new Response("<article><p>Isolated import fixture.</p></article>", { headers: { "content-type": "text/html" } }));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

afterAll(async () => {
  await dbModule?.db.$disconnect();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (directory) await rm(directory, { recursive: true, force: true });
});

describe("operator command operations", () => {
  it("applies CLI flags before a concurrent worker can import the file", async () => {
    const fetch = vi.fn(async () => new Response("<article><p>Fetched content.</p></article>", { headers: { "content-type": "text/html" } }));
    vi.stubGlobal("fetch", fetch);
    const create = dbModule.db.importJob.create.bind(dbModule.db.importJob);
    vi.spyOn(dbModule.db.importJob, "create").mockImplementationOnce((async (args) => {
      const job = await create(args);
      await queue.processImportJob(job.id, { workerId: "cli-observer" });
      return job;
    }) as typeof dbModule.db.importJob.create);
    const url = `https://93.184.216.34/cli-publication-${randomUUID()}`;

    const result = await cli.importLibrary({
      userId,
      source: "wallabag",
      filename: "cli.json",
      contents: JSON.stringify([{ url, title: "CLI flags" }]),
      markAsRead: true,
      disableContentUpdate: true,
    });

    expect(result).toMatchObject({ status: "completed", imported: 1 });
    expect(await dbModule.db.entry.findUnique({ where: { userId_urlHash: { userId, urlHash: createUrlHash(url) } }, select: { archived: true } }))
      .toEqual({ archived: true });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("maps upstream importer names and synchronously processes a marked-read file", async () => {
    expect(cli.cliImporterSource("v2")).toBe("wallabag");
    expect(cli.cliImporterSource("pocket_csv")).toBe("pocket");
    expect(cli.cliImporterSource("firefox")).toBe("browser");
    const url = `https://example.com/cli-import-${Date.now()}`;
    const result = await cli.importLibrary({
      userId,
      source: "wallabag",
      filename: "cli.json",
      contents: JSON.stringify([{ url, title: "CLI import" }]),
      markAsRead: true,
      disableContentUpdate: true,
    });
    expect(result).toMatchObject({ status: "completed", imported: 1 });
    expect(await dbModule.db.entry.findUnique({ where: { userId_urlHash: { userId, urlHash: createUrlHash(url) } }, select: { archived: true } }))
      .toEqual({ archived: true });
  });

  it("imports Pocket HTML through the CLI alias without losing state, dates, or tags", async () => {
    const baseUrl = `https://example.com/pocket-cli-${randomUUID()}`;
    const result = await cli.importLibrary({
      userId,
      source: cli.cliImporterSource("pocket-html"),
      filename: "pocket.html",
      contents: `<!DOCTYPE html><html><head><title>Pocket Export</title></head><body>
        <h1>Unread</h1><ul><li><a href="${baseUrl}/unread" time_added="1700000000" tags="research">Unread from Pocket</a></li></ul>
        <h1>Read Archive</h1><ul><li><a href="${baseUrl}/archived" time_added="1700000010" tags="reference">Archived from Pocket</a></li></ul>
      </body></html>`,
      disableContentUpdate: true,
    });

    expect(result).toMatchObject({ status: "completed", total: 2, imported: 2, skipped: 0, failed: 0 });
    const exported = JSON.parse(await cli.exportLibrary(userId)) as { url: string }[];
    expect(exported.find(({ url }) => url === `${baseUrl}/unread`)).toMatchObject({
      title: "Unread from Pocket", is_archived: 0, created_at: "2023-11-14T22:13:20.000Z", tags: [{ label: "research" }],
    });
    expect(exported.find(({ url }) => url === `${baseUrl}/archived`)).toMatchObject({
      title: "Archived from Pocket", is_archived: 1, created_at: "2023-11-14T22:13:30.000Z", tags: [{ label: "reference" }],
    });
  });

  it("exports through the production serializer and filters reload candidates", async () => {
    const url = `https://example.com/cli-export-${Date.now()}`;
    const imported = await cli.importSingleUrl({ userId, url, tags: "command,portable" });
    await dbModule.db.entry.update({ where: { id: imported.entry.id }, data: { isNotParsed: true } });
    const exported = JSON.parse(await cli.exportLibrary(userId)) as { id: string; tags: { label: string }[] }[];
    expect(exported.find((entry) => entry.id === imported.entry.id)?.tags.map((tag) => tag.label).sort()).toEqual(["command", "portable"]);

    const visited: string[] = [];
    const reloaded = await cli.reloadLibraries({ userId, onlyNotParsed: true, reloader: async (_owner, entryId) => { visited.push(entryId); } });
    expect(reloaded.reloaded).toBe(visited.length);
    expect(visited).toContain(imported.entry.id);
  });

  it("merges trailing-slash duplicates without losing annotations or tags", async () => {
    const suffix = Date.now();
    const first = await cli.importSingleUrl({ userId, url: `https://duplicate.example/story-${suffix}`, tags: "first" });
    const second = await cli.importSingleUrl({ userId, url: `https://duplicate.example/story-${suffix}/`, tags: "second", markAsRead: true });
    await dbModule.db.annotation.create({ data: { userId, entryId: second.entry.id, text: "Move me", quote: "", ranges: [] } });

    const result = await cli.cleanDuplicateEntries(userId);
    expect(result.duplicates).toBeGreaterThanOrEqual(1);
    const survivors = await dbModule.db.entry.findMany({
      where: { id: { in: [first.entry.id, second.entry.id] } },
      include: { tags: true, annotations: true },
    });
    expect(survivors).toHaveLength(1);
    expect(survivors[0]).toMatchObject({ archived: true, annotations: [{ text: "Move me" }] });
    expect(survivors[0].tags.map((tag) => tag.label).sort()).toEqual(["first", "second"]);
  });
});

describe("durable import queue", () => {
  it("publishes items atomically with a job that another worker immediately claims", async () => {
    const create = dbModule.db.importJob.create.bind(dbModule.db.importJob);
    let processed: Awaited<ReturnType<typeof queue.processImportJob>>;
    vi.spyOn(dbModule.db.importJob, "create").mockImplementationOnce((async (args) => {
      const job = await create(args);
      processed = await queue.processImportJob(job.id, { workerId: "publication-observer" });
      return job;
    }) as typeof dbModule.db.importJob.create);

    const job = await queue.enqueueNormalizedImport(userId, "wallabag", [
      normalized(`https://example.com/publication-${randomUUID()}`, "Published atomically"),
    ]);

    expect(processed!).toMatchObject({ id: job.id, status: "completed", imported: 1, total: 1 });
    expect(await queue.processImportJob(job.id)).toBeNull();
  });

  it("persists pending work for another process and safely handles concurrent duplicates", async () => {
    const url = `https://example.com/durable-${Date.now()}`;
    const job = await queue.enqueueNormalizedImport(userId, "wallabag", [normalized(url, "First"), normalized(url, "Duplicate")]);
    const independent = new PrismaClient({ datasourceUrl: databaseUrl });
    const persisted = await independent.importJob.findUnique({ where: { id: job.id }, include: { items: true } });
    await independent.$disconnect();

    expect(persisted).toMatchObject({ status: "pending", total: 2 });
    expect(persisted?.items).toHaveLength(2);
    const result = await queue.processImportJob(job.id, { workerId: "integration-worker" });
    expect(result).toMatchObject({ status: "completed", total: 2, imported: 1, skipped: 1, failed: 0 });
    expect(await dbModule.db.entry.count({ where: { userId, givenUrl: url } })).toBe(1);
  });

  it("reclaims stale locks and records its replacement worker", async () => {
    const job = await queue.enqueueNormalizedImport(userId, "wallabag", [normalized(`https://example.com/stale-${Date.now()}`, "Stale")]);
    const oldTime = new Date("2030-01-01T00:00:00.000Z");
    await dbModule.db.importJob.update({
      where: { id: job.id },
      data: { status: "processing", attempts: 1, workerId: "dead-worker", lockedAt: oldTime, heartbeatAt: oldTime },
    });
    const result = await queue.processImportJob(job.id, { workerId: "replacement-worker", now: new Date("2030-01-01T00:10:00.000Z") });
    expect(result).toMatchObject({ status: "completed", imported: 1 });
    const completed = await dbModule.db.importJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(completed.attempts).toBe(2);
    expect(completed.workerId).toBeNull();
    expect(completed.completedAt?.toISOString()).toBe("2030-01-01T00:10:00.000Z");
  });

  it("replays a partially completed item without duplicating imported annotations", async () => {
    const entry = normalized(`https://example.com/annotation-${Date.now()}`, "Annotated");
    entry.annotations = [{ text: "Durable note", quote: "Offline", ranges: [] }];
    const job = await queue.enqueueNormalizedImport(userId, "wallabag", [entry]);
    await queue.processImportJob(job.id);
    const item = await dbModule.db.importJobItem.findFirstOrThrow({ where: { jobId: job.id } });
    expect(await dbModule.db.annotation.count({ where: { entryId: item.entryId! } })).toBe(1);

    await dbModule.db.$transaction([
      dbModule.db.importJob.update({ where: { id: job.id }, data: { status: "pending", completedAt: null, availableAt: new Date(0) } }),
      dbModule.db.importJobItem.update({ where: { id: item.id }, data: { status: "pending", attempts: 0, availableAt: new Date(0) } }),
    ]);
    await queue.processImportJob(job.id);
    expect(await dbModule.db.annotation.count({ where: { entryId: item.entryId! } })).toBe(1);
  });

  it("retries an annotation write failure without skipping the newly imported entry", async () => {
    const entry = normalized(`https://example.com/annotation-retry-${randomUUID()}`, "Retry notes");
    entry.annotations = [{ text: "Retry this imported note", quote: "Offline", ranges: [] }];
    const job = await queue.enqueueNormalizedImport(userId, "wallabag", [entry]);
    await dbModule.db.$executeRawUnsafe(`CREATE TRIGGER fail_import_annotation BEFORE INSERT ON "Annotation"
      WHEN NEW.text = 'Retry this imported note' BEGIN SELECT RAISE(FAIL, 'annotation storage unavailable'); END`);

    try {
      expect(await queue.processImportJob(job.id, { now: new Date("2030-03-01T00:00:00Z") }))
        .toMatchObject({ status: "pending", imported: 0, skipped: 0 });
    } finally {
      await dbModule.db.$executeRawUnsafe('DROP TRIGGER fail_import_annotation');
    }

    expect(await queue.processImportJob(job.id, { now: new Date("2030-03-01T00:01:00Z") }))
      .toMatchObject({ status: "completed", imported: 1, skipped: 0, failed: 0 });
    const item = await dbModule.db.importJobItem.findFirstOrThrow({ where: { jobId: job.id } });
    expect(await dbModule.db.annotation.findMany({ where: { entryId: item.entryId! }, select: { text: true } }))
      .toEqual([{ text: "Retry this imported note" }]);
  });

  it("never commits a created entry without its durable import-item link", async () => {
    const entry = normalized(`https://example.com/link-retry-${randomUUID()}`, "Durable creation");
    entry.annotations = [{ text: "Survive creation interruption", quote: "Offline", ranges: [] }];
    const job = await queue.enqueueNormalizedImport(userId, "wallabag", [entry]);
    await dbModule.db.$executeRawUnsafe(`CREATE TRIGGER fail_import_link BEFORE UPDATE OF "entryId" ON "ImportJobItem"
      WHEN NEW.entryId IS NOT NULL AND OLD.entryId IS NULL BEGIN SELECT RAISE(FAIL, 'item link unavailable'); END`);

    try {
      expect(await queue.processImportJob(job.id, { now: new Date("2030-03-02T00:00:00Z") }))
        .toMatchObject({ status: "pending", imported: 0, skipped: 0 });
      expect(await dbModule.db.entry.count({ where: { userId, givenUrl: entry.url } })).toBe(0);
    } finally {
      await dbModule.db.$executeRawUnsafe('DROP TRIGGER fail_import_link');
    }

    expect(await queue.processImportJob(job.id, { now: new Date("2030-03-02T00:01:00Z") }))
      .toMatchObject({ status: "completed", imported: 1, skipped: 0, failed: 0 });
    const saved = await dbModule.db.entry.findUniqueOrThrow({
      where: { userId_urlHash: { userId, urlHash: createUrlHash(entry.url) } },
      include: { annotations: true },
    });
    expect(saved.annotations.map(({ text }) => text)).toEqual(["Survive creation interruption"]);
  });

  it("bounds malformed-item retries and reaches a terminal failed state", async () => {
    const job = await queue.enqueueNormalizedImport(userId, "wallabag", [normalized(`https://example.com/bad-${Date.now()}`, "Bad")]);
    await dbModule.db.importJobItem.updateMany({ where: { jobId: job.id }, data: { payload: { url: "https://example.com/bad-payload" } } });

    for (const instant of ["2030-02-01T00:00:00Z", "2030-02-01T00:01:00Z", "2030-02-01T00:02:00Z"]) {
      await queue.processImportJob(job.id, { now: new Date(instant) });
    }
    const [failedJob, failedItem] = await Promise.all([
      dbModule.db.importJob.findUniqueOrThrow({ where: { id: job.id } }),
      dbModule.db.importJobItem.findFirstOrThrow({ where: { jobId: job.id } }),
    ]);
    expect(failedJob).toMatchObject({ status: "failed", failed: 1 });
    expect(failedItem).toMatchObject({ status: "failed", attempts: 3, error: "Import item collections are invalid" });
  });

  it("terminates a fifth job attempt even when an item still has retries left", async () => {
    const job = await queue.enqueueNormalizedImport(userId, "wallabag", [
      normalized(`https://example.com/fifth-attempt-${randomUUID()}`, "Final attempt"),
    ]);
    await dbModule.db.importJob.update({ where: { id: job.id }, data: { attempts: 4 } });
    await dbModule.db.importJobItem.updateMany({ where: { jobId: job.id }, data: { payload: { url: "https://example.com/incomplete" } } });

    expect(await queue.processImportJob(job.id, { now: new Date("2030-04-01T00:00:00Z") }))
      .toMatchObject({ status: "failed", failed: 1, imported: 0 });
    expect(await dbModule.db.importJobItem.findFirstOrThrow({ where: { jobId: job.id } }))
      .toMatchObject({ status: "failed", attempts: 1, workerId: null, lockedAt: null });
    expect(await queue.processImportJob(job.id, { now: new Date("2030-04-01T00:01:00Z") })).toBeNull();
  });

  it.each(["pending", "processing"])("recovers an already exhausted %s job into a terminal state", async (status) => {
    const job = await queue.enqueueNormalizedImport(userId, "wallabag", [
      normalized(`https://example.com/exhausted-${randomUUID()}`, "Exhausted claim"),
    ]);
    await dbModule.db.importJob.update({
      where: { id: job.id },
      data: { attempts: 5, status, lockedAt: status === "processing" ? new Date("2030-04-02T00:00:00Z") : null, workerId: "departed-worker" },
    });
    await dbModule.db.importJobItem.updateMany({ where: { jobId: job.id }, data: { status, workerId: "departed-worker" } });

    await queue.processImportJob(job.id, { now: new Date("2030-04-02T00:10:00Z") });

    expect(await dbModule.db.importJob.findUniqueOrThrow({ where: { id: job.id } }))
      .toMatchObject({ status: "failed", failed: 1, attempts: 5, workerId: null, lockedAt: null, completedAt: new Date("2030-04-02T00:10:00Z") });
    expect(await dbModule.db.importJobItem.findFirstOrThrow({ where: { jobId: job.id } }))
      .toMatchObject({ status: "failed", workerId: null, lockedAt: null });
  });

  it("does not exceed an item's retry budget when recovering a crashed worker", async () => {
    const job = await queue.enqueueNormalizedImport(userId, "wallabag", [
      normalized(`https://example.com/exhausted-item-${randomUUID()}`, "Exhausted item"),
    ]);
    await dbModule.db.importJob.update({
      where: { id: job.id },
      data: { attempts: 3, status: "processing", lockedAt: new Date("2030-04-03T00:00:00Z"), workerId: "crashed-worker" },
    });
    await dbModule.db.importJobItem.updateMany({
      where: { jobId: job.id },
      data: { attempts: 3, status: "processing", lockedAt: new Date("2030-04-03T00:00:00Z"), workerId: "crashed-worker" },
    });

    expect(await queue.processImportJob(job.id, { now: new Date("2030-04-03T00:10:00Z") }))
      .toMatchObject({ status: "failed", failed: 1, imported: 0 });
    expect(await dbModule.db.importJobItem.findFirstOrThrow({ where: { jobId: job.id } }))
      .toMatchObject({ status: "failed", attempts: 3, workerId: null, lockedAt: null });
  });

  it("renews an active lease while article extraction is still in flight", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(new Date("2030-05-01T00:00:00Z"));
    const started = deferred<void>();
    const response = deferred<Response>();
    vi.stubGlobal("fetch", async () => {
      started.resolve();
      return response.promise;
    });
    const entry = normalized(`https://93.184.216.34/slow-import-${randomUUID()}`, "Slow article");
    delete entry.content;
    const job = await queue.enqueueNormalizedImport(userId, "wallabag", [entry]);
    const processing = queue.processImportJob(job.id, { workerId: "active-worker" });
    await started.promise;

    try {
      for (let minute = 0; minute < 6; minute += 1) {
        await vi.advanceTimersByTimeAsync(60_000);
        await vi.waitFor(async () => {
          const current = await dbModule.db.importJob.findUniqueOrThrow({ where: { id: job.id } });
          expect(current.heartbeatAt!.getTime()).toBeGreaterThan(new Date("2030-05-01T00:00:00Z").getTime() + minute * 60_000);
        });
      }
      expect(await queue.processImportJob(job.id, { workerId: "other-worker" })).toBeNull();
    } finally {
      response.resolve(new Response("<article><p>The slow article arrived.</p></article>", { headers: { "content-type": "text/html" } }));
      await processing;
    }

    expect(await dbModule.db.importJob.findUniqueOrThrow({ where: { id: job.id } }))
      .toMatchObject({ status: "completed", attempts: 1, imported: 1 });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("fences a replaced claim even when both invocations use the same worker label", async () => {
    const originalResponse = deferred<Response>();
    const replacementResponse = deferred<Response>();
    const fetch = vi.fn()
      .mockImplementationOnce(() => originalResponse.promise)
      .mockImplementationOnce(() => replacementResponse.promise);
    vi.stubGlobal("fetch", fetch);
    const entry = normalized(`https://93.184.216.34/replaced-${randomUUID()}`, "Claim ownership");
    delete entry.content;
    entry.annotations = [{ text: "Import exactly once", quote: "", ranges: [] }];
    const job = await queue.enqueueNormalizedImport(userId, "wallabag", [entry]);
    const original = queue.processImportJob(job.id, { workerId: "reusable-label", now: new Date("2030-05-02T00:00:00Z") });
    let replacement: ReturnType<typeof queue.processImportJob> | undefined;

    try {
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      const firstClaim = await dbModule.db.importJob.findUniqueOrThrow({ where: { id: job.id } });
      replacement = queue.processImportJob(job.id, { workerId: "reusable-label", now: new Date("2030-05-02T00:06:00Z") });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      const secondClaim = await dbModule.db.importJob.findUniqueOrThrow({ where: { id: job.id } });

      originalResponse.resolve(new Response("<article><p>Abandoned output.</p></article>", { headers: { "content-type": "text/html" } }));
      await original;

      expect(await dbModule.db.importJob.findUniqueOrThrow({ where: { id: job.id } }))
        .toMatchObject({ status: "processing", attempts: 2, workerId: secondClaim.workerId, lockedAt: secondClaim.lockedAt });
      expect(secondClaim.workerId).not.toBe(firstClaim.workerId);
      expect(await dbModule.db.importJobItem.findFirstOrThrow({ where: { jobId: job.id } }))
        .toMatchObject({ status: "processing", attempts: 2, workerId: secondClaim.workerId, entryId: null });
      expect(await dbModule.db.entry.count({ where: { userId, givenUrl: entry.url } })).toBe(0);

      replacementResponse.resolve(new Response("<article><p>Replacement output.</p></article>", { headers: { "content-type": "text/html" } }));
      expect(await replacement).toMatchObject({ status: "completed", imported: 1, skipped: 0, failed: 0 });
      const saved = await dbModule.db.entry.findUniqueOrThrow({
        where: { userId_urlHash: { userId, urlHash: createUrlHash(entry.url) } },
        include: { annotations: true },
      });
      expect(saved.content).toContain("Replacement output");
      expect(saved.annotations.map(({ text }) => text)).toEqual(["Import exactly once"]);
    } finally {
      originalResponse.resolve(new Response("<p>Released original request.</p>"));
      replacementResponse.resolve(new Response("<p>Released replacement request.</p>"));
      await Promise.allSettled([original, ...(replacement ? [replacement] : [])]);
    }
  });

  it.each(["page", "error"])("does not let a stale Pocket %s overwrite the replacement claim", async (outcome) => {
    vi.stubEnv("POCKET_TOKEN_KEY", Buffer.alloc(32, 7).toString("base64"));
    const originalResponse = deferred<Response>();
    const replacementResponse = deferred<Response>();
    const fetch = vi.fn()
      .mockImplementationOnce(() => originalResponse.promise)
      .mockImplementationOnce(() => replacementResponse.promise);
    vi.stubGlobal("fetch", fetch);
    const job = await queue.enqueuePocketImport(userId, encryptPocketToken("test-access-token"), "test-consumer", false);
    const original = queue.processImportJob(job.id, { workerId: "pocket-worker", now: new Date("2030-05-03T00:00:00Z") });
    let replacement: ReturnType<typeof queue.processImportJob> | undefined;

    try {
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
      replacement = queue.processImportJob(job.id, { workerId: "pocket-worker", now: new Date("2030-05-03T00:06:00Z") });
      await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
      const claim = await dbModule.db.importJob.findUniqueOrThrow({ where: { id: job.id } });
      if (outcome === "error") originalResponse.reject(new Error("Old Pocket request failed"));
      else originalResponse.resolve(Response.json({ list: { 1: { given_url: "https://93.184.216.34/stale-pocket", given_title: "Stale result" } } }));
      await original;

      expect(await dbModule.db.importJob.findUniqueOrThrow({ where: { id: job.id } }))
        .toMatchObject({ status: "processing", workerId: claim.workerId, lockedAt: claim.lockedAt, total: 0, options: claim.options, remoteCredential: claim.remoteCredential });
      expect(await dbModule.db.importJobItem.count({ where: { jobId: job.id } })).toBe(0);

      replacementResponse.resolve(Response.json({ list: {} }));
      expect(await replacement).toMatchObject({ status: "completed", total: 0, failed: 0 });
      expect(await dbModule.db.importJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({ remoteCredential: null });
    } finally {
      originalResponse.resolve(Response.json({ list: {} }));
      replacementResponse.resolve(Response.json({ list: {} }));
      await Promise.allSettled([original, ...(replacement ? [replacement] : [])]);
    }
  });

  it("processes newly hydrated Pocket items on the last available job attempt", async () => {
    vi.stubEnv("POCKET_TOKEN_KEY", Buffer.alloc(32, 8).toString("base64"));
    const url = `https://93.184.216.34/final-pocket-${randomUUID()}`;
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      if (String(input).startsWith("https://getpocket.com/")) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return Response.json({ list: { 1: { given_url: url, given_title: "Hydrated at the last attempt" } } });
      }
      return new Response("<article><p>Freshly hydrated article.</p></article>", { headers: { "content-type": "text/html" } });
    });
    const job = await queue.enqueuePocketImport(userId, encryptPocketToken("test-access-token"), "test-consumer", false);
    await dbModule.db.importJob.update({ where: { id: job.id }, data: { attempts: 4 } });

    expect(await queue.processImportJob(job.id)).toMatchObject({ status: "completed", total: 1, imported: 1, failed: 0 });
  });
});

function normalized(url: string, title: string): NormalizedImportEntry {
  return {
    url,
    title,
    content: "<p>Offline import content.</p>",
    tags: [],
    archived: false,
    starred: false,
    publishedBy: [],
    annotations: [],
  };
}

function createUrlHash(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((fulfilled, rejected) => { resolve = fulfilled; reject = rejected; });
  return { promise, resolve, reject };
}
