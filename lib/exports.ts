import type { Annotation, Entry, Tag } from "@prisma/client";

import { serializeEntry } from "@/lib/entry-serializer";
import { stripHtml } from "@/lib/text";

export type TextExportFormat = "json" | "csv" | "xml" | "txt" | "md";
export type ExportEntry = Entry & { tags: Tag[]; annotations: Annotation[] };

export function renderExport(entries: ExportEntry[], format: TextExportFormat): { body: string; contentType: string } {
  if (format === "json") return { body: JSON.stringify(entries.map((entry) => serializeEntry(entry)), null, 2), contentType: "application/json; charset=utf-8" };
  if (format === "csv") return { body: renderCsv(entries), contentType: "text/csv; charset=utf-8" };
  if (format === "xml") return { body: renderXml(entries), contentType: "application/xml; charset=utf-8" };
  if (format === "md") return { body: entries.map(renderMarkdown).join("\n\n---\n\n"), contentType: "text/markdown; charset=utf-8" };
  return { body: entries.map((entry) => `${entry.title}\n${entry.url}\n\n${stripHtml(entry.content)}`).join("\n\n-----\n\n"), contentType: "text/plain; charset=utf-8" };
}

function renderCsv(entries: ExportEntry[]): string {
  const rows = [["title", "url", "created_at", "is_archived", "is_starred", "tags", "language", "reading_time"]];
  for (const entry of entries) rows.push([
    entry.title,
    entry.url,
    entry.createdAt.toISOString(),
    String(Number(entry.archived)),
    String(Number(entry.starred)),
    entry.tags.map(({ label }) => label).join(","),
    entry.language ?? "",
    String(entry.readingTime),
  ]);
  return rows.map((row) => row.map(csv).join(",")).join("\r\n");
}

function renderXml(entries: ExportEntry[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<wallaby>${entries.map((entry) => `
  <entry id="${xml(entry.id)}">
    <title>${xml(entry.title)}</title>
    <url>${xml(entry.url)}</url>
    <created_at>${entry.createdAt.toISOString()}</created_at>
    <is_archived>${Number(entry.archived)}</is_archived>
    <is_starred>${Number(entry.starred)}</is_starred>
    <tags>${entry.tags.map((tag) => `<tag>${xml(tag.label)}</tag>`).join("")}</tags>
    <content><![CDATA[${entry.content.replace(/]]>/g, "]]]]><![CDATA[>")}]]></content>
  </entry>`).join("")}\n</wallaby>`;
}

function renderMarkdown(entry: ExportEntry): string {
  const tags = entry.tags.map(({ label }) => `#${label}`).join(" ");
  return `# ${entry.title}\n\nSource: ${entry.url}\nSaved: ${entry.createdAt.toISOString()}${tags ? `\nTags: ${tags}` : ""}\n\n${stripHtml(entry.content)}`;
}

function csv(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

function xml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[character]!);
}
