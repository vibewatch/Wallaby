import { authenticateApiRequest, unauthorized } from "@/lib/api-auth";
import { db } from "@/lib/db";

export async function GET(request: Request) {
  const userId = await authenticateApiRequest(request);
  if (!userId) return unauthorized();
  const tags = await db.tag.findMany({ where: { userId }, include: { _count: { select: { entries: true } } }, orderBy: { label: "asc" } });
  return Response.json(tags.map((tag) => ({ id: tag.id, label: tag.label, slug: tag.slug, nbEntries: tag._count.entries, entries: tag._count.entries })));
}

export async function DELETE(request: Request) {
  const userId = await authenticateApiRequest(request);
  if (!userId) return unauthorized();
  const label = new URL(request.url).searchParams.get("label");
  if (!label) return Response.json({ error: "label is required" }, { status: 400 });
  const result = await db.tag.deleteMany({ where: { userId, label } });
  return result.count ? new Response(null, { status: 204 }) : Response.json({ error: "Tag not found" }, { status: 404 });
}
