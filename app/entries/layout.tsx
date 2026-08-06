import { AppShell } from "@/components/app-shell";
import { requireUser } from "@/lib/auth-user";
import { db } from "@/lib/db";

export default async function EntriesLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const [profile, all, unread, archive, starred, annotated, untagged, tags] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: user.id }, select: { name: true, email: true, role: true } }),
    db.entry.count({ where: { userId: user.id } }),
    db.entry.count({ where: { userId: user.id, archived: false } }),
    db.entry.count({ where: { userId: user.id, archived: true } }),
    db.entry.count({ where: { userId: user.id, starred: true } }),
    db.entry.count({ where: { userId: user.id, annotations: { some: {} } } }),
    db.entry.count({ where: { userId: user.id, tags: { none: {} } } }),
    db.tag.findMany({ where: { userId: user.id }, include: { _count: { select: { entries: true } } }, orderBy: { label: "asc" } }),
  ]);
  return <AppShell user={profile} counts={{ all, unread, archive, starred, annotated, untagged }} tags={tags}>{children}</AppShell>;
}
