import { describe, expect, it } from "vitest";

import { bookmarkletSource, firstWebAddress, readSharedArticle } from "./share-target";

describe("readSharedArticle", () => {
  it("prefers an explicit url and keeps a meaningful title", () => {
    expect(readSharedArticle({ url: " https://example.com/a ", title: "A story", text: "https://other.example/b" }))
      .toEqual({ url: "https://example.com/a", title: "A story", tags: "" });
  });

  it("finds the link Android share sheets put in the text", () => {
    expect(readSharedArticle({ title: "Shared from an app", text: "Worth reading: https://example.com/story?id=4." }))
      .toEqual({ url: "https://example.com/story?id=4", title: "Shared from an app", tags: "" });
  });

  it("drops a title that merely repeats the link", () => {
    expect(readSharedArticle({ url: "https://example.com/a", title: "https://example.com/a" }).title).toBe("");
  });

  it("uses the first value of repeated parameters and bounds lengths", () => {
    const shared = readSharedArticle({ url: ["https://one.example/", "https://two.example/"], title: "t".repeat(2_000), tags: "a, b" });
    expect(shared.url).toBe("https://one.example/");
    expect(shared.title).toHaveLength(1_000);
    expect(shared.tags).toBe("a, b");
  });

  it("returns an empty url when nothing addressable was shared", () => {
    expect(readSharedArticle({ text: "no links here" }).url).toBe("");
    expect(readSharedArticle({}).url).toBe("");
  });
});

describe("firstWebAddress", () => {
  it.each([
    ["see (https://example.com/a)", "https://example.com/a"],
    ["https://example.com/a, and more", "https://example.com/a"],
    ["\"https://example.com/quoted\"", "https://example.com/quoted"],
    ["ftp://example.com/nope", null],
  ])("%j", (text, expected) => {
    expect(firstWebAddress(text)).toBe(expected);
  });
});

describe("bookmarkletSource", () => {
  it("targets the save page on this instance without embedding page content", () => {
    const source = bookmarkletSource("https://read.example/");
    expect(source.startsWith("javascript:")).toBe(true);
    expect(source).toContain('"https://read.example/entries/new"');
    expect(source).toContain("location.href");
    expect(source).not.toContain("document.cookie");
    expect(source).not.toContain("innerHTML");
  });

  it("keeps an unusual origin inside a string literal", () => {
    expect(bookmarkletSource('https://read.example/"+alert(1)+"')).toContain('\\"+alert(1)+\\"');
  });
});
