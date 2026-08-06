import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const MAX_PAGES = 500;
const MAX_TEXT_LENGTH = 2_000_000;

export type ExtractedPdf = {
  title: string | null;
  authors: string[];
  date: string | null;
  html: string;
  summary: string;
};

export async function extractPdf(bytes: Uint8Array): Promise<ExtractedPdf> {
  const task = getDocument({ data: bytes.slice(), useSystemFonts: true, disableFontFace: true });
  const document = await task.promise;
  try {
    const metadata = await document.getMetadata();
    const info = metadata.info as Record<string, unknown>;
    let text = "";
    for (let pageNumber = 1; pageNumber <= Math.min(document.numPages, MAX_PAGES) && text.length < MAX_TEXT_LENGTH; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      const pageText = content.items.map((item) => "str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : "").join("").replace(/[ \t]+\n/g, "\n").trim();
      if (pageText) text += `${text ? "\n\n" : ""}${pageText}`;
      page.cleanup();
    }
    text = text.slice(0, MAX_TEXT_LENGTH).trim();
    const title = stringMetadata(metadata.metadata?.get("dc:title")) ?? stringMetadata(info.Title);
    const author = stringMetadata(metadata.metadata?.get("dc:creator")) ?? stringMetadata(info.Author);
    const date = pdfDate(stringMetadata(metadata.metadata?.get("xmp:createdate")) ?? stringMetadata(info.CreationDate));
    return {
      title,
      authors: author ? author.split(/\s*[,;]\s*/).filter(Boolean).slice(0, 100) : [],
      date,
      html: text ? `<article class="wallaby-pdf"><pre>${escapeHtml(text)}</pre></article>` : "",
      summary: text.length > 250 ? `${text.slice(0, 250).replace(/\s+\S*$/, "")} …` : text,
    };
  } finally {
    await document.destroy();
  }
}

function stringMetadata(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function pdfDate(value: string | null): string | null {
  if (!value) return null;
  if (!value.startsWith("D:")) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const match = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?/.exec(value);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2] ?? 1) - 1, Number(match[3] ?? 1), Number(match[4] ?? 0), Number(match[5] ?? 0), Number(match[6] ?? 0)));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]!);
}
