import { describe, expect, it } from "vitest";

import { matchesTaggingRule, parseTaggingRuleImport, validateTaggingRule } from "./rules";

const entry = {
  title: "A Practical Wallabag Guide",
  url: "https://example.com/guide",
  isArchived: false,
  isStarred: true,
  content: "This article discusses basketball and reading tools.",
  language: "en",
  mimetype: "text/html",
  readingTime: 4,
  domainName: "example.com",
};

describe("wallabag-compatible tagging rules", () => {
  it("supports comparisons, AND/OR precedence, and parentheses", () => {
    expect(matchesTaggingRule('readingTime <= 5 AND domainName = "example.com"', entry)).toBe(true);
    expect(matchesTaggingRule('readingTime > 10 OR isStarred = true AND language = "en"', entry)).toBe(true);
    expect(matchesTaggingRule('(readingTime > 10 OR isStarred = false) AND language = "en"', entry)).toBe(false);
  });

  it("covers wallabag's is and unary not operators", () => {
    expect(matchesTaggingRule("isStarred is true", entry)).toBe(true);
    expect(matchesTaggingRule("NOT isArchived = true", entry)).toBe(true);
    expect(matchesTaggingRule('not (language = "en" OR readingTime >= 10)', entry)).toBe(false);
  });

  it("implements case-insensitive matches and null-safe notmatches", () => {
    expect(matchesTaggingRule('title matches "WALLABAG"', entry)).toBe(true);
    expect(matchesTaggingRule('content notmatches "football"', entry)).toBe(true);
    expect(matchesTaggingRule('language notmatches "fr"', { ...entry, language: null })).toBe(true);
  });

  it("rejects unknown variables, functions, and malformed expressions", () => {
    expect(() => validateTaggingRule("unknownVar <= 3")).toThrow("Unknown rule variable");
    expect(() => validateTaggingRule("length(domainName) <= 42")).toThrow();
    expect(() => validateTaggingRule('title matches "unfinished')).toThrow("Unterminated string");
  });

  it("validates wallabag tagging-rule exports before importing any records", () => {
    expect(parseTaggingRuleImport([
      { rule: 'title matches "Guide"', tags: ["Reading", "reading", " Later "] },
    ])).toEqual([{ rule: 'title matches "Guide"', tags: ["reading", "later"] }]);
    expect(() => parseTaggingRuleImport({ rule: "isStarred = true", tags: ["favorite"] })).toThrow("JSON array");
    expect(() => parseTaggingRuleImport([{ rule: "unknown = true", tags: ["broken"] }])).toThrow("Unknown rule variable");
    expect(() => parseTaggingRuleImport([{ rule: "isStarred = true", tags: [] }])).toThrow("at least one tag");
  });
});
