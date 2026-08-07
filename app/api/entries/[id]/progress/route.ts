import { z } from "zod";

import { authenticateApiRequest, unauthorized } from "@/lib/api-auth";
import { apiError, apiRequestObject } from "@/lib/api-response";
import { db } from "@/lib/db";
import { clampProgress, isFinished, mergeProgress } from "@/lib/reading-progress";

type Context = { params: Promise<{ id: string }> };

/**
 * Called repeatedly while an article is being read, so it stays deliberately
 * small: no revalidation, no entry payload in the response, and a single
 * ownership-scoped write.
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

  const entry = await db.entry.findFirst({ where: { id, userId }, select: { readingProgress: true, archived: true } });
  if (!entry) return apiError(404, "not_found", "Entry not found");

  const progress = mergeProgress(entry.readingProgress, parsed.data.progress);
  if (progress === clampProgress(entry.readingProgress) && progress !== 0) {
    return Response.json({ id, reading_progress: progress, is_archived: Number(entry.archived) });
  }

  // Auto-archiving on completion is opt-in per request so a reader that merely
  // scrolls past the end never silently loses the entry from its unread view.
  const archiveOnFinish = parsed.data.archive === true || parsed.data.archive === "1";
  const archive = archiveOnFinish && isFinished(progress) && !entry.archived;

  await db.entry.update({
    where: { id },
    data: {
      readingProgress: progress,
      readingProgressAt: new Date(),
      ...(archive ? { archived: true, archivedAt: new Date() } : {}),
    },
  });

  return Response.json({ id, reading_progress: progress, is_archived: Number(entry.archived || archive) });
}
