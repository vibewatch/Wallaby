import { z } from "zod";

import { authenticateApiRequest, unauthorized } from "@/lib/api-auth";
import { apiError, apiRequestObject } from "@/lib/api-response";
import { db } from "@/lib/db";
import { clampProgress, PROGRESS_FINISHED } from "@/lib/reading-progress";

type Context = { params: Promise<{ id: string }> };

/**
 * Called repeatedly while an article is being read, so it stays deliberately
 * small: no revalidation or entry payload, and ownership-scoped writes that
 * only advance progress unless the reader explicitly resets it.
 */
export async function POST(request: Request, { params }: Context) {
  const userId = await authenticateApiRequest(request);
  if (!userId) return unauthorized();
  const { id } = await params;

  const parsed = z.object({
    progress: z.coerce.number().min(0).max(1),
    archive: z.union([z.boolean(), z.literal("1"), z.literal("0")]).optional(),
  }).safeParse(await apiRequestObject(request));
  if (!parsed.success) return apiError(400, "invalid_request", "A progress fraction between 0 and 1 is required", parsed.error.issues);

  const progress = clampProgress(parsed.data.progress);
  const now = new Date();
  await db.entry.updateMany({
    where: { id, userId, ...(progress === 0 ? {} : { readingProgress: { lt: progress } }) },
    data: { readingProgress: progress, readingProgressAt: now },
  });

  // Auto-archiving on completion is opt-in per request so a reader that merely
  // scrolls past the end never silently loses the entry from its unread view.
  const archiveOnFinish = parsed.data.archive === true || parsed.data.archive === "1";
  if (archiveOnFinish) await db.entry.updateMany({
    where: { id, userId, archived: false, readingProgress: { gte: PROGRESS_FINISHED } },
    data: { archived: true, archivedAt: now },
  });

  const entry = await db.entry.findFirst({ where: { id, userId }, select: { readingProgress: true, archived: true } });
  if (!entry) return apiError(404, "not_found", "Entry not found");
  return Response.json({ id, reading_progress: entry.readingProgress, is_archived: Number(entry.archived) });
}
