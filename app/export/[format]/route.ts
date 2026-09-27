import { auth } from "@/auth";
import { renderBinaryExport, type BinaryExportFormat } from "@/lib/binary-exports";
import { db } from "@/lib/db";
import { parseEntryFilters } from "@/lib/entry-filters";
import { entryOrderBy, parseEntrySort } from "@/lib/entry-sort";
import { renderExport, type TextExportFormat } from "@/lib/exports";
import { resolveEntryQuery } from "@/lib/search";

type Context = { params: Promise<{ format: string }> };

export async function GET(request: Request, { params }: Context) {
  const session = await auth();
  if (!session?.user?.id) return Response.json({ error: "Authentication required" }, { status: 401 });
  const { format } = await params;
  const textFormats: TextExportFormat[] = ["json", "csv", "xml", "txt", "md"];
  const binaryFormats: BinaryExportFormat[] = ["epub", "pdf"];
  if (![...textFormats, ...binaryFormats].includes(format as TextExportFormat | BinaryExportFormat)) return Response.json({ error: "Unsupported export format" }, { status: 404 });
  const query = new URL(request.url).searchParams;
  const scope = query.get("scope") ?? "all";
  if (!query.has("view")) query.set("view", scope);
  const filters = parseEntryFilters(query, "all");
  const [preference, sourceEntry] = await Promise.all([
    db.userPreference.findUnique({ where: { userId: session.user.id }, select: { readingSpeed: true } }),
    filters.view === "same-domain" && filters.sourceEntryId
      ? db.entry.findFirst({ where: { id: filters.sourceEntryId, userId: session.user.id }, select: { domainName: true } })
      : null,
  ]);
  const { where } = await resolveEntryQuery(session.user.id, filters, {
    readingSpeed: preference?.readingSpeed,
    sameDomain: sourceEntry?.domainName,
    entryId: query.get("id"),
  });
  const entries = await db.entry.findMany({ where, include: { tags: true, annotations: true, images: format === "epub" }, orderBy: entryOrderBy(parseEntrySort(query.get("sort"), false)) });
  const output = binaryFormats.includes(format as BinaryExportFormat)
    ? await renderBinaryExport(entries, format as BinaryExportFormat)
    : renderExport(entries, format as TextExportFormat);
  const filename = `wallaby-${scope}-${new Date().toISOString().slice(0, 10)}.${format}`;
  const body = typeof output.body === "string" ? output.body : new Uint8Array(output.body).buffer;
  return new Response(body, {
    headers: {
      "content-type": output.contentType,
      "content-disposition": `attachment; filename="${filename}"`,
      "x-content-type-options": "nosniff",
    },
  });
}
