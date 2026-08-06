import { join } from "node:path";

import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, it } from "vitest";

import { parseSiteConfig, ContentExtractor, SiteConfig } from "../src";
import { loadSiteConfigDirectory } from "../src/node";

// Validates the ENTIRE shipped 2,037-config corpus, not just its counts:
//  - every config parses without throwing
//  - structural invariants hold (find/replace pairing, header keys, wrap tags)
//  - the vast majority of XPath expressions are actually evaluable in JSDOM,
//    which is the same engine the extractor uses at runtime.
//
// A handful of upstream configs contain malformed or unsupported XPath. The
// extractor swallows those safely (evaluate() is wrapped in try/catch), so this
// test pins the KNOWN-BAD count: it fails if the corpus regresses (more broken
// expressions slip in) OR improves (so the allowance can be tightened).

const XPATH_FIELDS = [
  "title",
  "body",
  "author",
  "date",
  "strip",
  "native_ad_clue",
  "single_page_link",
  "next_page_link",
  "post_strip_attr",
] as const;

// The four upstream expressions JSDOM's XPath engine cannot evaluate today.
// Tracked explicitly so a corpus refresh that changes this set is caught here.
const KNOWN_UNEVALUABLE = 4;

let corpus: Record<string, string>;
let configs: Map<string, SiteConfig>;

beforeAll(() => {
  corpus = loadSiteConfigDirectory(join(process.cwd(), "packages", "extractor-site-config", "configs"));
  configs = new Map(Object.entries(corpus).map(([name, source]) => [name, parseSiteConfig(source)]));
});

describe("site-config corpus validity", () => {
  it("ships the full corpus with required anchors present", () => {
    expect(Object.keys(corpus)).toHaveLength(2_037);
    for (const required of ["global.txt", ".wikipedia.org.txt", ".wordpress.com.txt", "medium.com.txt"]) {
      expect(corpus).toHaveProperty(required);
    }
  });

  it("every config parses to a SiteConfig without throwing", () => {
    for (const [name, source] of Object.entries(corpus)) {
      expect(() => parseSiteConfig(source), name).not.toThrow();
    }
  });

  it("find_string and replace_string stay paired in every config", () => {
    for (const [name, config] of configs) {
      expect(config.find_string.length, name).toBe(config.replace_string.length);
    }
  });

  it("http_header keys are lowercase tokens and wrap_in tags are allowed", () => {
    for (const [name, config] of configs) {
      for (const key of Object.keys(config.http_header)) {
        expect(key, `${name}: header ${key}`).toMatch(/^[a-z0-9-]+$/);
      }
      for (const tag of Object.keys(config.wrap_in)) {
        expect(["blockquote", "p", "div"], `${name}: wrap_in(${tag})`).toContain(tag);
      }
    }
  });

  it("XPath expressions are evaluable except a small pinned allowance", () => {
    const document = new JSDOM("<html><body><article><h1>t</h1><p>p</p></article></body></html>").window.document;
    const anyType = document.defaultView!.XPathResult.ANY_TYPE;

    let total = 0;
    const unevaluable: string[] = [];
    for (const [name, config] of configs) {
      for (const field of XPATH_FIELDS) {
        for (const expression of config[field]) {
          total += 1;
          try {
            document.evaluate(expression, document, null, anyType, null);
          } catch {
            unevaluable.push(`${name} [${field}] ${expression}`);
          }
        }
      }
    }

    // Sanity: the corpus really does carry thousands of XPath rules.
    expect(total).toBeGreaterThan(8_000);
    // Pin the known-bad set; tighten this if the corpus is cleaned upstream.
    expect(unevaluable.length, unevaluable.join("\n")).toBeLessThanOrEqual(KNOWN_UNEVALUABLE);
    // >99.9% of the corpus must be evaluable.
    expect(unevaluable.length / total).toBeLessThan(0.001);
  });

  it("extraction tolerates a malformed XPath rule instead of crashing", () => {
    // Mirrors the real upstream typo in ruhlman.com.txt (`///span`). A broken
    // author/title rule must be skipped, not throw, and body must still extract.
    const config = parseSiteConfig("author: ///span[@class='author']\nbody: //article\nautodetect_on_failure: no");
    const html = `<html><body><article><p>${"Readable body content that must survive a broken author rule. ".repeat(6)}</p></article></body></html>`;

    const extractor = new ContentExtractor();
    const result = extractor.process(html, new URL("https://example.com/story"), config, {
      contentLinks: "preserve",
      rewriteRelativeUrls: true,
      imgNoReferrer: true,
    });

    expect(result.isSuccess).toBe(true);
    expect(result.html).toContain("Readable body content");
    expect(result.authors).toEqual([]);
  });
});
