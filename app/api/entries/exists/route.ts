import { createHash } from "node:crypto";

import { authenticateApiRequest, unauthorized } from "@/lib/api-auth";
import { apiError } from "@/lib/api-response";
import { db } from "@/lib/db";

export async function GET(request: Request) {
  const userId = await authenticateApiRequest(request);
  if (!userId) return unauthorized();
  const params = new URL(request.url).searchParams;
  const singleUrl = params.get("url")?.trim() || null;
  const singleHash = params.get("hashed_url")?.trim().toLowerCase() || null;
  const urls = [...params.getAll("urls[]"), ...params.getAll("urls")].map((value) => value.trim()).filter(Boolean);
  const hashes = [...params.getAll("hashed_urls[]"), ...params.getAll("hashed_urls")].map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (singleUrl) urls.unshift(singleUrl);
  if (singleHash) hashes.unshift(singleHash);
  if (!urls.length && !hashes.length) return apiError(400, "invalid_parameter", "At least one URL or SHA-1 URL hash is required");
  const entries = await db.entry.findMany({ where: { userId }, select: { id: true, url: true, givenUrl: true } });
  const byHash = new Map<string, string>();
  for (const entry of entries) {
    byHash.set(sha1(entry.url), entry.id);
    byHash.set(sha1(entry.givenUrl), entry.id);
  }
  const returnId = params.get("return_id") === "1";
  const results: Record<string, string | boolean | null> = {};
  for (const url of urls) {
    let normalized: string;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
      normalized = parsed.toString();
    } catch { results[url] = returnId ? null : false; continue; }
    const id = byHash.get(sha1(normalized)) ?? null;
    results[url] = returnId ? id : Boolean(id);
  }
  for (const hash of hashes) {
    const id = byHash.get(hash) ?? null;
    results[hash] = returnId ? id : Boolean(id);
  }
  if (singleUrl || singleHash) return Response.json({ exists: Object.values(results)[0] });
  return Response.json(results);
}

function sha1(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}
