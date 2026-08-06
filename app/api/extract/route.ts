import { z } from "zod";

import { authenticateApiRequest, unauthorized } from "@/lib/api-auth";
import { getGraby } from "@/lib/graby";
import { findSiteCredential } from "@/lib/site-credentials";

export async function POST(request: Request) {
  const userId = await authenticateApiRequest(request);
  if (!userId) return unauthorized();
  const parsed = z.object({ url: z.string().min(1), html: z.string().optional() }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "url is required" }, { status: 400 });
  try {
    const url = new URL(parsed.data.url.match(/^https?:\/\//i) ? parsed.data.url : `https://${parsed.data.url}`);
    const credential = parsed.data.html ? undefined : await findSiteCredential(userId, url.hostname);
    return Response.json(await getGraby().fetchContent(url, parsed.data.html, credential));
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Extraction failed" }, { status: 422 });
  }
}
