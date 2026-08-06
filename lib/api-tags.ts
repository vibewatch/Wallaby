import { authenticateApiRequest, unauthorized } from "@/lib/api-auth";
import { apiError, apiRequestObject } from "@/lib/api-response";
import { db } from "@/lib/db";
import { parseTags } from "@/lib/entries";

export async function deleteApiTagById(request: Request, rawId: string): Promise<Response> {
  const userId = await authenticateApiRequest(request);
  if (!userId) return unauthorized();
  const id = rawId.replace(/\.(json|xml)$/, "");
  const tag = await db.tag.findFirst({ where: { id, userId } });
  if (!tag) return apiError(404, "not_found", "Tag not found");
  await db.tag.delete({ where: { id: tag.id } });
  return Response.json({ id: tag.id, label: tag.label, slug: tag.slug });
}

export async function deleteApiTagsByLabel(request: Request, multiple: boolean): Promise<Response> {
  const userId = await authenticateApiRequest(request);
  if (!userId) return unauthorized();
  const url = new URL(request.url);
  const body = await apiRequestObject(request);
  const raw = multiple
    ? url.searchParams.get("tags") ?? stringField(body, "tags")
    : url.searchParams.get("tag") ?? url.searchParams.get("label") ?? stringField(body, "tag") ?? stringField(body, "label");
  const labels = multiple ? parseTags(raw) : raw?.trim() ? [raw.trim()] : [];
  if (!labels.length) return apiError(400, "invalid_parameter", `${multiple ? "tags" : "tag"} is required`);
  const tags = await db.tag.findMany({ where: { userId, label: { in: labels } } });
  if (!tags.length) return apiError(404, "not_found", "Tag not found");
  await db.tag.deleteMany({ where: { userId, id: { in: tags.map((tag) => tag.id) } } });
  const serialized = tags.map((tag) => ({ id: tag.id, label: tag.label, slug: tag.slug }));
  return Response.json(multiple ? serialized : serialized[0]);
}

function stringField(value: Record<string, unknown> | null, key: string): string | null {
  return value && typeof value[key] === "string" ? value[key] : null;
}
