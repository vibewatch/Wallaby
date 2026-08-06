import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";

import { Extractor, type Fetcher, type FetchRequestOptions } from "../src";

describe("Extractor", () => {
  it("returns wallabag-ready content through an injectable transport", async () => {
    const fetcher: Fetcher = {
      async fetch() {
        return {
          body: `<html><head><meta property="og:title" content="Transport title"></head><body><article><p>${"Readable content. ".repeat(80)}</p></article></body></html>`,
          url: "https://example.com/final",
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
          mimeType: "text/html",
        };
      },
    };

    const content = await new Extractor({ fetcher }).fetchContent("example.com/article");

    expect(content.title).toBe("Transport title");
    expect(content.url).toBe("https://example.com/final");
    expect(content.status).toBe(200);
    expect(content.isNotParsed).toBe(false);
    expect(content.summary.length).toBeGreaterThan(20);
  });

  it("supports Extractor's prefetched-content path", async () => {
    const extractor = new Extractor();
    extractor.setContentAsPrefetched(`<html><head><title>Prefetched</title></head><body><article><h1>Prefetched</h1><p>${"Offline article. ".repeat(80)}</p></article></body></html>`);
    const content = await extractor.fetchContent("https://example.com/offline");

    expect(content.title).toContain("Prefetched");
    expect(content.html).toContain("Offline article");
  });

  it("uses a fingerprint site config when the requested host has no exact config", async () => {
    const fetcher: Fetcher = {
      async fetch(url) {
        return htmlResponse(url, `<html><head><meta name="generator" content="WordPress 7"></head><body><nav>${"Noise ".repeat(80)}</nav><main id="wordpress-story"><p>${"Fingerprint story. ".repeat(60)}</p></main></body></html>`);
      },
    };
    const extractor = new Extractor({
      fetcher,
      fingerprints: { "<meta[^>]+generator[^>]+WordPress": "fingerprint.wordpress.com" },
      siteConfigs: {
        "fingerprint.wordpress.com.txt": "body: //main[@id='wordpress-story']\nautodetect_on_failure: no",
      },
    });

    const content = await extractor.fetchContent("https://unknown.example/story");
    expect(content.html).toContain("Fingerprint story");
    expect(content.html).not.toContain("Noise");
  });

  it("follows a configured single-page link before returning the article", async () => {
    const fetcher: Fetcher = {
      async fetch(url) {
        if (url.pathname === "/print") return htmlResponse(url, `<html><head><title>Complete version</title></head><body><article><p>${"Complete single-page text. ".repeat(60)}</p></article></body></html>`);
        return htmlResponse(url, `<html><head><title>Teaser</title></head><body><article><p>Short teaser.</p></article><a class="print" href="/print">Print</a></body></html>`);
      },
    };
    const extractor = new Extractor({
      fetcher,
      siteConfigs: { "example.com.txt": "body: //article\nsingle_page_link: //a[@class='print']" },
    });

    const content = await extractor.fetchContent("https://example.com/story");
    expect(content.url).toBe("https://example.com/print");
    expect(content.html).toContain("Complete single-page text");
    expect(content.html).not.toContain("Short teaser");
  });

  it("concatenates configured next pages and stops on a loop", async () => {
    const calls: string[] = [];
    const fetcher: Fetcher = {
      async fetch(url) {
        calls.push(url.pathname);
        const page = Number(url.searchParams.get("page") ?? 1);
        const nextLink = page < 3 ? `<a rel="next" href="?page=${page + 1}">Next</a>` : "";
        return htmlResponse(url, `<html><head><title>Series</title></head><body><article><p>${`Page ${page} chapter. `.repeat(50)}</p></article>${nextLink}</body></html>`);
      },
    };
    const extractor = new Extractor({
      fetcher,
      maxPages: 6,
      siteConfigs: { "example.com.txt": "body: //article\nnext_page_link: //a[@rel='next']" },
    });

    const content = await extractor.fetchContent("https://example.com/series?page=1");
    expect(content.html).toContain("Page 1 chapter");
    expect(content.html).toContain("Page 2 chapter");
    expect(content.html).toContain("Page 3 chapter");
    expect(content.html.match(/wallaby-page-break/g)).toHaveLength(2);
    expect(calls).toEqual(["/series", "/series", "/series"]);
  });

  it("discards partial multi-page content and appends a notice when the walk is interrupted", async () => {
    const fetcher: Fetcher = {
      async fetch(url) {
        const page = Number(url.searchParams.get("page") ?? 1);
        // Every page links to the next, so the walk hits the maxPages ceiling and is interrupted.
        return htmlResponse(url, `<html><head><title>Endless</title></head><body><article><p>${`Page ${page} chapter. `.repeat(50)}</p></article><a rel="next" href="?page=${page + 1}">Next</a></body></html>`);
      },
    };
    const extractor = new Extractor({
      fetcher,
      maxPages: 3,
      siteConfigs: { "example.com.txt": "body: //article\nnext_page_link: //a[@rel='next']" },
    });

    const content = await extractor.fetchContent("https://example.com/series?page=1");
    expect(content.html).toContain("Page 1 chapter");
    expect(content.html).toContain("could not extract");
    expect(content.html).not.toContain("Page 3 chapter");
  });

  it("logs in with site-config fields and carries cookies to the article request", async () => {
    const requests: { url: string; request?: FetchRequestOptions }[] = [];
    const fetcher: Fetcher = {
      async fetch(url, _headers, request) {
        requests.push({ url: url.toString(), request });
        if (url.pathname === "/session") {
          expect(request?.method).toBe("POST");
          expect(request?.body).toContain("account=reader%40example.com");
          expect(request?.body).toContain("secret=correct-horse");
          expect(request?.body).toContain("remember=yes");
          return { ...htmlResponse(url, "logged in"), setCookies: ["session=abc123"] };
        }
        expect(request?.cookies).toContain("session=abc123");
        return htmlResponse(url, `<html><head><title>Private</title></head><body><article><p>${"Private article. ".repeat(70)}</p></article></body></html>`);
      },
    };
    const extractor = new Extractor({
      fetcher,
      siteConfigs: {
        "private.example.txt": [
          "requires_login: yes",
          "login_uri: /session",
          "login_username_field: account",
          "login_password_field: secret",
          "login_extra_fields: remember=yes",
          "body: //article",
        ].join("\n"),
      },
    });

    const content = await extractor.fetchContent(
      "https://private.example/story",
      undefined,
      { username: "reader@example.com", password: "correct-horse" },
    );
    expect(content.html).toContain("Private article");
    expect(requests.map(({ url }) => new URL(url).pathname)).toEqual(["/session", "/story"]);
  });

  it("evaluates wallabag login expressions for dynamic form fields", async () => {
    const requests: { path: string; request?: FetchRequestOptions }[] = [];
    const fetcher: Fetcher = {
      async fetch(url, _headers, request) {
        requests.push({ path: url.pathname, request });
        if (url.pathname === "/session" && request?.method !== "POST") {
          return htmlResponse(url, '<form><input name="csrf" value="xpath-token"></form>');
        }
        if (url.pathname === "/nonce") {
          return htmlResponse(url, '<script>window.config={"security":"regex-token"}</script>');
        }
        if (url.pathname === "/session") {
          expect(request?.body).toContain("csrf=xpath-token");
          expect(request?.body).toContain("security=regex-token");
          return { ...htmlResponse(url, "logged in"), setCookies: ["session=dynamic"] };
        }
        expect(request?.cookies).toContain("session=dynamic");
        return htmlResponse(url, `<article><p>${"Authenticated expression content. ".repeat(60)}</p></article>`);
      },
    };
    const extractor = new Extractor({
      fetcher,
      siteConfigs: {
        "private.example.txt": [
          "requires_login: yes",
          "login_uri: /session",
          "login_username_field: account",
          "login_password_field: secret",
          "login_extra_fields: csrf=@=xpath('//input[@name=\"csrf\"]/@value', request_html(config.getLoginUri()))",
          "login_extra_fields: security=@=preg_match('/security\\\":\\\"([a-z-]+)\\\"/si', request_html('https://private.example/nonce'))",
          "body: //article",
        ].join("\n"),
      },
    });

    const content = await extractor.fetchContent("https://private.example/story", undefined, { username: "reader", password: "secret" });
    expect(content.html).toContain("Authenticated expression content");
    expect(requests.map(({ path }) => path)).toEqual(["/session", "/nonce", "/session", "/story"]);
  });

  it("extracts PDF text, title, author, and creation date", async () => {
    const pdf = await PDFDocument.create();
    pdf.setTitle("A portable PDF story");
    pdf.setAuthor("Ada Reader");
    pdf.setCreationDate(new Date("2024-03-02T10:20:30Z"));
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const page = pdf.addPage();
    page.drawText("Extracted PDF article text for offline reading.", { x: 50, y: 700, size: 14, font });
    const bytes = await pdf.save();
    const fetcher: Fetcher = {
      async fetch(url) {
        return {
          body: "",
          bytes,
          url: url.toString(),
          status: 200,
          headers: { "content-type": "application/pdf" },
          mimeType: "application/pdf",
        };
      },
    };

    const content = await new Extractor({ fetcher }).fetchContent("https://example.com/story.pdf");
    expect(content.title).toBe("A portable PDF story");
    expect(content.authors).toEqual(["Ada Reader"]);
    expect(content.date).toBe("2024-03-02T10:20:30.000Z");
    expect(content.html).toContain("Extracted PDF article text");
    expect(content.mimeType).toBe("application/pdf");
    expect(content.isNotParsed).toBe(false);
  });

  it.each([
    ["application/zip", "ZIP", "Download ZIP"],
    ["audio/mpeg", "Audio", "Download Audio"],
    ["video/mp4", "Video", "Download Video"],
  ])("uses default MIME actions for %s", async (mimeType, title, linkText) => {
    const content = await new Extractor({ fetcher: mimeResponse(mimeType) }).fetchContent("https://example.com/asset");

    expect(content.title).toBe(title);
    expect(content.html).toBe(`<a href="https://example.com/asset">${linkText}</a>`);
    expect(content.mimeType).toBe(mimeType);
    expect(content.isNotParsed).toBe(false);
  });

  it("prefers a full MIME action over its top-level fallback", async () => {
    const extractor = new Extractor({
      fetcher: mimeResponse("image/svg+xml"),
      contentTypeActions: {
        image: { action: "link", name: "Picture" },
        "image/svg+xml": { action: "link", name: "Vector" },
      },
    });

    const content = await extractor.fetchContent("https://example.com/art.svg");
    expect(content.title).toBe("Vector");
    expect(content.html).toContain('alt="Vector"');
    expect(content.image).toBe("https://example.com/art.svg");
  });

  it("supports custom link names without allowing HTML injection", async () => {
    const extractor = new Extractor({
      fetcher: mimeResponse("application/vnd.example"),
      contentTypeActions: {
        "application/vnd.example": { action: "link", name: '<Custom & "safe">' },
      },
    });

    const content = await extractor.fetchContent("https://example.com/custom.bin");
    expect(content.title).toBe('<Custom & "safe">');
    expect(content.html).toBe('<a href="https://example.com/custom.bin">Download &lt;Custom &amp; &quot;safe&quot;&gt;</a>');
  });

  it("rejects a MIME type configured for exclusion", async () => {
    const extractor = new Extractor({
      fetcher: mimeResponse("application/x-msdownload"),
      contentTypeActions: {
        "application/x-msdownload": { action: "exclude", name: "Executable" },
      },
    });

    await expect(extractor.fetchContent("https://example.com/virus.exe")).rejects.toThrow(
      'The URL "https://example.com/virus.exe" is blocked by its MIME action.',
    );
  });

  it("keeps the specialized plain-text path behind the MIME action matrix", async () => {
    const fetcher = mimeResponse("text/plain", '<unsafe> & "readable"');
    const content = await new Extractor({ fetcher }).fetchContent("https://example.com/note.txt");

    expect(content.title).toBe("Plain text");
    expect(content.html).toBe("<pre>&lt;unsafe&gt; &amp; &quot;readable&quot;</pre>");
  });

  it("emits structured diagnostics without credential values", async () => {
    const events: { level: string; message: string; context?: Record<string, unknown> }[] = [];
    const logger = Object.fromEntries(["debug", "info", "warn", "error"].map((level) => [level, (message: string, context?: Record<string, unknown>) => events.push({ level, message, context })])) as never;
    const fetcher: Fetcher = {
      async fetch(url, _headers, request) {
        if (url.pathname === "/login") return { ...htmlResponse(url, "ok"), setCookies: ["session=redacted"] };
        expect(request?.cookies).toContain("session=redacted");
        return htmlResponse(url, `<article><p>${"Logged article. ".repeat(60)}</p></article>`);
      },
    };
    const extractor = new Extractor({
      fetcher,
      logger,
      siteConfigs: { "private.example.txt": "requires_login: yes\nlogin_uri: /login\nlogin_username_field: user\nlogin_password_field: pass\nbody: //article" },
    });
    await extractor.fetchContent("https://private.example/story", undefined, { username: "sensitive-user", password: "sensitive-password" });
    expect(events.map(({ message }) => message)).toEqual(expect.arrayContaining(["extractor.fetch.start", "extractor.login.start", "extractor.login.complete", "extractor.fetch.complete"]));
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("sensitive-user");
    expect(serialized).not.toContain("sensitive-password");
    expect(serialized).not.toContain("session=redacted");
  });
});

function htmlResponse(url: URL, body: string) {
  return {
    body,
    url: url.toString(),
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    mimeType: "text/html",
  };
}

function mimeResponse(mimeType: string, body = ""): Fetcher {
  return {
    async fetch(url) {
      return {
        body,
        url: url.toString(),
        status: 200,
        headers: { "content-type": mimeType },
        mimeType,
      };
    },
  };
}
