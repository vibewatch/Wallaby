import { describe, expect, it } from "vitest";

import { ContentExtractor, Extractor, parseSiteConfig, removeTrackers, type Fetcher } from "../src";

const articleText = `
  This is a substantial paragraph about durable personal knowledge systems. It contains enough prose for
  Readability to recognize it as the primary article rather than navigation or promotional chrome.
`.repeat(4);

function htmlResponse(url: URL, body: string, headers: Record<string, string> = {}) {
  return {
    body,
    url: url.toString(),
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
    mimeType: "text/html",
  };
}

describe("Extractor extraction-contract parity", () => {
  it("autodetects hNews entry-title, entry-content, published date, and vcard author", () => {
    const html = `<!doctype html><html><body>
      <div class="hentry">
        <h2 class="entry-title">hNews title</h2>
        <span class="vcard author"><span class="fn">Grace Byline</span></span>
        <abbr class="published">2024-01-02T00:00:00Z</abbr>
        <div class="entry-content"><p>${articleText}</p></div>
      </div>
    </body></html>`;
    const result = new ContentExtractor().process(html, new URL("https://example.com/story"));
    expect(result.title).toBe("hNews title");
    expect(result.authors).toEqual(["Grace Byline"]);
    expect(result.date).toBe("2024-01-02T00:00:00.000Z");
    expect(result.html).toContain("durable personal knowledge systems");
  });

  it("autodetects instapaper_body and meta author", () => {
    const html = `<!doctype html><html><body>
      <meta name="author" content="Meta Author">
      <div class="instapaper_body"><p>${articleText}</p></div>
    </body></html>`;
    const result = new ContentExtractor().process(html, new URL("https://example.com/story"));
    expect(result.authors).toContain("Meta Author");
    expect(result.html).toContain("durable personal knowledge systems");
  });

  it("promotes data-srcset lazy attributes to srcset", () => {
    const html = `<!doctype html><html><body><article><p>${articleText}</p>
      <img data-srcset="/small.jpg 480w, /large.jpg 1080w"></article></body></html>`;
    const config = parseSiteConfig("body: //article\nautodetect_on_failure: no");
    const result = new ContentExtractor().process(html, new URL("https://example.com/story"), config);
    expect(result.html).toContain("srcset=");
    expect(result.html).toContain("https://example.com/large.jpg");
  });

  it("restores the WordPress lazy-load noscript image", () => {
    const html = `<!doctype html><html><body><article><p>${articleText}</p>
      <img src="data:image/gif;base64,x" data-lazy-src="/lazy.jpg"><noscript><img src="/real.jpg"></noscript>
      </article></body></html>`;
    const config = parseSiteConfig("body: //article\nautodetect_on_failure: no");
    const result = new ContentExtractor().process(html, new URL("https://example.com/story"), config);
    expect(result.html).toContain("https://example.com/real.jpg");
    expect(result.html).not.toContain("data:image");
  });

  it("removes a leading heading that duplicates the title", () => {
    const html = `<!doctype html><html><body>
      <h1 class="headline">Duplicate heading</h1>
      <article><h1>Duplicate heading</h1><p>${articleText}</p></article></body></html>`;
    const config = parseSiteConfig("title: //h1[@class='headline']\nbody: //article\nautodetect_on_failure: no");
    const result = new ContentExtractor().process(html, new URL("https://example.com/story"), config);
    expect(result.title).toBe("Duplicate heading");
    expect(result.html).not.toContain("<h1>Duplicate heading</h1>");
  });

  it("ignores JSON-LD types on the ignore list", () => {
    const html = `<!doctype html><html><head>
      <script type="application/ld+json">${JSON.stringify({ "@type": "WebSite", name: "Site name" })}</script>
      <script type="application/ld+json">${JSON.stringify({ "@type": "NewsArticle", headline: "Real headline" })}</script>
    </head><body><article><p>${articleText}</p></article></body></html>`;
    const result = new ContentExtractor().process(html, new URL("https://example.com/story"));
    expect(result.title).toBe("Real headline");
  });

  it("removes utm_/mtm_ tracker params and xtor=RSS fragment", () => {
    expect(removeTrackers("https://example.com/a?utm_source=x&id=7&mtm_campaign=y#xtor=RSS-1")).toBe("https://example.com/a?id=7");
    expect(removeTrackers("https://example.com/a?keep=1")).toBe("https://example.com/a?keep=1");
  });

  it("falls back to the Content-Language header when no language is extracted", async () => {
    const fetcher: Fetcher = {
      async fetch(url) {
        return htmlResponse(url, `<html><body><article><p>${articleText}</p></article></body></html>`, { "content-language": "fr-FR" });
      },
    };
    const extractor = new Extractor({ fetcher, siteConfigs: { "example.com.txt": "body: //article\nautodetect_on_failure: no" } });
    const content = await extractor.fetchContent("https://example.com/story");
    expect(content.language).toBe("fr-FR");
  });

  it("rejects blocked URLs and honors an allowlist", async () => {
    const fetcher: Fetcher = { async fetch(url) { return htmlResponse(url, `<article><p>${articleText}</p></article>`); } };
    await expect(new Extractor({ fetcher, blockedUrls: ["blocked.example"] }).fetchContent("https://blocked.example/x")).rejects.toThrow(/not allowed/);
    await expect(new Extractor({ fetcher, allowedUrls: ["allowed.example"] }).fetchContent("https://other.example/x")).rejects.toThrow(/not allowed/);
  });

  it("can disable the XSS filter", async () => {
    const config = parseSiteConfig("body: //article\nautodetect_on_failure: no");
    const html = `<html><body><article><p>${articleText}</p><div data-keep="1">kept</div></article></body></html>`;
    const result = new ContentExtractor().process(html, new URL("https://example.com/story"), config, {
      contentLinks: "preserve",
      rewriteRelativeUrls: true,
      imgNoReferrer: true,
      xssFilter: false,
    });
    expect(result.html).toContain('data-keep="1"');
  });
});
