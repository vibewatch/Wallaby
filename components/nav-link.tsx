"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import type { ReactNode } from "react";

export function NavLink({ href, children, className, label }: { href: string; children: ReactNode; className?: string; label: string }) {
  const pathname = usePathname();
  const params = useSearchParams();
  const [path, query = ""] = href.split("?");
  const target = new URLSearchParams(query);
  const active = pathname === path && (path !== "/entries"
    || (target.has("tag") ? params.get("tag") === target.get("tag")
      : target.has("focus") ? params.get("focus") === target.get("focus")
        : !params.has("tag") && !params.has("focus") && (params.get("view") ?? "unread") === target.get("view")));
  return <Link href={href} className={className} aria-label={label} aria-current={active ? "page" : undefined}>{children}</Link>;
}
