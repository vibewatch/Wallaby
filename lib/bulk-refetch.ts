import { db } from "@/lib/db";
import { reloadEntry } from "@/lib/entries";

/**
 * Fetching many articles again can take minutes, longer than a request should
 * stay open, so a bulk refetch runs after the response. Each reload replaces an
 * entry's copy only when its fetch succeeds, so an interrupted batch loses
 * nothing. One batch per user runs at a time within this process.
 */

const concurrency = 3;
const running = new Set<string>();

export type RefetchSummary = { fetched: number; incomplete: number; failed: number };
type Reload = (userId: string, entryId: string) => Promise<{ isNotParsed: boolean }>;

export async function ownedEntryIds(userId: string, entryIds: string[]): Promise<string[]> {
  const ids = [...new Set(entryIds.map((id) => id.trim()).filter(Boolean))].slice(0, 100);
  if (!ids.length) return [];
  const entries = await db.entry.findMany({ where: { userId, id: { in: ids } }, select: { id: true } });
  return entries.map(({ id }) => id);
}

/**
 * Claims the user's slot now, so a second submission is refused even before
 * the first batch has begun, and hands the batch to `schedule` (`after()` in
 * a server action). Returns false while another batch is still running.
 */
export function startBulkRefetch(
  userId: string,
  entryIds: string[],
  { schedule, reload = reloadEntry, onDone }: { schedule: (task: () => Promise<void>) => void; reload?: Reload; onDone?: (summary: RefetchSummary) => void },
): boolean {
  if (running.has(userId)) return false;
  running.add(userId);
  try {
    schedule(async () => {
      try { onDone?.(await refetchAll(userId, entryIds, reload)); }
      finally { running.delete(userId); }
    });
  } catch (error) {
    running.delete(userId);
    throw error;
  }
  return true;
}

async function refetchAll(userId: string, entryIds: string[], reload: Reload): Promise<RefetchSummary> {
  const summary: RefetchSummary = { fetched: 0, incomplete: 0, failed: 0 };
  const queue = [...entryIds];
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (let entryId = queue.shift(); entryId; entryId = queue.shift()) {
      try {
        const entry = await reload(userId, entryId);
        if (entry.isNotParsed) summary.incomplete += 1;
        else summary.fetched += 1;
      } catch {
        summary.failed += 1;
      }
    }
  }));
  return summary;
}
