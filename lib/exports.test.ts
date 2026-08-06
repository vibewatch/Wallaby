import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { JSDOM } from "jsdom";
import { PDFDocument } from "pdf-lib";

import { renderBinaryExport } from "./binary-exports";
import { renderExport } from "./exports";

const entry = {
  id: "entry-1",
  userId: "user-1",
  uid: "uid-1",
  title: 'A title, with "quotes"',
  url: "https://example.com/story?a=1&b=2",
  givenUrl: "https://example.com/story?a=1&b=2",
  urlHash: "hash",
  originUrl: null,
  content: "<p>Saved ]]> content</p>",
  summary: "Saved content",
  archived: false,
  archivedAt: null,
  starred: true,
  starredAt: new Date("2024-01-01T00:00:00Z"),
  publishedAt: null,
  publishedBy: [],
  mimeType: "text/html",
  language: "en",
  readingTime: 2,
  domainName: "example.com",
  previewPicture: null,
  httpStatus: 200,
  headers: {},
  isNotParsed: false,
  extractionError: null,
  shareToken: null,
  sharedAt: null,
  createdAt: new Date("2024-01-01T00:00:00Z"),
  updatedAt: new Date("2024-01-01T00:00:00Z"),
  tags: [{ id: "tag-1", userId: "user-1", label: "research", slug: "research", createdAt: new Date(), updatedAt: new Date() }],
  annotations: [],
};

describe("library exports", () => {
  it("produces round-trip JSON with wallabag field names", () => {
    const output = renderExport([entry] as never, "json");
    const parsed = JSON.parse(output.body);
    expect(parsed[0]).toMatchObject({ title: entry.title, is_archived: 0, is_starred: 1, reading_time: 2 });
  });

  it("escapes CSV and safely splits XML CDATA terminators", () => {
    expect(renderExport([entry] as never, "csv").body).toContain('"A title, with ""quotes"""');
    const xml = renderExport([entry] as never, "xml").body;
    expect(xml).toContain("https://example.com/story?a=1&amp;b=2");
    expect(xml).toContain("]]]]><![CDATA[>");
  });

  it("builds a standards-shaped EPUB with strict XHTML chapters", async () => {
    const multilingual = {
      ...entry,
      title: "A 中文 title",
      content: '<p>Hello &amp; 中文<br><img src="https://example.com/image.jpg?a=1&amp;b=2" alt="Cover"></p>',
    };
    const { body, contentType } = await renderBinaryExport([multilingual] as never, "epub");
    expect(contentType).toBe("application/epub+zip");
    expect(String.fromCharCode(...body.slice(0, 4))).toBe("PK\u0003\u0004");
    expect(body[8]).toBe(0);
    expect(body[9]).toBe(0);
    const filenameLength = body[26] | (body[27] << 8);
    expect(strFromU8(body.slice(30, 30 + filenameLength))).toBe("mimetype");

    const files = unzipSync(body);
    expect(strFromU8(files.mimetype)).toBe("application/epub+zip");
    expect(strFromU8(files["META-INF/container.xml"])).toContain("OEBPS/content.opf");
    expect(strFromU8(files["OEBPS/content.opf"])).toContain('properties="remote-resources"');
    expect(strFromU8(files["OEBPS/nav.xhtml"])).toContain("A 中文 title");
    const chapter = strFromU8(files["OEBPS/chapter-1.xhtml"]);
    expect(chapter).toContain("Hello &amp; 中文<br/>");
    expect(chapter).toContain("image.jpg?a=1&amp;b=2");
    expect(() => new JSDOM(chapter, { contentType: "application/xhtml+xml" })).not.toThrow();
  });

  it("builds a parseable, paginated multilingual PDF", async () => {
    const multilingual = {
      ...entry,
      title: "Portable 中文 العربية русский",
      content: `<p>${"Readable 中文 العربية русский 🙂 content. ".repeat(120)}</p>`,
    };
    const { body, contentType } = await renderBinaryExport([multilingual] as never, "pdf");
    expect(contentType).toBe("application/pdf");
    expect(strFromU8(body.slice(0, 5))).toBe("%PDF-");
    const pdf = await PDFDocument.load(body);
    expect(pdf.getTitle()).toBe(multilingual.title);
    expect(pdf.getPageCount()).toBeGreaterThan(1);
  });
});
