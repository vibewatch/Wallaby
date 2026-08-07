import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const originalDatabaseUrl = process.env.DATABASE_URL;
let directory: string;
let dbModule: typeof import("./db");
let search: typeof import("./search");
let filters: typeof import("./entry-filters");
let readerId: string;
let strangerId: string;
const ids: Record<string, string> = {};

async function save(userId: string, key: string, title: string, content: string, domainName: string, tags: string[] = []) {
  const entry = await dbModule.db.entry.create({
    data: {
      userId,
      title,
      content,
      domainName,
      url: `https://${domainName}/${key}`,
      givenUrl: `https://${domainName}/${key}`,
      urlHash: `${userId}-${key}`,
      tags: { create: tags.map((label) => ({ label, slug: label, userId })) },
    },
  });
  ids[key] = entry.id;
  return entry.id;
}

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "wallaby-search-"));
  process.env.DATABASE_URL = `file:${join(directory, "search.db")}`;
  // `migrate deploy`, not `db push`: the full-text index and its triggers live
  // in a migration because Prisma's schema language cannot express them.
  await execute(join(process.cwd(), "node_modules/.bin/prisma"), ["migrate", "deploy"], { cwd: process.cwd(), env: { ...process.env } });
  dbModule = await import("./db");
  search = await import("./search");
  filters = await import("./entry-filters");

  readerId = (await dbModule.db.user.create({ data: { username: "search-reader", preference: { create: {} } } })).id;
  strangerId = (await dbModule.db.user.create({ data: { username: "search-stranger", preference: { create: {} } } })).id;

  await save(readerId, "titled", "Portable reading", "<p>An article about keeping things.</p>", "titles.example");
  await save(readerId, "bodied", "An unrelated headline", `<p>${"filler ".repeat(40)}portable copies of the web are worth keeping.</p>`, "bodies.example");
  await save(readerId, "phrased", "Notes", "<p>You can read it later without a network.</p>", "phrases.example");
  await save(readerId, "scattered", "Notes", "<p>Read this. It arrived later.</p>", "phrases.example");
  await save(readerId, "tagged", "Nothing matching here", "<p>Nothing matching here either.</p>", "tags.example", ["portable"]);
  await save(strangerId, "stranger", "Portable reading", "<p>Someone else's portable article.</p>", "titles.example");
}, 60_000);

afterAll(async () => {
  await dbModule?.db.$disconnect();
  process.env.DATABASE_URL = originalDatabaseUrl;
  await rm(directory, { recursive: true, force: true });
});

describe("search engine detection", () => {
  it("finds the index that the migration installed", async () => {
    search.resetSearchEngine();
    await expect(search.searchEngine()).resolves.toBe("index");
  });
});

describe("rankedEntryIds", () => {
  it("ranks a title match above the same word buried in body text", async () => {
    const ranked = await search.rankedEntryIds(readerId, "portable");
    expect(ranked?.slice(0, 2)).toEqual([ids.titled, ids.bodied]);
  });

  it("matches word prefixes so results arrive while typing", async () => {
    expect(await search.rankedEntryIds(readerId, "portab")).toContain(ids.titled);
  });

  it("requires every bare word, so adding one narrows the result", async () => {
    const both = await search.rankedEntryIds(readerId, "portable reading");
    expect(both).toEqual([ids.titled]);
  });

  it("honours a quoted phrase as an ordered sequence", async () => {
    const phrase = await search.rankedEntryIds(readerId, '"read it later"');
    expect(phrase).toEqual([ids.phrased]);
    const loose = await search.rankedEntryIds(readerId, "read it later");
    expect(loose).toEqual(expect.arrayContaining([ids.phrased, ids.scattered]));
  });

  it("unions in entries that only a tag label matches", async () => {
    expect(await search.rankedEntryIds(readerId, "portable")).toContain(ids.tagged);
  });

  it("never returns another reader's entries", async () => {
    const ranked = await search.rankedEntryIds(readerId, "portable");
    expect(ranked).not.toContain(ids.stranger);
    expect(await search.rankedEntryIds(strangerId, "portable")).toEqual([ids.stranger]);
  });

  it("survives input that looks like index syntax", async () => {
    for (const attack of ['" OR "', "NEAR(", "foo AND", "*", "^title:", "a'b\"c"]) {
      await expect(search.rankedEntryIds(readerId, attack)).resolves.not.toThrow();
    }
    // `OR` is read as a word rather than an operator, so this narrows to
    // nothing instead of widening to every "portable" hit.
    expect(await search.rankedEntryIds(readerId, "portable OR unmatchableword")).toEqual([]);
    expect(await search.rankedEntryIds(readerId, "*portable*")).toContain(ids.titled);
  });

  it("declines a query with nothing indexable in it", async () => {
    expect(await search.rankedEntryIds(readerId, "   ")).toBeNull();
  });

  it("stays current when an entry is edited", async () => {
    await dbModule.db.entry.update({ where: { id: ids.phrased }, data: { title: "Renamed to serendipity" } });
    expect(await search.rankedEntryIds(readerId, "serendipity")).toEqual([ids.phrased]);
    await dbModule.db.entry.update({ where: { id: ids.phrased }, data: { title: "Notes" } });
    expect(await search.rankedEntryIds(readerId, "serendipity")).toEqual([]);
  });

  it("forgets an entry that was deleted", async () => {
    const id = await save(readerId, "doomed", "Ephemeral portable note", "<p>Briefly here.</p>", "doomed.example");
    expect(await search.rankedEntryIds(readerId, "ephemeral")).toEqual([id]);
    await dbModule.db.entry.delete({ where: { id } });
    expect(await search.rankedEntryIds(readerId, "ephemeral")).toEqual([]);
  });
});

describe("findEntryPage", () => {
  const parsed = (query: string) => filters.parseEntryFilters({ view: "all", q: query });

  it("returns the page in relevance order with a matching total", async () => {
    const ranked = await search.rankedEntryIds(readerId, "portable");
    const where = filters.entryWhere(readerId, parsed("portable"), 200, null, ranked);
    const page = await search.findEntryPage({ where, ranked, page: 1, pageSize: 2 });
    expect(page.total).toBe(3);
    expect(page.entries.map((entry) => entry.id)).toEqual([ids.titled, ids.bodied]);
    const second = await search.findEntryPage({ where, ranked, page: 2, pageSize: 2 });
    expect(second.entries.map((entry) => entry.id)).toEqual([ids.tagged]);
  });

  it("still applies the other filters to a ranked result", async () => {
    await dbModule.db.entry.update({ where: { id: ids.titled }, data: { archived: true } });
    const ranked = await search.rankedEntryIds(readerId, "portable");
    const where = filters.entryWhere(readerId, parsed("portable"), 200, null, ranked);
    where.archived = false;
    const page = await search.findEntryPage({ where, ranked, page: 1, pageSize: 20 });
    expect(page.entries.map((entry) => entry.id)).toEqual([ids.bodied, ids.tagged]);
    await dbModule.db.entry.update({ where: { id: ids.titled }, data: { archived: false } });
  });

  it("falls back to newest-first when nothing ranked the results", async () => {
    const where = filters.entryWhere(readerId, parsed(""), 200, null, null);
    const page = await search.findEntryPage({ where, ranked: null, page: 1, pageSize: 3 });
    expect(page.total).toBe(5);
    expect(page.entries).toHaveLength(3);
    const times = page.entries.map((entry) => entry.createdAt.getTime());
    expect([...times].sort((first, second) => second - first)).toEqual(times);
  });

  it("returns an empty page rather than everything when nothing matched", async () => {
    const where = filters.entryWhere(readerId, parsed("nonexistent"), 200, null, []);
    const page = await search.findEntryPage({ where, ranked: [], page: 1, pageSize: 20 });
    expect(page).toMatchObject({ total: 0, entries: [] });
  });
});
