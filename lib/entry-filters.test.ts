import { describe, expect, it } from "vitest";

import { entryWhere, parseEntryFilters } from "./entry-filters";

describe("entry filter contract", () => {
  it("normalizes the library query into the shared Prisma predicate", () => {
    const filters = parseEntryFilters(new URLSearchParams({
      view: "archive",
      q: "portable",
      tag: "research",
      minRead: "4",
      maxRead: "8",
      createdFrom: "2025-01-01",
      createdTo: "2025-01-31",
      language: "fr",
      httpStatus: "200",
      hasAnnotations: "1",
      isShared: "1",
    }));
    expect(entryWhere("user-1", filters, 100, null)).toMatchObject({
      userId: "user-1",
      archived: true,
      readingTime: { gte: 2, lte: 4 },
      createdAt: { gte: new Date("2025-01-01T00:00:00.000Z"), lte: new Date("2025-01-31T23:59:59.999Z") },
      language: "fr",
      httpStatus: 200,
      annotations: { some: {} },
      shareToken: { not: null },
      tags: { some: { slug: "research" } },
    });
    expect(entryWhere("user-1", filters, 100, null).OR).toHaveLength(4);
  });

  it("defers to a resolved search result instead of matching substrings", () => {
    const filters = parseEntryFilters({ view: "all", q: "portable", tag: "research" });
    const where = entryWhere("user-1", filters, 200, null, ["a", "b"]);
    expect(where).toMatchObject({ id: { in: ["a", "b"] }, tags: { some: { slug: "research" } } });
    expect(where.OR).toBeUndefined();
  });

  it("matches nothing when a search resolved to nothing", () => {
    const filters = parseEntryFilters({ view: "all", q: "portable" });
    expect(entryWhere("user-1", filters, 200, null, [])).toMatchObject({ id: { in: [] } });
  });

  it("leaves the predicate alone when there is no text query to resolve", () => {
    const filters = parseEntryFilters({ view: "all" });
    const where = entryWhere("user-1", filters, 200, null, ["a"]);
    expect(where.id).toBeUndefined();
    expect(where.OR).toBeUndefined();
  });

  it("rejects impossible dates, out-of-range numbers, and unknown views", () => {
    const filters = parseEntryFilters({ view: "unknown", createdFrom: "2025-02-31", httpStatus: "700", minRead: "-1" });
    expect(filters).toMatchObject({ view: "unread", createdFrom: null, httpStatus: null, minRead: null });
  });
});
