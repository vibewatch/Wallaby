import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { entryOrderBy, entrySortOptions } from "./entry-sort";

const execute = promisify(execFile);
const originalDatabaseUrl = process.env.DATABASE_URL;
let directory: string;
let userId: string;
let dbModule: typeof import("./db");
let lists: typeof import("./entry-list");

const select = { id: true, createdAt: true, title: true, readingTime: true, publishedAt: true } as const;

beforeAll(async () => {
  directory = join(".test-runs", `entry-list-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  const databaseUrl = `file:${resolve(directory, "lists.db")}`;
  process.env.DATABASE_URL = databaseUrl;
  await execute(join(process.cwd(), "node_modules/.bin/prisma"), ["migrate", "deploy"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  dbModule = await import("./db");
  lists = await import("./entry-list");
  const user = await dbModule.db.user.create({ data: { username: `lists-${Date.now()}`, preference: { create: {} } } });
  userId = user.id;

  // Deliberate ties on every sort key, and missing publication dates, so the
  // tie-breakers and null handling are what decide the order.
  const saved = new Date("2026-01-10T12:00:00Z");
  const fixtures = [
    { title: "Harbour lights", readingTime: 4, createdAt: saved, publishedAt: new Date("2025-05-01") },
    { title: "Harbour lights", readingTime: 4, createdAt: saved, publishedAt: null },
    { title: "Alpine notes", readingTime: 9, createdAt: new Date("2026-01-12"), publishedAt: new Date("2025-05-01") },
    { title: "Quiet rooms", readingTime: 1, createdAt: new Date("2026-01-08"), publishedAt: null },
    { title: "Field guide", readingTime: 9, createdAt: new Date("2026-01-11"), publishedAt: new Date("2024-02-02") },
    { title: "Evening harbour", readingTime: 2, createdAt: saved, publishedAt: new Date("2026-01-01"), archived: true },
  ];
  for (const [index, fixture] of fixtures.entries()) {
    await dbModule.db.entry.create({ data: {
      userId,
      url: `https://lists.example/${index}`,
      givenUrl: `https://lists.example/${index}`,
      urlHash: `hash-${index}`,
      content: `<p>${fixture.title} harbour story</p>`,
      domainName: "lists.example",
      ...fixture,
    } });
  }
}, 30_000);

afterAll(async () => {
  await dbModule?.db.$disconnect();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function walk(list: string, start: { id: string }, direction: "next" | "previous"): Promise<string[]> {
  const visited = [start.id];
  let current = await dbModule.db.entry.findUniqueOrThrow({ where: { id: start.id }, select });
  for (let step = 0; step < 20; step += 1) {
    const neighbours = await lists.findListNeighbours(userId, list, current, 200);
    const target = neighbours[direction];
    if (!target) return visited;
    visited.push(target.id);
    current = await dbModule.db.entry.findUniqueOrThrow({ where: { id: target.id }, select });
  }
  throw new Error("Neighbour walk did not terminate");
}

describe("findListNeighbours", () => {
  it.each(entrySortOptions.map((option) => option.value))("steps through the whole %s list in both directions", async (sort) => {
    const list = `view=all&sort=${sort}`;
    const expected = (await dbModule.db.entry.findMany({ where: { userId }, orderBy: entryOrderBy(sort), select: { id: true } })).map(({ id }) => id);
    expect(expected).toHaveLength(6);
    expect(await walk(list, { id: expected[0] }, "next")).toEqual(expected);
    expect(await walk(list, { id: expected.at(-1)! }, "previous")).toEqual([...expected].reverse());
  });

  it("keeps an entry's place after it leaves the list, as when it is archived from Unread", async () => {
    const unread = (await dbModule.db.entry.findMany({ where: { userId, archived: false }, orderBy: entryOrderBy("newest"), select })).map(({ id }) => id);
    const archived = await dbModule.db.entry.findFirstOrThrow({ where: { userId, archived: true }, select });
    const all = (await dbModule.db.entry.findMany({ where: { userId }, orderBy: entryOrderBy("newest"), select: { id: true } })).map(({ id }) => id);
    const followingInAll = all.slice(all.indexOf(archived.id) + 1);
    const { next } = await lists.findListNeighbours(userId, "view=unread", archived, 200);
    expect(next?.id).toBe(followingInAll.find((id) => unread.includes(id)));
  });

  it("follows relevance order while searching", async () => {
    const list = "view=all&q=harbour";
    const first = await dbModule.db.entry.findFirstOrThrow({ where: { userId, title: "Evening harbour" }, select });
    const visited = new Set([...(await walk(list, first, "next")), ...(await walk(list, first, "previous"))]);
    expect(visited.size).toBe(6);
  });

  it("offers no neighbours for an entry outside a ranked search", async () => {
    const outside = await dbModule.db.entry.create({ data: { userId, url: "https://lists.example/other", givenUrl: "https://lists.example/other", urlHash: "hash-other", title: "Unrelated", content: "<p>nothing</p>" }, select });
    expect(await lists.findListNeighbours(userId, "view=all&q=harbour", outside, 200)).toEqual({ previous: null, next: null });
    await dbModule.db.entry.delete({ where: { id: outside.id } });
  });
});

describe("list context", () => {
  it("keeps only library parameters", () => {
    expect(lists.listQuery({ view: "all", tag: "news", sort: "title", page: "2", callbackUrl: "https://evil.example", list: "x" }))
      .toBe("view=all&tag=news&sort=title&page=2");
  });

  it("only ever links back into the library", () => {
    expect(lists.libraryHref(lists.readListParam("//evil.example/?view=all"))).toBe("/entries");
    expect(lists.libraryHref(lists.readListParam("view=starred&page=3"))).toBe("/entries?view=starred&page=3");
    expect(lists.entryHref("abc", "view=all&q=a b")).toBe("/entries/abc?list=view%3Dall%26q%3Da%20b");
    expect(lists.readListParam(["view=all"])).toBe("");
  });
});
