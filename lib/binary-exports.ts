import fontkit from "@pdf-lib/fontkit";
import type { EntryImage } from "@prisma/client";
import { strToU8, zipSync } from "fflate";
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PDFDocument, type PDFFont, type PDFPage, rgb } from "pdf-lib";
import sharp from "sharp";

import { readEntryImage } from "@/lib/article-images";
import type { ExportEntry } from "@/lib/exports";

export type BinaryExportFormat = "epub" | "pdf";
export type BinaryExportEntry = ExportEntry & {
  images?: Pick<EntryImage, "id" | "userId" | "entryId" | "contentType" | "relativePath">[];
};

type BinaryExport = { body: Uint8Array; contentType: string };
type EpubImage = { id: string; filename: string; contentType: string; bytes: Uint8Array };

const fontPath = join(process.cwd(), "node_modules", "@fontsource", "unifont", "files", "unifont-latin-400-normal.woff2");
let fontBytesPromise: Promise<Uint8Array> | undefined;

const EPUB_STYLE = `
body { color: #20231f; font-family: sans-serif; line-height: 1.65; margin: 5%; }
a { color: #315d50; }
img, video { height: auto; max-width: 100%; }
.entry-meta { border-bottom: 1px solid #c9cec6; color: #59635d; font-size: .85em; margin-bottom: 2em; padding-bottom: 1em; }
.entry-meta p { margin: .3em 0; }
pre { overflow-wrap: anywhere; white-space: pre-wrap; }
table { border-collapse: collapse; max-width: 100%; }
td, th { border: 1px solid #c9cec6; padding: .35em; }
`.trim();

const EPUB_TAGS = new Set([
  "a", "abbr", "address", "article", "aside", "b", "blockquote", "br", "caption", "cite", "code", "dd", "del", "details",
  "dfn", "div", "dl", "dt", "em", "figcaption", "figure", "footer", "h1", "h2", "h3", "h4", "h5", "h6", "header",
  "hr", "i", "img", "ins", "kbd", "li", "main", "mark", "nav", "ol", "p", "pre", "q", "s", "samp", "section", "small",
  "span", "strong", "sub", "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time", "tr", "u", "ul", "var",
]);
const EPUB_VOID_TAGS = new Set(["br", "hr", "img"]);
const EPUB_IMAGE_EXTENSIONS = new Map([["image/png", "png"], ["image/jpeg", "jpg"], ["image/gif", "gif"]]);
const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "dd", "details", "div", "dl", "dt", "figcaption", "figure", "footer", "h1", "h2",
  "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "summary", "table", "tr", "ul",
]);
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

export async function renderBinaryExport(entries: BinaryExportEntry[], format: BinaryExportFormat): Promise<BinaryExport> {
  if (format === "epub") return { body: await renderEpub(entries), contentType: "application/epub+zip" };
  return { body: await renderPdf(entries), contentType: "application/pdf" };
}

export async function renderEpub(entries: BinaryExportEntry[]): Promise<Uint8Array> {
  const chapters = [];
  for (const [index, entry] of entries.entries()) chapters.push(await renderEpubChapter(entry, index + 1));
  if (!chapters.length) chapters.push({ id: "empty", filename: "empty.xhtml", title: "No saved entries", remoteResources: false, body: emptyChapter(), images: [] });
  const title = entries.length === 1 ? entries[0].title : `Wallaby library (${entries.length} entries)`;
  const modified = latestUpdatedAt(entries).toISOString().replace(/\.\d{3}Z$/, "Z");
  const identifier = entries.length === 1 ? `urn:wallaby:entry:${entries[0].id}` : `urn:wallaby:library:${entries.map(({ id }) => id).join("-") || "empty"}`;
  const language = commonLanguage(entries);
  const creators = [...new Set(entries.flatMap(entryAuthors))].slice(0, 100);

  const manifest = chapters.flatMap((chapter) => [
    `<item id="${chapter.id}" href="${chapter.filename}" media-type="application/xhtml+xml"${chapter.remoteResources ? ' properties="remote-resources"' : ""}/>`,
    ...chapter.images.map((image) => `<item id="${image.id}" href="${image.filename}" media-type="${image.contentType}"/>`),
  ]).join("\n    ");
  const spine = chapters.map((chapter) => `<itemref idref="${chapter.id}"/>`).join("\n    ");
  const creatorMetadata = creators.map((creator) => `<dc:creator>${xml(creator)}</dc:creator>`).join("\n    ");
  const navigation = chapters.map((chapter) => `<li><a href="${chapter.filename}">${xml(chapter.title)}</a></li>`).join("\n        ");

  const files: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = {
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`),
    "OEBPS/content.opf": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="publication-id" xml:lang="${xml(language)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="publication-id">${xml(identifier)}</dc:identifier>
    <dc:title>${xml(title)}</dc:title>
    <dc:language>${xml(language)}</dc:language>
    ${creatorMetadata}
    <dc:publisher>Wallaby</dc:publisher>
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="css" href="styles.css" media-type="text/css"/>
    ${manifest}
  </manifest>
  <spine>
    ${spine}
  </spine>
</package>`),
    "OEBPS/nav.xhtml": strToU8(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${xml(language)}" lang="${xml(language)}">
  <head><title>${xml(title)}</title><link rel="stylesheet" type="text/css" href="styles.css"/></head>
  <body><nav epub:type="toc" xmlns:epub="http://www.idpf.org/2007/ops"><h1>Contents</h1><ol>
        ${navigation}
  </ol></nav></body>
</html>`),
    "OEBPS/styles.css": strToU8(EPUB_STYLE),
  };
  for (const chapter of chapters) {
    files[`OEBPS/${chapter.filename}`] = strToU8(chapter.body);
    for (const image of chapter.images) files[`OEBPS/${image.filename}`] = [image.bytes, { level: 0 }];
  }
  return zipSync(files, { level: 6 });
}

async function renderPdf(entries: ExportEntry[]): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const fontBytes = await loadFontBytes();
  const sourceFont = fontkit.create(fontBytes);
  pdf.registerFontkit(fontkit);
  // Unifont's complete compressed font is smaller and faster here than the
  // subset produced by fontkit, whose generated cmap dominates small exports.
  const font = await pdf.embedFont(fontBytes, { subset: false });
  const documentTitle = entries.length === 1 ? entries[0].title : `Wallaby library (${entries.length} entries)`;
  const creators = [...new Set(entries.flatMap(entryAuthors))];
  const keywords = [...new Set(entries.flatMap((entry) => entry.tags.map(({ label }) => label)))];
  const updatedAt = latestUpdatedAt(entries);
  pdf.setTitle(documentTitle, { showInWindowTitleBar: true });
  pdf.setAuthor(creators.join(", ") || "Wallaby");
  pdf.setCreator("Wallaby");
  pdf.setProducer("Wallaby");
  pdf.setSubject(entries.length === 1 ? "Saved article" : "Saved article library");
  if (keywords.length) pdf.setKeywords(keywords);
  pdf.setCreationDate(updatedAt);
  pdf.setModificationDate(updatedAt);

  const writer = new PdfWriter(pdf, font, (value) => replaceUnsupportedGlyphs(value, sourceFont));
  if (!entries.length) {
    writer.heading("Wallaby library", 22);
    writer.paragraph("No saved entries were available for this export.");
  }
  entries.forEach((entry, index) => {
    if (index) writer.newPage();
    writer.heading(entry.title, 21);
    const authors = entryAuthors(entry);
    if (authors.length) writer.meta(`By ${authors.join(", ")}`);
    if (entry.publishedAt) writer.meta(`Published: ${entry.publishedAt.toISOString()}`);
    writer.meta(`Saved: ${entry.createdAt.toISOString()}`);
    writer.meta(`Source: ${entry.url}`);
    if (entry.originUrl) writer.meta(`Origin: ${entry.originUrl}`);
    if (entry.tags.length) writer.meta(`Tags: ${entry.tags.map(({ label }) => label).join(", ")}`);
    writer.rule();
    writer.paragraph(plainText(entry.content) || entry.summary || "No readable article text was saved.");
  });
  return pdf.save();
}

class PdfWriter {
  private static readonly PAGE_SIZE: [number, number] = [595.28, 841.89];
  private static readonly MARGIN = 48;
  private page: PDFPage;
  private y: number;

  constructor(
    private readonly document: PDFDocument,
    private readonly font: PDFFont,
    private readonly normalize: (value: string) => string,
  ) {
    this.page = this.document.addPage(PdfWriter.PAGE_SIZE);
    this.y = PdfWriter.PAGE_SIZE[1] - PdfWriter.MARGIN;
  }

  newPage(): void {
    this.page = this.document.addPage(PdfWriter.PAGE_SIZE);
    this.y = PdfWriter.PAGE_SIZE[1] - PdfWriter.MARGIN;
  }

  heading(value: string, size: number): void {
    this.lines(value, size, size * 1.25, rgb(0.12, 0.2, 0.17));
    this.y -= 10;
  }

  meta(value: string): void {
    this.lines(value, 9, 13, rgb(0.31, 0.38, 0.35));
  }

  rule(): void {
    this.ensureSpace(18);
    this.y -= 7;
    this.page.drawLine({ start: { x: PdfWriter.MARGIN, y: this.y }, end: { x: PdfWriter.PAGE_SIZE[0] - PdfWriter.MARGIN, y: this.y }, thickness: 0.6, color: rgb(0.72, 0.76, 0.73) });
    this.y -= 14;
  }

  paragraph(value: string): void {
    for (const paragraph of value.split(/\n{2,}/)) {
      this.lines(paragraph.replace(/\n/g, " "), 10.5, 16, rgb(0.12, 0.14, 0.13));
      this.y -= 8;
    }
  }

  private lines(value: string, size: number, lineHeight: number, color: ReturnType<typeof rgb>): void {
    const normalized = this.normalize(value).replace(/\s+/g, " ").trim();
    if (!normalized) return;
    const width = PdfWriter.PAGE_SIZE[0] - PdfWriter.MARGIN * 2;
    const lines = wrapPdfText(normalized, width, (text) => this.font.widthOfTextAtSize(text, size));
    for (const line of lines) {
      this.ensureSpace(lineHeight);
      this.page.drawText(line.trimEnd(), { x: PdfWriter.MARGIN, y: this.y, size, font: this.font, color });
      this.y -= lineHeight;
    }
  }

  private ensureSpace(height: number): void {
    if (this.y - height >= PdfWriter.MARGIN) return;
    this.newPage();
  }
}

function wrapPdfText(value: string, maxWidth: number, measure: (value: string) => number): string[] {
  const lines: string[] = [];
  let line = "";
  let lineWidth = 0;
  const push = () => {
    if (line.trim()) lines.push(line.trim());
    line = "";
    lineWidth = 0;
  };
  for (const { segment } of wordSegmenter.segment(value)) {
    const segmentWidth = measure(segment);
    if (line && lineWidth + segmentWidth > maxWidth) push();
    if (segmentWidth <= maxWidth) {
      const part = line ? segment : segment.trimStart();
      line += part;
      lineWidth += measure(part);
      continue;
    }
    for (const character of segment) {
      const characterWidth = measure(character);
      if (line && lineWidth + characterWidth > maxWidth) push();
      line += character;
      lineWidth += characterWidth;
    }
  }
  push();
  return lines;
}

async function renderEpubChapter(entry: BinaryExportEntry, position: number) {
  const id = `chapter-${position}`;
  const filename = `${id}.xhtml`;
  const language = validLanguage(entry.language);
  const authors = entryAuthors(entry);
  const { body, images } = await xhtmlFragment(entry, position);
  const meta = [
    authors.length ? `<p>By ${xml(authors.join(", "))}</p>` : "",
    entry.publishedAt ? `<p>Published: ${entry.publishedAt.toISOString()}</p>` : "",
    `<p>Saved: ${entry.createdAt.toISOString()}</p>`,
    `<p>Source: <a href="${xml(entry.url)}">${xml(entry.url)}</a></p>`,
    entry.originUrl ? `<p>Origin: <a href="${xml(entry.originUrl)}">${xml(entry.originUrl)}</a></p>` : "",
    entry.tags.length ? `<p>Tags: ${xml(entry.tags.map(({ label }) => label).join(", "))}</p>` : "",
  ].filter(Boolean).join("");
  return {
    id,
    filename,
    title: entry.title,
    images,
    remoteResources: /<img\b[^>]+\bsrc="https?:/i.test(body),
    body: `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="${xml(language)}" lang="${xml(language)}">
  <head><title>${xml(entry.title)}</title><link rel="stylesheet" type="text/css" href="styles.css"/></head>
  <body><article><h1>${xml(entry.title)}</h1><div class="entry-meta">${meta}</div><div class="entry-content">${body}</div></article></body>
</html>`,
  };
}

function emptyChapter(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en" lang="en">
  <head><title>No saved entries</title><link rel="stylesheet" type="text/css" href="styles.css"/></head>
  <body><article><h1>No saved entries</h1><p>No saved entries were available for this export.</p></article></body>
</html>`;
}

async function xhtmlFragment(entry: BinaryExportEntry, position: number): Promise<{ body: string; images: EpubImage[] }> {
  const document = new JSDOM(`<main>${entry.content}</main>`).window.document;
  const root = document.querySelector("main")!;
  const records = new Map((entry.images ?? [])
    .filter((image) => image.userId === entry.userId && image.entryId === entry.id)
    .map((image) => [`/media/${image.id}`, image]));
  const images = new Map<string, EpubImage>();
  for (const element of root.querySelectorAll("img[src]")) {
    const source = element.getAttribute("src")!;
    if (!source.startsWith("/media/") || images.has(source)) continue;
    const image = records.get(source);
    if (!image) throw new Error(`Cannot export EPUB: saved image not found for entry ${entry.id}`);
    const convertToPng = image.contentType === "image/webp" || image.contentType === "image/avif";
    const contentType = convertToPng ? "image/png" : image.contentType;
    const extension = EPUB_IMAGE_EXTENSIONS.get(contentType);
    if (!extension) throw new Error(`Cannot export EPUB: unsupported saved image type ${image.contentType}`);
    const stored = await readEntryImage(image.relativePath);
    const bytes = convertToPng ? await sharp(stored).png().toBuffer() : stored;
    const id = `image-${position}-${images.size + 1}`;
    images.set(source, { id, filename: `images/${id}.${extension}`, contentType, bytes });
  }
  return { body: [...root.childNodes].map((node) => serializeXhtmlNode(node, images)).join(""), images: [...images.values()] };
}

function serializeXhtmlNode(node: Node, images: Map<string, EpubImage>): string {
  if (node.nodeType === 3) return xml(node.nodeValue ?? "");
  if (node.nodeType !== 1) return "";
  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  const children = [...element.childNodes].map((child) => serializeXhtmlNode(child, images)).join("");
  if (!EPUB_TAGS.has(tag)) return children;
  const attributes: string[] = [];
  for (const name of ["id", "class", "title", "lang", "dir", "datetime", "colspan", "rowspan", "alt", "width", "height"]) {
    const value = element.getAttribute(name);
    if (value) attributes.push(`${name}="${xml(value)}"`);
  }
  if (tag === "a") {
    const href = safeUrl(element.getAttribute("href"), true);
    if (href) attributes.push(`href="${xml(href)}"`);
  }
  if (tag === "img") {
    const source = element.getAttribute("src");
    const src = images.get(source ?? "")?.filename ?? safeUrl(source, false);
    if (!src) return element.getAttribute("alt") ? `<span>${xml(element.getAttribute("alt")!)}</span>` : "";
    attributes.push(`src="${xml(src)}"`);
  }
  const opening = attributes.length ? `<${tag} ${attributes.join(" ")}` : `<${tag}`;
  return EPUB_VOID_TAGS.has(tag) ? `${opening}/>` : `${opening}>${children}</${tag}>`;
}

function plainText(html: string): string {
  const document = new JSDOM(`<main>${html}</main>`).window.document;
  const root = document.querySelector("main")!;
  const chunks: string[] = [];
  const visit = (node: Node) => {
    if (node.nodeType === 3) chunks.push(node.nodeValue ?? "");
    if (node.nodeType !== 1) return;
    const element = node as Element;
    const tag = element.tagName.toLowerCase();
    if (tag === "br") chunks.push("\n");
    if (BLOCK_TAGS.has(tag)) chunks.push("\n");
    for (const child of element.childNodes) visit(child);
    if (BLOCK_TAGS.has(tag)) chunks.push("\n");
  };
  for (const child of root.childNodes) visit(child);
  return chunks.join("").replace(/[ \t]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function entryAuthors(entry: ExportEntry): string[] {
  return Array.isArray(entry.publishedBy)
    ? entry.publishedBy.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean)
    : [];
}

function latestUpdatedAt(entries: ExportEntry[]): Date {
  return entries.reduce((latest, entry) => entry.updatedAt > latest ? entry.updatedAt : latest, new Date(0));
}

function commonLanguage(entries: ExportEntry[]): string {
  const languages = [...new Set(entries.map(({ language }) => validLanguage(language)))];
  return languages.length === 1 ? languages[0] : languages.length > 1 ? "mul" : "en";
}

function validLanguage(language: string | null): string {
  return language && /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(language) ? language : "en";
}

function safeUrl(value: string | null, allowFragment: boolean): string | null {
  if (!value) return null;
  if (allowFragment && value.startsWith("#")) return value;
  try {
    const url = new URL(value);
    return ["http:", "https:", ...(allowFragment ? ["mailto:"] : [])].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function xml(value: string): string {
  return value.replace(INVALID_XML, "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);
}

function loadFontBytes(): Promise<Uint8Array> {
  fontBytesPromise ??= readFile(fontPath);
  return fontBytesPromise;
}

function replaceUnsupportedGlyphs(value: string, font: fontkit.Font): string {
  return [...value].map((character) => {
    const codePoint = character.codePointAt(0)!;
    if (character === "\n" || character === "\r") return character;
    if (character === "\t") return "    ";
    return font.hasGlyphForCodePoint(codePoint) ? character : "□";
  }).join("");
}
