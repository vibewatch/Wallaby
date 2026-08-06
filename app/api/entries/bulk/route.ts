import { z } from "zod";

import { authenticateApiRequest, unauthorized } from "@/lib/api-auth";
import { applyBulkEntryAction, bulkEntryActions } from "@/lib/bulk";

export async function POST(request: Request) {
  const userId = await authenticateApiRequest(request);
  if (!userId) return unauthorized();
  const parsed = z.object({
    ids: z.array(z.string().min(1)).min(1).max(100),
    action: z.enum(bulkEntryActions),
    tags: z.union([z.string(), z.array(z.string())]).optional(),
  }).safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "Invalid bulk operation", issues: parsed.error.issues }, { status: 400 });
  try {
    const processed = await applyBulkEntryAction(userId, parsed.data.ids, parsed.data.action, parsed.data.tags);
    return Response.json({ action: parsed.data.action, processed });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Bulk operation failed" }, { status: 400 });
  }
}
