import { describe, expect, it } from "vitest";

import { ftsMatchExpression, searchSnippet, tokenizeSearch } from "./search";

describe("tokenizeSearch", () => {
  it("splits bare words and lowercases them", () => {
    expect(tokenizeSearch("Portable Reading")).toEqual({ terms: ["portable", "reading"], phrases: [] });
  });

  it("keeps quoted text together as a phrase", () => {
    expect(tokenizeSearch('"read it later" archive')).toEqual({ terms: ["archive"], phrases: ["read it later"] });
  });

  it("drops a bare word that is already covered by a phrase", () => {
    expect(tokenizeSearch('"portable" portable')).toEqual({ terms: [], phrases: ["portable"] });
  });

  it("discards every character the FTS grammar would treat as an operator", () => {
    expect(tokenizeSearch("NEAR( ^title: foo* -bar")).toEqual({ terms: ["near", "title", "foo", "bar"], phrases: [] });
    expect(tokenizeSearch("*")).toEqual({ terms: [], phrases: [] });
    expect(tokenizeSearch('"')).toEqual({ terms: [], phrases: [] });
  });

  it("keeps non-Latin words the unicode tokenizer would index", () => {
    expect(tokenizeSearch("中文 русский")).toEqual({ terms: ["中文", "русский"], phrases: [] });
  });

  it("removes duplicates and bounds token count and length", () => {
    expect(tokenizeSearch("same same same")).toEqual({ terms: ["same"], phrases: [] });
    expect(tokenizeSearch(Array.from({ length: 30 }, (_, index) => `word${index}`).join(" ")).terms).toHaveLength(12);
    expect(tokenizeSearch("x".repeat(200)).terms[0]).toHaveLength(64);
  });

  it("yields nothing for input with no indexable characters", () => {
    expect(tokenizeSearch("   ")).toEqual({ terms: [], phrases: [] });
  });
});

describe("ftsMatchExpression", () => {
  it("prefix-matches bare words and keeps phrases exact", () => {
    expect(ftsMatchExpression(tokenizeSearch("portab"))).toBe('"portab"*');
    expect(ftsMatchExpression(tokenizeSearch('"read it later"'))).toBe('"read it later"');
    expect(ftsMatchExpression(tokenizeSearch('"read it later" archive'))).toBe('"read it later" "archive"*');
  });

  it("cannot be talked into emitting an operator", () => {
    for (const attack of ['" OR "a', "foo NEAR bar", '"a" OR "b"', "a*b", "^col:"]) {
      const expression = ftsMatchExpression(tokenizeSearch(attack));
      expect(expression === null || /^(?:"[\p{L}\p{N}_ ]+"\*? ?)+$/u.test(expression)).toBe(true);
    }
  });

  it("has nothing to match when no token survived", () => {
    expect(ftsMatchExpression(tokenizeSearch("!!!"))).toBeNull();
  });
});

describe("searchSnippet", () => {
  const article = `<p>${"filler words ".repeat(30)}A portable library keeps reading available offline.${" trailing words".repeat(30)}</p>`;

  it("returns a window around the first match with the match flagged", () => {
    const parts = searchSnippet(article, tokenizeSearch("portable"))!;
    expect(parts.filter((part) => part.match).map((part) => part.text)).toEqual(["portable"]);
    expect(parts.map((part) => part.text).join("")).toContain("portable library keeps reading");
  });

  it("strips markup so no article HTML reaches the caller", () => {
    const parts = searchSnippet('<p class="lead">A <em>portable</em> copy</p>', tokenizeSearch("portable"))!;
    expect(parts.map((part) => part.text).join("")).toBe("A portable copy");
  });

  it("marks every occurrence inside the window", () => {
    const parts = searchSnippet("<p>copy the copy of the copy</p>", tokenizeSearch("copy"))!;
    expect(parts.filter((part) => part.match)).toHaveLength(3);
  });

  it("elides only the sides it actually trimmed", () => {
    const short = searchSnippet("<p>a portable copy</p>", tokenizeSearch("portable"))!;
    expect(short.map((part) => part.text).join("")).toBe("a portable copy");
    const long = searchSnippet(article, tokenizeSearch("portable"))!;
    expect(long[0].text).toBe("… ");
    expect(long.at(-1)!.text).toBe(" …");
  });

  it("matches case-insensitively and highlights the original casing", () => {
    const parts = searchSnippet("<p>A Portable Library</p>", tokenizeSearch("portable"))!;
    expect(parts.find((part) => part.match)?.text).toBe("Portable");
  });

  it("declines when there is nothing to show", () => {
    expect(searchSnippet(article, tokenizeSearch("absent"))).toBeNull();
    expect(searchSnippet("", tokenizeSearch("portable"))).toBeNull();
    expect(searchSnippet(article, tokenizeSearch("!!!"))).toBeNull();
  });

  it("never returns an empty segment", () => {
    const parts = searchSnippet("<p>portable portable</p>", tokenizeSearch("portable"))!;
    expect(parts.every((part) => part.text.length > 0)).toBe(true);
  });
});
