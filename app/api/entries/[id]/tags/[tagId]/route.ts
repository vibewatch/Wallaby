import { authenticateApiRequest, unauthorized } from "@/lib/api-auth";
import { stripApiFormat, xmlApiResponse } from "@/lib/api-response";
import { db } from "@/lib/db";
import { serializeEntry } from "@/lib/entry-serializer";

type Context = { params: Promise<{ id: string; tagId: string }> };

export async function DELETE(request: Request, { params }: Context) {
  const userId = await authenticateApiRequest(request);
  if (!userId) return unauthorized();
  const { id, tagId: rawTagId } = await params;
  const { id: tagId, format } = stripApiFormat(rawTagId);
  const [entry, tag] = await Promise.all([
    db.entry.findFirst({ where: { id, userId }, select: { id: true } }),
    db.tag.findFirst({ where: { id: tagId, userId }, select: { id: true } }),
  ]);
  if (!entry) return Response.json({ error: "Entry not found" }, { status: 404 });
  if (!tag) return Response.json({ error: "Tag not found" }, { status: 404 });
  const updated = await db.entry.update({ where: { id: entry.id }, data: { tags: { disconnect: { id: tag.id } } }, include: { tags: true, annotations: true } });
  await db.tag.deleteMany({ where: { id: tag.id, userId, entries: { none: {} } } });
  const response = Response.json(serializeEntry(updated));
  return format === "xml" ? xmlApiResponse(response, "entry") : response;
}
