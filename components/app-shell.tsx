import { Archive, BookOpenText, CircleHelp, CircleUserRound, Clock3, Highlighter, Import, Library, LogOut, Search, Settings, Shield, Star, Tags } from "lucide-react";
import Link from "next/link";

import { logout } from "@/lib/actions";
import { KeyboardShortcuts } from "@/components/keyboard-shortcuts";
import { MobileMenu } from "@/components/mobile-menu";
import { ThemeToggle } from "@/components/theme-toggle";
import { ToastProvider } from "@/components/toast";
import type { Theme } from "@/lib/theme";

type AppShellProps = {
  children: React.ReactNode;
  user: { name?: string | null; email?: string | null; role: "USER" | "ADMIN" };
  theme: Theme;
  counts: { all: number; unread: number; archive: number; starred: number; annotated: number; untagged: number };
  tags: { id: string; label: string; slug: string; _count: { entries: number } }[];
};

const navigation = [
  { key: "unread", label: "Unread", icon: Clock3 },
  { key: "starred", label: "Starred", icon: Star },
  { key: "archive", label: "Archive", icon: Archive },
  { key: "all", label: "All entries", icon: Library },
  { key: "annotated", label: "Annotated", icon: Highlighter },
  { key: "untagged", label: "Untagged", icon: Tags },
];

export function AppShell({ children, user, theme, counts, tags }: AppShellProps) {
  return (
    <ToastProvider>
      <div className="app-shell">
        <aside className="sidebar">
          <Link className="brand" href="/entries?view=unread">
            <span className="brand-mark"><BookOpenText size={20} strokeWidth={1.8} /></span>
            <span>wallaby</span>
          </Link>
          <nav className="sidebar-nav" aria-label="Library">
            <p className="nav-heading">Library</p>
            {navigation.map(({ key, label, icon: Icon }) => (
              <Link href={`/entries?view=${key}`} key={key}>
                <Icon size={17} /><span>{label}</span><small>{counts[key as keyof typeof counts]}</small>
              </Link>
            ))}
            <Link href="/entries?focus=search"><Search size={17} /><span>Search</span></Link>
            <Link href="/entries/import"><Import size={17} /><span>Import & export</span></Link>
          </nav>
          <nav className="sidebar-nav tag-nav" aria-label="Tags">
            <p className="nav-heading"><span>Tags</span><Tags size={14} /></p>
            {tags.slice(0, 8).map((tag) => (
              <Link href={`/entries?tag=${encodeURIComponent(tag.slug)}`} key={tag.id}>
                <span className="tag-dot" /> <span>{tag.label}</span><small>{tag._count.entries}</small>
              </Link>
            ))}
            {!tags.length ? <p className="sidebar-empty">Tags appear here as you organize entries.</p> : null}
          </nav>
          <MobileMenu isAdmin={user.role === "ADMIN"} />
          <div className="sidebar-footer">
            <div className="profile-chip">
              <CircleUserRound size={26} />
              <span><strong>{user.name ?? "Reader"}</strong><small>{user.email ?? "Local account"}</small></span>
            </div>
            <div className="footer-actions">
              <Link href="/entries/help" aria-label="Help & quick start"><CircleHelp size={17} /></Link>
              {user.role === "ADMIN" ? <Link href="/entries/admin" aria-label="Administration"><Shield size={17} /></Link> : null}
              <Link href="/entries/settings" aria-label="Settings"><Settings size={17} /></Link>
              <form action={logout}><button aria-label="Sign out"><LogOut size={17} /></button></form>
            </div>
          </div>
          <ThemeToggle theme={theme} />
        </aside>
        <main className="main-stage">{children}</main>
        <KeyboardShortcuts />
      </div>
    </ToastProvider>
  );
}
