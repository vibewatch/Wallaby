import { randomUUID } from "node:crypto";
import { mkdir, rm, unlink } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { JSDOM } from "jsdom";
import { PDFDocument } from "pdf-lib";
import sharp from "sharp";

import { captureArticleImages, readEntryImage, resolveMediaPath } from "./article-images";
import { renderBinaryExport } from "./binary-exports";
import { renderExport, type ExportEntry } from "./exports";

const mediaDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(mediaDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const entry: ExportEntry = {
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
  readingProgress: 0,
  readingProgressAt: null,
  createdAt: new Date("2024-01-01T00:00:00Z"),
  updatedAt: new Date("2024-01-01T00:00:00Z"),
  tags: [{ id: "tag-1", userId: "user-1", label: "research", slug: "research", createdAt: new Date(), updatedAt: new Date() }],
  annotations: [],
};

describe("library exports", () => {
  it("produces round-trip JSON with wallabag field names", () => {
    const output = renderExport([entry], "json");
    const parsed = JSON.parse(output.body);
    expect(parsed[0]).toMatchObject({ title: entry.title, is_archived: 0, is_starred: 1, reading_time: 2 });
  });

  it("escapes CSV and safely splits XML CDATA terminators", () => {
    expect(renderExport([entry], "csv").body).toContain('"A title, with ""quotes"""');
    const xml = renderExport([entry], "xml").body;
    expect(xml).toContain("https://example.com/story?a=1&amp;b=2");
    expect(xml).toContain("]]]]><![CDATA[>");
  });

  it("builds a standards-shaped EPUB with strict XHTML chapters", async () => {
    const multilingual = {
      ...entry,
      title: "A 中文 title",
      content: '<p>Hello &amp; 中文<br><img src="https://example.com/image.jpg?a=1&amp;b=2" alt="Cover"></p>',
    };
    const { body, contentType } = await renderBinaryExport([multilingual], "epub");
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

  it.each(["png", "jpeg", "gif"] as const)("embeds a locally captured %s diagram in the EPUB chapter and manifest", async (format) => {
    const captured = await captureEpubEntry(format);
    const { body } = await renderBinaryExport([captured], "epub");
    const files = unzipSync(body);
    const chapter = new JSDOM(strFromU8(files["OEBPS/chapter-1.xhtml"]), { contentType: "application/xhtml+xml" }).window.document;
    const image = chapter.querySelector(".entry-content img");
    expect(image).not.toBeNull();
    expect(image?.getAttribute("alt")).toBe("A & B");
    const source = image!.getAttribute("src")!;
    expect(source).not.toMatch(/^(?:\/|https?:)/);
    expect(files[`OEBPS/${source}`]).toEqual(new Uint8Array(await readEntryImage(captured.images[0].relativePath)));
    const manifest = new JSDOM(strFromU8(files["OEBPS/content.opf"]), { contentType: "application/xml" }).window.document;
    expect(manifest.querySelector(`item[href="${source}"]`)?.getAttribute("media-type")).toBe(`image/${format}`);
    expect(manifest.querySelector('item[href="chapter-1.xhtml"]')?.hasAttribute("properties")).toBe(false);
  });

  it.each(["webp", "avif"] as const)("converts a captured %s image to EPUB-compatible PNG", async (format) => {
    const captured = await captureEpubEntry(format);
    expect(captured.images[0].contentType).toBe(`image/${format}`);

    const { body } = await renderBinaryExport([captured], "epub");
    const files = unzipSync(body);
    const chapter = new JSDOM(strFromU8(files["OEBPS/chapter-1.xhtml"]), { contentType: "application/xhtml+xml" }).window.document;
    const source = chapter.querySelector("img")!.getAttribute("src")!;
    const manifest = new JSDOM(strFromU8(files["OEBPS/content.opf"]), { contentType: "application/xml" }).window.document;
    expect(manifest.querySelector(`item[href="${source}"]`)?.getAttribute("media-type")).toBe("image/png");
    expect(await sharp(files[`OEBPS/${source}`]).metadata()).toMatchObject({ format: "png", width: 3, height: 2 });
  });

  it("bundles repeated local images once, ignores unused records, and keeps remote images remote", async () => {
    const captured = await captureEpubEntry("png");
    const remote = "https://example.com/remote.png?a=1&b=2";
    captured.content += captured.content + '<img src="https://example.com/remote.png?a=1&amp;b=2" alt="Remote">';
    captured.images.push({ ...captured.images[0], id: randomUUID(), relativePath: "../unused-image.png" });

    const files = unzipSync((await renderBinaryExport([captured], "epub")).body);
    const chapter = new JSDOM(strFromU8(files["OEBPS/chapter-1.xhtml"]), { contentType: "application/xhtml+xml" }).window.document;
    const sources = [...chapter.querySelectorAll("img")].map((image) => image.getAttribute("src"));
    expect(sources).toHaveLength(3);
    expect(sources[0]).toBe(sources[1]);
    expect(sources[2]).toBe(remote);
    const manifest = new JSDOM(strFromU8(files["OEBPS/content.opf"]), { contentType: "application/xml" }).window.document;
    expect(manifest.querySelectorAll('item[media-type="image/png"]')).toHaveLength(1);
    expect(manifest.querySelector('item[href="chapter-1.xhtml"]')?.getAttribute("properties")).toBe("remote-resources");
  });

  it("keeps each chapter's embedded images and manifest identifiers distinct", async () => {
    const first = await captureEpubEntry("png");
    const second = await captureEpubEntry("jpeg", { id: "entry-2" }, process.env.WALLABY_MEDIA_DIR);
    const files = unzipSync((await renderBinaryExport([first, second], "epub")).body);
    const sources: string[] = [];
    for (const [index, saved] of [first, second].entries()) {
      const chapter = new JSDOM(strFromU8(files[`OEBPS/chapter-${index + 1}.xhtml`]), { contentType: "application/xhtml+xml" }).window.document;
      const source = chapter.querySelector("img")!.getAttribute("src")!;
      sources.push(source);
      expect(files[`OEBPS/${source}`]).toEqual(new Uint8Array(await readEntryImage(saved.images[0].relativePath)));
    }
    expect(new Set(sources).size).toBe(2);
    const manifest = new JSDOM(strFromU8(files["OEBPS/content.opf"]), { contentType: "application/xml" }).window.document;
    const items = [...manifest.querySelectorAll("manifest > item")];
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
    for (const item of items) expect(files[`OEBPS/${item.getAttribute("href")}`]).toBeDefined();
    for (const reference of manifest.querySelectorAll("spine > itemref")) {
      expect(items.some((item) => item.id === reference.getAttribute("idref"))).toBe(true);
    }
  });

  it.each([
    { userId: "another-reader" },
    { entryId: "another-entry" },
  ])("refuses a local image record outside the exporting entry: %j", async (otherOwner) => {
    const captured = await captureEpubEntry("png");
    captured.images = captured.images.map((image) => ({ ...image, ...otherOwner }));
    await expect(renderBinaryExport([captured], "epub")).rejects.toThrow("saved image not found");
  });

  it("reports a missing local image record instead of silently removing the diagram", async () => {
    const saved = { ...entry, content: `<img src="/media/${randomUUID()}" alt="Diagram">` };
    await expect(renderBinaryExport([saved], "epub")).rejects.toThrow("saved image not found");
  });

  it("reports a missing local image file instead of producing an incomplete EPUB", async () => {
    const captured = await captureEpubEntry("png");
    await unlink(resolveMediaPath(captured.images[0].relativePath));
    await expect(renderBinaryExport([captured], "epub")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a referenced image path outside the configured media directory", async () => {
    const captured = await captureEpubEntry("png");
    captured.images[0].relativePath = "../outside-image.png";
    await expect(renderBinaryExport([captured], "epub")).rejects.toThrow("Invalid media path");
  });

  it("still builds a valid empty EPUB without image records", async () => {
    const files = unzipSync((await renderBinaryExport([], "epub")).body);
    for (const name of ["META-INF/container.xml", "OEBPS/content.opf", "OEBPS/nav.xhtml", "OEBPS/empty.xhtml"]) {
      expect(() => new JSDOM(strFromU8(files[name]), { contentType: "application/xml" })).not.toThrow();
    }
    expect(strFromU8(files["OEBPS/empty.xhtml"])).toContain("No saved entries");
  });

  // Embedding CJK, Arabic, and Cyrillic faces and paginating them takes a few
  // seconds on its own, which leaves no room under the 5s default once the rest
  // of the suite is competing for cores.
  it("builds a parseable, paginated multilingual PDF", { timeout: 30_000 }, async () => {
    const multilingual = {
      ...entry,
      title: "Portable 中文 العربية русский",
      content: `<p>${"Readable 中文 العربية русский 🙂 content. ".repeat(120)}</p>`,
    };
    const { body, contentType } = await renderBinaryExport([multilingual], "pdf");
    expect(contentType).toBe("application/pdf");
    expect(strFromU8(body.slice(0, 5))).toBe("%PDF-");
    const pdf = await PDFDocument.load(body);
    expect(pdf.getTitle()).toBe(multilingual.title);
    expect(pdf.getPageCount()).toBeGreaterThan(1);
  });
});

async function captureEpubEntry(format: "png" | "jpeg" | "gif" | "webp" | "avif", overrides: Partial<ExportEntry> = {}, mediaRoot?: string) {
  if (!mediaRoot) {
    mediaRoot = join(process.cwd(), `.wallaby-epub-test-${randomUUID()}`);
    await mkdir(mediaRoot);
    mediaDirectories.push(mediaRoot);
  }
  vi.stubEnv("WALLABY_MEDIA_DIR", mediaRoot);
  const saved = { ...entry, content: '<p><img src="https://example.com/diagram" alt="A &amp; B"></p>', ...overrides };
  const bytes = await sharp({ create: { width: 3, height: 2, channels: 4, background: "#315d50" } }).toFormat(format).toBuffer();
  const contentType = `image/${format}`;
  const captured = await captureArticleImages({
    userId: saved.userId,
    entryId: saved.id,
    baseUrl: saved.url,
    html: saved.content,
    mediaRoot,
    fetcher: {
      async fetch(url) {
        return { body: "", bytes, url: url.toString(), status: 200, headers: { "content-type": contentType }, mimeType: contentType };
      },
    },
  });
  expect(captured.images).toHaveLength(1);
  return { ...saved, content: captured.html, images: captured.images };
}
