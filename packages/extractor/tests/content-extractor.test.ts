import { describe, expect, it } from "vitest";

import { ContentExtractor, parseSiteConfig } from "../src";

const articleText = `
  This is a substantial paragraph about durable personal knowledge systems. It contains enough prose for
  Readability to recognize it as the primary article rather than navigation or promotional chrome.
`.repeat(4);

describe("ContentExtractor", () => {
  it("skips non-node XPath results when a later selector can supply the content", () => {
    const config = parseSiteConfig("title: false()\ntitle: //h1\nbody: count(//article)\nbody: //article\nstrip: true()");
    const result = new ContentExtractor().process("<h1>Typed XPath results</h1><article><p>The later body rule still works.</p></article>", new URL("https://example.com/story"), config);

    expect(result.title).toBe("Typed XPath results");
    expect(result.html).toBe("<p>The later body rule still works.</p>");
    expect(result.isSuccess).toBe(true);
  });

  it("prefers site-config XPath rules and cleans the selected article", () => {
    const html = `<!doctype html><html lang="en"><head>
      <title>Fallback title</title>
      <meta property="og:title" content="OpenGraph title">
      <meta property="og:image" content="/cover.jpg">
    </head><body>
      <h1 class="headline">Configured title</h1>
      <div class="advert">Buy this</div>
      <article><p>${articleText}</p><img data-lazy-src="/photo.jpg"><a href="/more">More</a><script>alert(1)</script></article>
    </body></html>`;
    const config = parseSiteConfig(`
      title: //h1[@class='headline']
      body: //article
      strip_id_or_class: advert
      src_lazy_load_attr: data-lazy-src
      autodetect_on_failure: no
    `);

    const result = new ContentExtractor().process(html, new URL("https://example.com/story"), config);

    expect(result.title).toBe("Configured title");
    expect(result.image).toBe("https://example.com/cover.jpg");
    expect(result.html).toContain('src="https://example.com/photo.jpg"');
    expect(result.html).toContain('href="https://example.com/more"');
    expect(result.html).toContain('referrerpolicy="no-referrer"');
    expect(result.html).not.toContain("script");
    expect(result.isSuccess).toBe(true);
  });

  it("extracts JSON-LD metadata and falls back to Readability", () => {
    const html = `<!doctype html><html lang="de"><head>
      <script type="application/ld+json">${JSON.stringify({
        "@type": "NewsArticle",
        headline: "JSON-LD headline",
        author: [{ name: "Ada Reader" }, { name: "Lin Writer" }],
        datePublished: "2025-03-02T10:30:00Z",
        image: { url: "https://cdn.example.com/image.jpg" },
      })}</script>
    </head><body><main><article><h1>Page heading</h1><p>${articleText}</p></article></main></body></html>`;

    const result = new ContentExtractor().process(html, new URL("https://example.com/knowledge"));

    expect(result.title).toBe("JSON-LD headline");
    expect(result.authors).toEqual(["Ada Reader", "Lin Writer"]);
    expect(result.date).toBe("2025-03-02T10:30:00.000Z");
    expect(result.language).toBe("de");
    expect(result.html).toContain("durable personal knowledge systems");
  });

  it("supports footnote links without rewriting Wikipedia articles", () => {
    const config = parseSiteConfig("body: //article\nautodetect_on_failure: no");
    const html = `<html><body><article><p>${articleText}<a href="/source">Source material</a></p></article></body></html>`;
    const result = new ContentExtractor().process(html, new URL("https://example.com/story"), config, {
      contentLinks: "footnotes",
      rewriteRelativeUrls: true,
      imgNoReferrer: true,
    });
    expect(result.html).toContain("wallaby-footnote-ref");
    expect(result.html).toContain("https://example.com/source");
    expect(result.html).toContain("wallaby-footnotes");
  });
});
