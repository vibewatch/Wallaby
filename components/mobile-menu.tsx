"use client";

import { CircleHelp, Highlighter, Import, LogOut, Menu, Search, Settings, Shield, Tags } from "lucide-react";
import Link from "next/link";
import { useState } from "react";

import { logout } from "@/lib/actions";

export function MobileMenu({ isAdmin }: { isAdmin: boolean }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  return (
    <details className="mobile-menu" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary aria-label="More navigation"><Menu size={20} /></summary>
      <nav aria-label="More">
        <Link href="/entries?view=annotated" onClick={close}><Highlighter size={17} /><span>Annotated</span></Link>
        <Link href="/entries/tags" onClick={close}><Tags size={17} /><span>Tags</span></Link>
        <Link href="/entries?view=untagged" onClick={close}><Tags size={17} /><span>Untagged</span></Link>
        <Link href="/entries?focus=search" onClick={close}><Search size={17} /><span>Search</span></Link>
        <Link href="/entries/import" onClick={close}><Import size={17} /><span>Import & export</span></Link>
        <Link href="/entries/help" onClick={close}><CircleHelp size={17} /><span>Help & quick start</span></Link>
        {isAdmin ? <Link href="/entries/admin" onClick={close}><Shield size={17} /><span>Administration</span></Link> : null}
        <Link href="/entries/settings" onClick={close}><Settings size={17} /><span>Settings</span></Link>
        <form action={logout} onSubmit={close}><button><LogOut size={17} /><span>Sign out</span></button></form>
      </nav>
    </details>
  );
}
