import { JSDOM } from "jsdom";

import { parseTags, stripHtml } from "@/lib/text";

export type ImportSource =
  | "auto"
  | "wallabag"
  | "pocket"
  | "instapaper"
  | "readability"
  | "shaarli"
  | "browser"
  | "pinboard"
  | "omnivore"
  | "elcurator";

export type NormalizedImportEntry = {
  url: string;
  title?: string;
  content?: string;
  tags: string[];
  archived: boolean;
  starred: boolean;
  createdAt?: Date;
  publishedAt?: Date;
  originUrl?: string;
  previewPicture?: string;
  publishedBy: string[];
  annotations: NormalizedImportAnnotation[];
};

export type NormalizedImportAnnotation = {
  text: string;
  quote: string;
  ranges: { start: string; startOffset: number; end: string; endOffset: number }[];
};

export function parseImport(source: ImportSource, filename: string, input: string): NormalizedImportEntry[] {
  const resolvedSource = source === "auto" ? detectSource(filename, input) : source;
  const records = resolvedSource === "browser" || resolvedSource === "shaarli"
    ? parseBookmarkHtml(input)
    : resolvedSource === "wallabag" || resolvedSource === "pinboard" || resolvedSource === "omnivore" || resolvedSource === "readability" || resolvedSource === "elcurator"
      ? parseJsonRecords(input)
      : parseCsv(input);
  const entries = records.map((record) => normalizeRecord(record, resolvedSource)).filter((entry): entry is NormalizedImportEntry => Boolean(entry));
  if (!entries.length) throw new Error("No importable URLs were found in this file");
  if (entries.length > 5_000) throw new Error("A single import is limited to 5,000 entries");
  return entries;
}

function detectSource(filename: string, input: string): ImportSource {
  const lower = filename.toLowerCase();
  const trimmed = input.trimStart();
  if (lower.includes("shaarli") || /shaarli export of all bookmarks/i.test(trimmed)) return "shaarli";
  if (lower.includes("readability")) return "readability";
  if (lower.includes("elcurator")) return "elcurator";
  if (lower.endsWith(".html") || lower.endsWith(".htm") || /<!doctype\s+netscape-bookmark-file/i.test(trimmed)) return "browser";
  if (lower.includes("instapaper")) return "instapaper";
  if (lower.includes("pocket")) return "pocket";
  if (lower.includes("omnivore")) return "omnivore";
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) return detectJsonSource(trimmed);
  return "pocket";
}

function detectJsonSource(input: string): ImportSource {
  try {
    const parsed = JSON.parse(input) as unknown;
    if (isRecord(parsed) && Array.isArray(parsed.bookmarks) && parsed.bookmarks.some((item) => isRecord(item) && typeof item.article__url === "string")) return "readability";
    const first = Array.isArray(parsed) ? parsed.find(isRecord) : null;
    if (first && "is_saved" in first && "created_at" in first) return "elcurator";
  } catch {
    // The selected parser will return the actionable JSON syntax error.
  }
  return "wallabag";
}

function parseJsonRecords(input: string): Record<string, unknown>[] {
  const parsed = JSON.parse(input) as unknown;
  if (Array.isArray(parsed)) return parsed.filter(isRecord);
  if (!isRecord(parsed)) return [];
  for (const key of ["items", "entries", "bookmarks", "data"]) {
    if (Array.isArray(parsed[key])) return parsed[key].filter(isRecord);
  }
  const embedded = parsed._embedded;
  if (isRecord(embedded) && Array.isArray(embedded.items)) return embedded.items.filter(isRecord);
  return [parsed];
}

function parseBookmarkHtml(input: string): Record<string, unknown>[] {
  const document = new JSDOM(input).window.document;
  return [...document.querySelectorAll<HTMLAnchorElement>("a[href]")].map((anchor) => ({
    url: anchor.href,
    title: anchor.textContent?.trim(),
    tags: anchor.getAttribute("tags"),
    created_at: anchor.getAttribute("add_date"),
  }));
}

export function parseCsv(input: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < input.length; index++) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') { value += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else value += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") { row.push(value); value = ""; }
    else if (character === "\n") { row.push(value.replace(/\r$/, "")); rows.push(row); row = []; value = ""; }
    else value += character;
  }
  if (value || row.length) { row.push(value.replace(/\r$/, "")); rows.push(row); }
  const headers = (rows.shift() ?? []).map((header) => header.trim().toLowerCase());
  return rows.filter((values) => values.some(Boolean)).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index]?.trim() ?? ""])));
}

function normalizeRecord(record: Record<string, unknown>, source: ImportSource): NormalizedImportEntry | null {
  const rawUrl = firstString(record, ["url", "given_url", "resolved_url", "originalArticleUrl", "original_url", "article__url", "href", "URL"]);
  if (!rawUrl) return null;
  let url: string;
  try { url = new URL(rawUrl.match(/^https?:\/\//i) ? rawUrl : `https://${rawUrl}`).toString(); }
  catch { return null; }
  const title = firstString(record, ["title", "resolved_title", "article__title", "description", "name", "Title"]);
  const content = firstString(record, ["content", "html", "articleContent", "selection"]);
  const rawTags = record.tags ?? record.labels ?? record.tag_list ?? record.Tags;
  const tags = normalizeTags(rawTags);
  const archived = booleanValue(record.is_archived ?? record.archive) || String(record.status ?? "").toLowerCase() === "archive";
  const starred = booleanValue(record.is_starred ?? record.starred ?? record.favorite ?? record.is_saved) || String(record.folder ?? record.Folder ?? "").toLowerCase() === "starred";
  const createdAt = parseDate(record.created_at ?? record.date_added ?? record.time_added ?? record.timestamp ?? record.savedAt ?? record.time);
  const publishedAt = parseDate(record.published_at ?? record.publishedAt);
  const rawOriginUrl = firstString(record, ["origin_url", "originUrl"]);
  const originUrl = validHttpUrl(rawOriginUrl);
  const previewPicture = validHttpUrl(firstString(record, ["preview_picture", "previewPicture", "image"]));
  const publishedBy = Array.isArray(record.published_by) ? record.published_by.filter((value): value is string => typeof value === "string").map((value) => value.trim()).filter(Boolean).slice(0, 100) : [];
  const annotations = normalizeAnnotations(record.annotations);
  return {
    url,
    title: title || undefined,
    content: content ? (/<[a-z][\s\S]*>/i.test(content) ? content : `<p>${escapeHtml(stripHtml(content))}</p>`) : undefined,
    tags,
    archived: source === "instapaper" && String(record.Folder ?? record.folder).toLowerCase() === "archive" ? true : archived,
    starred,
    createdAt,
    publishedAt,
    originUrl: originUrl ?? undefined,
    previewPicture: previewPicture ?? undefined,
    publishedBy,
    annotations,
  };
}

function normalizeAnnotations(value: unknown): NormalizedImportAnnotation[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 1_000).flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.text !== "string" || !candidate.text.trim()) return [];
    const ranges = Array.isArray(candidate.ranges) ? candidate.ranges.flatMap((range) => {
      if (!isRecord(range) || typeof range.start !== "string" || typeof range.end !== "string" || !Number.isInteger(range.startOffset) || !Number.isInteger(range.endOffset)) return [];
      const startOffset = Number(range.startOffset);
      const endOffset = Number(range.endOffset);
      return startOffset >= 0 && endOffset >= 0 ? [{ start: range.start, startOffset, end: range.end, endOffset }] : [];
    }).slice(0, 20) : [];
    return [{ text: candidate.text.trim().slice(0, 10_000), quote: typeof candidate.quote === "string" ? candidate.quote.slice(0, 10_000) : "", ranges }];
  });
}

function normalizeTags(value: unknown): string[] {
  if (Array.isArray(value)) {
    return parseTags(value.flatMap((item) => typeof item === "string" ? item : isRecord(item) && typeof item.label === "string" ? item.label : []));
  }
  if (typeof value !== "string") return [];
  return parseTags(value.includes(",") || value.includes(";") ? value.split(/[,;]/) : value.split(/\s+/));
}

function parseDate(value: unknown): Date | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const text = String(value);
  const date = /^\d{9,13}$/.test(text) ? new Date(Number(text) * (text.length > 10 ? 1 : 1_000)) : new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function firstString(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) if (typeof record[key] === "string" && record[key].trim()) return record[key].trim();
  return null;
}

function validHttpUrl(value: string | null): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch { return null; }
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || String(value).toLowerCase() === "true";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]!);
}
