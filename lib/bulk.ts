import { createHash } from "node:crypto";

import { deleteEntriesWithMedia } from "@/lib/article-images";
import { db } from "@/lib/db";
import { slugify } from "@/lib/entries";
import { parseTags } from "@/lib/text";

export const bulkEntryActions = ["toggle-read", "toggle-star", "archive", "unarchive", "star", "unstar", "tag", "add-tags", "remove-tags", "delete"] as const;
export type BulkEntryAction = (typeof bulkEntryActions)[number];

export async function applyBulkEntryAction(userId: string, entryIds: string[], action: BulkEntryAction, tagInput?: string | string[]): Promise<number> {
  const ids = [...new Set(entryIds.map((id) => id.trim()).filter(Boolean))].slice(0, 100);
  if (!ids.length) throw new Error("Select at least one entry");
  const entries = await db.entry.findMany({ where: { userId, id: { in: ids } }, select: { id: true, archived: true, starred: true } });
  if (!entries.length) return 0;
  const ownedIds = entries.map((entry) => entry.id);

  if (action === "delete") {
    const deleted = await deleteEntriesWithMedia(userId, { id: { in: ownedIds } });
    await cleanupOrphanTags(userId);
    return deleted;
  }
  if (action === "toggle-read") {
    const archived = entries.filter((entry) => entry.archived).map((entry) => entry.id);
    const unread = entries.filter((entry) => !entry.archived).map((entry) => entry.id);
    await db.$transaction([
      db.entry.updateMany({ where: { userId, id: { in: archived } }, data: { archived: false, archivedAt: null } }),
      db.entry.updateMany({ where: { userId, id: { in: unread } }, data: { archived: true, archivedAt: new Date() } }),
    ]);
    return entries.length;
  }
  if (action === "toggle-star") {
    const starred = entries.filter((entry) => entry.starred).map((entry) => entry.id);
    const unstarred = entries.filter((entry) => !entry.starred).map((entry) => entry.id);
    await db.$transaction([
      db.entry.updateMany({ where: { userId, id: { in: starred } }, data: { starred: false, starredAt: null } }),
      db.entry.updateMany({ where: { userId, id: { in: unstarred } }, data: { starred: true, starredAt: new Date() } }),
    ]);
    return entries.length;
  }
  if (["archive", "unarchive", "star", "unstar"].includes(action)) {
    const archive = action === "archive" ? true : action === "unarchive" ? false : undefined;
    const star = action === "star" ? true : action === "unstar" ? false : undefined;
    await db.entry.updateMany({
      where: { userId, id: { in: ownedIds } },
      data: {
        archived: archive,
        archivedAt: archive === undefined ? undefined : archive ? new Date() : null,
        starred: star,
        starredAt: star === undefined ? undefined : star ? new Date() : null,
      },
    });
    return entries.length;
  }

  const rawTags = parseTags(tagInput);
  const addLabels = action === "remove-tags" ? [] : rawTags.filter((tag) => action === "add-tags" || !tag.startsWith("-")).map((tag) => tag.replace(/^\+/, "").trim()).filter(Boolean);
  const removeLabels = action === "add-tags" ? [] : rawTags.filter((tag) => action === "remove-tags" || tag.startsWith("-")).map((tag) => tag.replace(/^-/, "").trim()).filter(Boolean);
  if (!addLabels.length && !removeLabels.length) throw new Error("Add at least one tag; prefix a tag with - to remove it");

  if (addLabels.length) {
    await db.$transaction(ownedIds.map((id) => db.entry.update({
      where: { id },
      data: { tags: { connectOrCreate: addLabels.map((label) => {
        const slug = slugify(label) || createHash("sha256").update(label).digest("hex").slice(0, 12);
        return { where: { userId_slug: { userId, slug } }, create: { userId, label, slug } };
      }) } },
    })));
  }
  if (removeLabels.length) {
    const removeSlugs = removeLabels.map((label) => slugify(label) || createHash("sha256").update(label).digest("hex").slice(0, 12));
    const tags = await db.tag.findMany({ where: { userId, slug: { in: removeSlugs } }, select: { id: true } });
    if (tags.length) await db.$transaction(ownedIds.map((id) => db.entry.update({ where: { id }, data: { tags: { disconnect: tags } } })));
    await cleanupOrphanTags(userId);
  }
  return entries.length;
}

async function cleanupOrphanTags(userId: string) {
  await db.tag.deleteMany({ where: { userId, entries: { none: {} } } });
}
