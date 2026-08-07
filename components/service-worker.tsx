"use client";

import { useEffect } from "react";

/**
 * Registers the service worker that makes Wallaby installable and gives it an
 * offline shell. Registration is best-effort: a failure here must never keep
 * the app itself from loading.
 */
export function ServiceWorker() {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    // Dev builds recompile constantly; a stale worker there causes more
    // confusion than the offline shell is worth.
    if (process.env.NODE_ENV !== "production") return;
    const register = () => void navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => {});
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);

  return null;
}
