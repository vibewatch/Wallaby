import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { NormalizedImportEntry } from "./importers";

const execute = promisify(execFile);
const originalDatabaseUrl = process.env.DATABASE_URL;
let directory: string;
let databaseUrl: string;
let userId: string;
let queue: typeof import("./import-queue");
let dbModule: typeof import("./db");
let cli: typeof import("./cli-operations");

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "wallaby-import-queue-"));
  databaseUrl = `file:${join(directory, "queue.db")}`;
  process.env.DATABASE_URL = databaseUrl;
  await execute(join(process.cwd(), "node_modules/.bin/prisma"), ["db", "push", "--skip-generate"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  dbModule = await import("./db");
  queue = await import("./import-queue");
  cli = await import("./cli-operations");
  const user = await dbModule.db.user.create({ data: { username: `queue-${Date.now()}`, preference: { create: {} } } });
  userId = user.id;
}, 30_000);

afterAll(async () => {
  await dbModule?.db.$disconnect();
  process.env.DATABASE_URL = originalDatabaseUrl;
  await rm(directory, { recursive: true, force: true });
});

describe("operator command operations", () => {
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
