import { describe, expect, it } from "vitest";

import { matchesIgnoreOriginRule, resolveRedirectUrl, validateIgnoreOriginRule } from "./ignore-origin";

describe("wallabag-compatible ignore-origin rules", () => {
  it("supports host equality and safe full-URL regular expressions", () => {
    expect(matchesIgnoreOriginRule('host = "feedproxy.google.com"', "https://feedproxy.google.com/story?id=1")).toBe(true);
    expect(matchesIgnoreOriginRule('_all ~ "https?://www\\.lemonde\\.fr/tiny.*"', "http://www.lemonde.fr/tiny/abc")).toBe(true);
    expect(matchesIgnoreOriginRule('host = "example.org"', "https://example.com/story")).toBe(false);
  });

  it("rejects unsupported variables, operators, malformed values, and unsafe regexes", () => {
    expect(() => validateIgnoreOriginRule('url = "https://example.com"')).toThrow("host or _all");
    expect(() => validateIgnoreOriginRule('host != "example.com"')).toThrow("host or _all");
    expect(() => validateIgnoreOriginRule("host = example.com")).toThrow("quoted");
    expect(() => validateIgnoreOriginRule('_all ~ "(a+)+$"')).toThrow("unsafe");
  });

  it("preserves an origin for substantive redirects unless a rule ignores it", () => {
    expect(resolveRedirectUrl("http://source.example/story", "https://publisher.example/article", null, [])).toEqual({
      url: "https://publisher.example/article",
      originUrl: "http://source.example/story",
      ignored: false,
    });
    expect(resolveRedirectUrl("http://source.example/story", "https://publisher.example/article", null, ['host = "source.example"'])).toEqual({
      url: "https://publisher.example/article",
      originUrl: null,
      ignored: true,
    });
  });

  it("does not record cosmetic scheme, fragment, or trailing-slash redirects", () => {
    expect(resolveRedirectUrl("http://example.com/story", "https://example.com/story", null, []).originUrl).toBeNull();
    expect(resolveRedirectUrl("https://example.com/story", "https://example.com/story#read", null, []).url).toBe("https://example.com/story");
    expect(resolveRedirectUrl("https://example.com/story", "https://example.com/story/", null, [])).toMatchObject({ url: "https://example.com/story/", originUrl: null });
  });
});
