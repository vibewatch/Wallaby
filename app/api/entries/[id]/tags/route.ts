import { z } from "zod";

import { authenticateApiRequest, unauthorized } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { serializeEntry } from "@/lib/entry-serializer";
import { parseTags, slugify } from "@/lib/entries";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Context) {
  const userId = await authenticateApiRequest(request);
  if (!userId) return unauthorized();
  const { id } = await params;
  const entry = await db.entry.findFirst({ where: { id, userId }, include: { tags: true } });
  return entry ? Response.json(entry.tags) : Response.json({ error: "Entry not found" }, { status: 404 });
}

export async function POST(request: Request, { params }: Context) {
  const userId = await authenticateApiRequest(request);
  if (!userId) return unauthorized();
  const { id } = await params;
  const entry = await db.entry.findFirst({ where: { id, userId }, select: { id: true } });
  if (!entry) return Response.json({ error: "Entry not found" }, { status: 404 });
  const input = request.headers.get("content-type")?.includes("application/json")
    ? await request.json().catch(() => null)
    : Object.fromEntries(await request.formData().catch(() => new FormData()));
  const parsed = z.object({ tags: z.union([z.string(), z.array(z.string())]) }).safeParse(input);
  if (!parsed.success) return Response.json({ error: "tags is required" }, { status: 400 });
  const labels = parseTags(parsed.data.tags);
  if (!labels.length) return Response.json({ error: "At least one tag is required" }, { status: 400 });
  const updated = await db.entry.update({
    where: { id: entry.id },
    data: { tags: { connectOrCreate: labels.map((label) => ({
      where: { userId_slug: { userId, slug: slugify(label) } },
      create: { userId, label, slug: slugify(label) },
    })) } },
    include: { tags: true, annotations: true },
  });
  return Response.json(serializeEntry(updated));
}
