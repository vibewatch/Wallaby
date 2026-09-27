import { describe, expect, it } from "vitest";

import { applyTagSuggestion, matchTagSuggestions } from "./tag-suggestions";

const tags = ["research", "reading list", "Rust", "design", "later", "urban research"];

describe("matchTagSuggestions", () => {
  it("matches only the segment being typed, prefixes first", () => {
    expect(matchTagSuggestions("design, re", tags)).toEqual(["research", "reading list", "urban research"]);
  });

  it("ignores case and skips tags already listed", () => {
    expect(matchTagSuggestions("Research, R", tags)).toEqual(["reading list", "Rust", "later", "urban research"]);
  });

  it("offers nothing for an empty segment or an exact match", () => {
    expect(matchTagSuggestions("design, ", tags)).toEqual([]);
    expect(matchTagSuggestions("later", tags)).toEqual([]);
  });

  it("matches past a removal prefix", () => {
    expect(matchTagSuggestions("-lat", tags)).toEqual(["later"]);
  });

  it("caps the list", () => {
    expect(matchTagSuggestions("e", tags, 2)).toHaveLength(2);
  });
});

describe("applyTagSuggestion", () => {
  it("replaces the typed segment and readies the next one", () => {
    expect(applyTagSuggestion("design,  re", "research")).toBe("design, research, ");
    expect(applyTagSuggestion("re", "research")).toBe("research, ");
  });

  it("keeps a removal prefix", () => {
    expect(applyTagSuggestion("design, -lat", "later")).toBe("design, -later, ");
  });
});
