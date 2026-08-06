import { z } from "zod";

import { applyBulkEntryAction } from "@/lib/bulk";
import { db } from "@/lib/db";

const urlListSchema = z.array(z.object({ url: z.string().url() })).max(100);
const tagListSchema = z.array(z.object({ url: z.string().url(), tags: z.union([z.string(), z.array(z.string())]) })).max(100);

export function parseEntryUrlList(raw: string | null): { url: string }[] {
  return parseQueryList(raw, urlListSchema, "urls");
}

export function parseEntryTagList(raw: string | null): { url: string; tags: string | string[] }[] {
  return parseQueryList(raw, tagListSchema, "list");
}

export async function updateEntryTagsByUrl(userId: string, values: { url: string; tags: string | string[] }[], action: "add-tags" | "remove-tags") {
  const results: { url: string; entry: string | false }[] = [];
  for (const value of values) {
    const entry = await db.entry.findFirst({ where: { userId, OR: [{ url: value.url }, { givenUrl: value.url }] }, select: { id: true } });
    results.push({ url: value.url, entry: entry?.id ?? false });
    if (entry) await applyBulkEntryAction(userId, [entry.id], action, value.tags);
  }
  return results;
}

function parseQueryList<T>(raw: string | null, schema: z.ZodType<T>, name: string): T {
  if (!raw) return schema.parse([]);
  if (raw.length > 100_000) throw new Error(`${name} query is too large`);
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error(`${name} must be valid JSON`); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new Error(`${name} has an invalid wallabag list shape`);
  return parsed.data;
}
