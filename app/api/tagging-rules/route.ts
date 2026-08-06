import { z } from "zod";

import { authenticateApiRequest, unauthorized } from "@/lib/api-auth";
import { db } from "@/lib/db";
import { validateTaggingRule } from "@/lib/rules";
import { parseTags } from "@/lib/text";

export async function GET(request: Request) {
  const userId = await authenticateApiRequest(request);
  if (!userId) return unauthorized();
  const download = new URL(request.url).searchParams.has("download");
  const rules = await db.taggingRule.findMany({ where: { userId }, select: { id: true, rule: true, tags: true }, orderBy: { createdAt: "asc" } });
  if (!download) return Response.json(rules);
  return Response.json(rules.map(({ rule, tags }) => ({ rule, tags })), {
    headers: {
      "content-disposition": 'attachment; filename="tagging_rules_wallaby.json"',
      "content-transfer-encoding": "UTF-8",
      "x-content-type-options": "nosniff",
    },
  });
}

export async function POST(request: Request) {
  const userId = await authenticateApiRequest(request);
  if (!userId) return unauthorized();
  const parsed = z.object({ rule: z.string().min(1).max(2_000), tags: z.union([z.string(), z.array(z.string())]) }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid tagging rule", issues: parsed.error.issues }, { status: 400 });
  try { validateTaggingRule(parsed.data.rule); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Invalid tagging rule" }, { status: 400 }); }
  const tags = parseTags(parsed.data.tags).map((tag) => tag.toLowerCase());
  if (!tags.length) return Response.json({ error: "At least one tag is required" }, { status: 400 });
  return Response.json(await db.taggingRule.create({ data: { userId, rule: parsed.data.rule, tags } }), { status: 201 });
}

export async function PATCH(request: Request) {
  const userId = await authenticateApiRequest(request);
  if (!userId) return unauthorized();
  const parsed = z.object({
    id: z.string().min(1),
    rule: z.string().trim().min(1).max(2_000),
    tags: z.union([z.string(), z.array(z.string())]),
  }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid tagging rule", issues: parsed.error.issues }, { status: 400 });
  try { validateTaggingRule(parsed.data.rule); }
  catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Invalid tagging rule" }, { status: 400 }); }
  const tags = parseTags(parsed.data.tags).map((tag) => tag.toLowerCase());
  if (!tags.length) return Response.json({ error: "At least one tag is required" }, { status: 400 });
  const result = await db.taggingRule.updateMany({ where: { id: parsed.data.id, userId }, data: { rule: parsed.data.rule, tags } });
  if (!result.count) return Response.json({ error: "Rule not found" }, { status: 404 });
  return Response.json(await db.taggingRule.findUniqueOrThrow({ where: { id: parsed.data.id }, select: { id: true, rule: true, tags: true } }));
}

export async function DELETE(request: Request) {
  const userId = await authenticateApiRequest(request);
  if (!userId) return unauthorized();
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "id is required" }, { status: 400 });
  const result = await db.taggingRule.deleteMany({ where: { id, userId } });
  return result.count ? new Response(null, { status: 204 }) : Response.json({ error: "Rule not found" }, { status: 404 });
}
