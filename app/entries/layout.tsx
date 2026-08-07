import { AppShell } from "@/components/app-shell";
import { requireUser } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { parseTheme } from "@/lib/theme";

export default async function EntriesLayout({ children }: { children: React.ReactNode }) {
  const user = await requireUser();
  const [profile, preference, all, unread, archive, starred, annotated, untagged, tags] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: user.id }, select: { name: true, email: true, role: true } }),
    db.userPreference.findUnique({ where: { userId: user.id }, select: { theme: true } }),
    db.entry.count({ where: { userId: user.id } }),
    db.entry.count({ where: { userId: user.id, archived: false } }),
    db.entry.count({ where: { userId: user.id, archived: true } }),
    db.entry.count({ where: { userId: user.id, starred: true } }),
    db.entry.count({ where: { userId: user.id, annotations: { some: {} } } }),
    db.entry.count({ where: { userId: user.id, tags: { none: {} } } }),
    db.tag.findMany({ where: { userId: user.id }, include: { _count: { select: { entries: true } } }, orderBy: { label: "asc" } }),
  ]);
  return (
    <AppShell
      user={profile}
      theme={parseTheme(preference?.theme)}
      counts={{ all, unread, archive, starred, annotated, untagged }}
      tags={tags}
    >
      {children}
    </AppShell>
  );
}
