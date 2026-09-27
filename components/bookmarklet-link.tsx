"use client";

import { BookmarkPlus } from "lucide-react";
import { useEffect, useRef } from "react";

import { bookmarkletSource } from "@/lib/share-target";

/**
 * React refuses to render `javascript:` hrefs, so the bookmarklet address is
 * set on the element after mount. It points at whichever origin is serving the
 * page, which keeps it correct behind a reverse proxy or a custom domain.
 */
export function BookmarkletLink() {
  const anchor = useRef<HTMLAnchorElement>(null);
  useEffect(() => {
    anchor.current?.setAttribute("href", bookmarkletSource(window.location.origin));
  }, []);
  return (
    <a
      ref={anchor}
      className="bookmarklet-link"
      draggable
      // Clicking it here would only save this help page; it is meant to be dragged.
      onClick={(event) => event.preventDefault()}
      title="Drag to your bookmarks bar"
    >
      <BookmarkPlus size={14} /> Save to Wallaby
    </a>
  );
}
