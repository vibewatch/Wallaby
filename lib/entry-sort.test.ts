import { describe, expect, it } from "vitest";

import { entryOrderBy, entrySortLabel, parseEntrySort } from "./entry-sort";

describe("parseEntrySort", () => {
  it("defaults to newest, or to relevance while searching", () => {
    expect(parseEntrySort(undefined, false)).toBe("newest");
    expect(parseEntrySort("", true)).toBe("relevance");
  });

  it("honours a known ordering even while searching", () => {
    expect(parseEntrySort("oldest", true)).toBe("oldest");
    expect(parseEntrySort("longest", false)).toBe("longest");
  });

  it("ignores relevance without a search and unknown or inherited names", () => {
    expect(parseEntrySort("relevance", false)).toBe("newest");
    expect(parseEntrySort("toString", false)).toBe("newest");
    expect(parseEntrySort("__proto__", true)).toBe("relevance");
    expect(parseEntrySort(["oldest"], false)).toBe("newest");
  });
});

describe("entryOrderBy", () => {
  it("always ends on a unique column so pages are stable", () => {
    for (const sort of ["newest", "oldest", "title", "shortest", "longest", "published", "relevance"] as const) {
      expect(Object.keys(entryOrderBy(sort).at(-1)!)).toEqual(["id"]);
    }
  });

  it("puts entries without a publication date last", () => {
    expect(entryOrderBy("published")[0]).toEqual({ publishedAt: { sort: "desc", nulls: "last" } });
  });

  it("labels the relevance ordering", () => {
    expect(entrySortLabel("relevance")).toBe("Most relevant first");
    expect(entrySortLabel("title")).toBe("Title A–Z");
  });
});
