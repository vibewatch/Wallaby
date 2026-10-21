import { Archive, BookOpenText, CircleHelp, CircleUserRound, Clock3, Highlighter, Import, Library, LogOut, Plus, Search, Settings, Shield, Star, Tags } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";

import { logout } from "@/lib/actions";
import { KeyboardShortcuts } from "@/components/keyboard-shortcuts";
import { MobileMenu } from "@/components/mobile-menu";
import { NavLink } from "@/components/nav-link";
import { ThemeToggle } from "@/components/theme-toggle";
import { ToastProvider } from "@/components/toast";
import type { Theme } from "@/lib/theme";

type AppShellProps = {
  children: React.ReactNode;
  user: { name?: string | null; email?: string | null; role: "USER" | "ADMIN" };
  theme: Theme;
  counts: { all: number; unread: number; archive: number; starred: number; annotated: number; untagged: number };
  /** The most used tags, at most eight. */
  tags: { id: string; label: string; slug: string; _count: { entries: number } }[];
  tagCount: number;
};

const navigation = [
  { key: "unread", label: "Unread", icon: Clock3 },
  { key: "starred", label: "Starred", icon: Star },
  { key: "archive", label: "Archive", icon: Archive },
  { key: "all", label: "All entries", icon: Library },
  { key: "annotated", label: "Annotated", icon: Highlighter },
  { key: "untagged", label: "Untagged", icon: Tags },
];

export function AppShell({ children, user, theme, counts, tags, tagCount }: AppShellProps) {
  return (
    <ToastProvider>
      <a className="skip-link" href="#main-content">Skip to content</a>
      <div className="app-shell">
        <aside className="sidebar">
          <Link className="brand" href="/entries?view=unread">
            <span className="brand-mark"><BookOpenText size={20} strokeWidth={1.8} /></span>
            <span>wallaby</span>
          </Link>
          <Link className="sidebar-save primary-button" href="/entries/new" aria-label="Save a link"><Plus size={18} /><span>Save a link</span></Link>
          <div className="sidebar-sections">
            <Suspense fallback={null}>
              <nav className="sidebar-nav" aria-label="Library">
                <p className="nav-heading">Library</p>
                {navigation.map(({ key, label, icon: Icon }) => (
                  <NavLink href={`/entries?view=${key}`} key={key} label={label}>
                    <Icon size={17} /><span>{label}</span><small>{counts[key as keyof typeof counts]}</small>
                  </NavLink>
                ))}
                <NavLink href="/entries?focus=search" label="Search"><Search size={17} /><span>Search</span></NavLink>
                <NavLink href="/entries/import" label="Import & export"><Import size={17} /><span>Import & export</span></NavLink>
              </nav>
              <nav className="sidebar-nav tag-nav" aria-label="Tags">
                <p className="nav-heading"><span>Tags</span><Tags size={14} /></p>
                {tags.map((tag) => (
                  // The count covers every entry with the tag, so the link must too.
                  <NavLink href={`/entries?view=all&tag=${encodeURIComponent(tag.slug)}`} key={tag.id} label={tag.label}>
                    <span className="tag-dot" /> <span>{tag.label}</span><small>{tag._count.entries}</small>
                  </NavLink>
                ))}
                {tagCount ? <NavLink href="/entries/tags" className="all-tags-link" label="All tags"><Tags size={15} /><span>All tags</span><small>{tagCount}</small></NavLink> : null}
                {!tags.length ? <p className="sidebar-empty">Tags appear here as you organize entries.</p> : null}
              </nav>
            </Suspense>
          </div>
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
        <main className="main-stage" id="main-content" tabIndex={-1}>{children}</main>
        <Suspense fallback={null}><KeyboardShortcuts /></Suspense>
      </div>
    </ToastProvider>
  );
}
