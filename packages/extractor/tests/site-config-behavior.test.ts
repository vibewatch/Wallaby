import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ConfigBuilder, ContentExtractor } from "../src";
import { loadSiteConfigDirectory } from "../src/node";

// Load the REAL 2,037-config corpus once and drive extraction with it, proving
// that shipped configs actually select title/body and strip the right nodes —
// not just that they parse and count correctly.
const corpus = loadSiteConfigDirectory(join(process.cwd(), "packages", "extractor-site-config", "configs"));
const builder = new ConfigBuilder(corpus);
const extractor = new ContentExtractor();
const options = { contentLinks: "preserve" as const, rewriteRelativeUrls: true, imgNoReferrer: true };

const filler =
  "This is a substantial paragraph of genuine article prose that Readability and the site-config body rule should both recognize as the primary content of the page. ".repeat(6);

describe("real site configs drive extraction", () => {
  it("Wikipedia: selects #firstHeading title, #bodyContent body, and strips the TOC + editsection", () => {
    const config = builder.buildForHost("en.wikipedia.org");
    const html = `<!doctype html><html lang="en"><head><title>Wrong — browser tab title</title></head>
      <body>
        <h1 id="firstHeading">Christopher Lloyd</h1>
        <div id="bodyContent">
          <div id="toc"><ul><li>Table of contents that must be stripped</li></ul></div>
          <p>${filler}</p>
          <span class="editsection">[edit]</span>
          <p>Second real paragraph of the biography.</p>
        </div>
      </body></html>`;

    const result = extractor.process(html, new URL("https://en.wikipedia.org/wiki/Christopher_Lloyd"), config, options);

    expect(result.title).toBe("Christopher Lloyd");
    expect(result.html).toContain("genuine article prose");
    expect(result.html).toContain("Second real paragraph");
    expect(result.html).not.toContain("Table of contents that must be stripped");
    expect(result.html).not.toContain("[edit]");
    expect(result.isSuccess).toBe(true);
  });

  it("Medium: prefers og:title, extracts <article>, and strips <button>/<svg> chrome", () => {
    const config = builder.buildForHost("medium.com");
    const html = `<!doctype html><html><head>
        <meta property="og:title" content="Thirty things I've learned">
        <meta name="author" content="Ada Writer">
        <meta property="article:published_time" content="2024-05-01T09:00:00Z">
      </head><body>
        <article>
          <button aria-label="clap">Applaud</button>
          <svg><path d="M0 0"/></svg>
          <p>${filler}</p>
          <p>Remember you will die.</p>
        </article>
      </body></html>`;

    const result = extractor.process(html, new URL("https://medium.com/health-the-future/x"), config, options);

    expect(result.title).toBe("Thirty things I've learned");
    expect(result.authors).toContain("Ada Writer");
    expect(result.date).toBe("2024-05-01T09:00:00.000Z");
    expect(result.html).toContain("Remember you will die");
    expect(result.html).not.toContain("Applaud");
    expect(result.html).not.toContain("<svg");
  });

  it("global.txt fallback: reads og:title + article:published_time and converts <amp-img> to <img>", () => {
    // An unknown host inherits ONLY the global config (autodetect stays on).
    const config = builder.buildForHost("unknown-blog.example");
    const html = `<!doctype html><html><head>
        <meta property="og:title" content="Global OpenGraph Title">
        <meta property="article:published_time" content="2023-11-15T12:00:00Z">
      </head><body><article>
        <p>${filler}</p>
        <amp-img src="/photo.jpg" alt="a photo"></amp-img>
      </article></body></html>`;

    const result = extractor.process(html, new URL("https://unknown-blog.example/story"), config, options);

    expect(result.title).toBe("Global OpenGraph Title");
    expect(result.date).toBe("2023-11-15T12:00:00.000Z");
    // find_string/replace_string from global.txt rewrites amp-img -> img before parsing.
    expect(result.html).toContain("photo.jpg");
    expect(result.html).not.toContain("<amp-img");
  });

  it("wildcard config resolves for a subdomain (.wikipedia.org applies to fr.wikipedia.org)", () => {
    const config = builder.buildForHost("fr.wikipedia.org");
    expect(config.title).toContain("//h1[@id='firstHeading']");
    expect(config.body).toContain("//div[@id = 'bodyContent']");
  });
});
