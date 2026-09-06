import { authenticateApiRequest, unauthorized } from "@/lib/api-auth";
import { renderBinaryExport, type BinaryExportFormat } from "@/lib/binary-exports";
import { apiError, xmlApiResponse } from "@/lib/api-response";
import { db } from "@/lib/db";
import { serializeEntry } from "@/lib/entry-serializer";
import { reloadEntry } from "@/lib/entries";
import { renderExport, type TextExportFormat } from "@/lib/exports";

type Context = { params: Promise<{ id: string; operation: string }> };

export async function PATCH(request: Request, { params }: Context) {
  const userId = await authenticateApiRequest(request);
  if (!userId) return unauthorized();
  const { id, operation } = await params;
  if (operation !== "reload" && operation !== "reload.json" && operation !== "reload.xml") return apiError(404, "not_found", "API operation not found");
  const owned = await db.entry.findFirst({ where: { id, userId }, select: { id: true } });
  if (!owned) return apiError(404, "not_found", "Entry not found");
  try {
    const response = Response.json(serializeEntry(await reloadEntry(userId, id)));
    return operation.endsWith(".xml") ? xmlApiResponse(response, "entry") : response;
  } catch { return new Response(null, { status: 304 }); }
}

export async function GET(request: Request, { params }: Context) {
  const userId = await authenticateApiRequest(request);
  if (!userId) return unauthorized();
  const { id, operation } = await params;
  if (!operation.startsWith("export.")) return apiError(404, "not_found", "API operation not found");
  const format = operation.slice("export.".length);
  const textFormats: TextExportFormat[] = ["json", "csv", "xml", "txt", "md"];
  const binaryFormats: BinaryExportFormat[] = ["epub", "pdf"];
  if (![...textFormats, ...binaryFormats].includes(format as TextExportFormat | BinaryExportFormat)) return apiError(404, "not_found", "Export format not found");
  const entries = await db.entry.findMany({ where: { id, userId }, include: { tags: true, annotations: true, images: format === "epub" } });
  if (!entries.length) return apiError(404, "not_found", "Entry not found");
  const output = binaryFormats.includes(format as BinaryExportFormat)
    ? await renderBinaryExport(entries, format as BinaryExportFormat)
    : renderExport(entries, format as TextExportFormat);
  const body = typeof output.body === "string" ? output.body : new Uint8Array(output.body).buffer;
  return new Response(body, { headers: { "content-type": output.contentType, "content-disposition": `attachment; filename="wallaby-entry-${id}.${format}"`, "x-content-type-options": "nosniff" } });
}
