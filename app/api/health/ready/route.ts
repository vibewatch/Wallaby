import { constants } from "node:fs";
import { access } from "node:fs/promises";

import { getMediaRoot } from "@/lib/article-images";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const checks: Record<string, "ok" | "failed" | "disabled"> = { database: "failed", media: "disabled" };
  try {
    await db.$queryRaw`SELECT 1`;
    checks.database = "ok";
    const configuration = await db.instanceConfiguration.findUnique({
      where: { id: "default" },
      select: { downloadImagesEnabled: true },
    });
    if (configuration?.downloadImagesEnabled) {
      await access(getMediaRoot(), constants.R_OK | constants.W_OK);
      checks.media = "ok";
    }
    return Response.json({ status: "ready", checks }, { headers: { "cache-control": "no-store" } });
  } catch {
    return Response.json({ status: "unavailable", checks }, { status: 503, headers: { "cache-control": "no-store" } });
  }
}
