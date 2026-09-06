"use client";

import { ArrowUp, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useToast } from "@/components/toast";
import { clampProgress, progressPercent, shouldResume } from "@/lib/reading-progress";

/** How often an actively scrolling reader writes progress back to the server. */
const SAVE_INTERVAL_MS = 4_000;

/** Ignore sub-percent scroll jitter so a still page issues no writes. */
const SAVE_DELTA = 0.01;

type Props = {
  entryId: string;
  initialProgress: number;
  archiveOnFinish: boolean;
};

/**
 * Owns the reader's scroll position: paints the progress bar, restores where
 * the reader left off, and persists forward movement. The article itself stays
 * a server component; this only reads its geometry via `[data-reading-target]`.
 */
export function ReadingProgress({ entryId, initialProgress, archiveOnFinish }: Props) {
  const toast = useToast();
  const [progress, setProgress] = useState(clampProgress(initialProgress));
  const [dismissed, setDismissed] = useState(false);
  const saved = useRef(clampProgress(initialProgress));
  const latest = useRef(clampProgress(initialProgress));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Whether we resume depends only on the stored value, so it is derived rather
  // than discovered in the effect that performs the scroll.
  const resuming = shouldResume(initialProgress) && !dismissed;

  const persist = useCallback((value: number, beacon: boolean) => {
    if (value === saved.current || (Math.abs(value - saved.current) < SAVE_DELTA && value !== 1)) return;
    const body = JSON.stringify({ progress: value, archive: archiveOnFinish });
    const url = `/api/entries/${entryId}/progress`;
    // A page being unloaded cannot await fetch; sendBeacon survives teardown.
    if (beacon && typeof navigator !== "undefined" && navigator.sendBeacon?.(url, new Blob([body], { type: "application/json" }))) return;
    const failed = () => toast({ message: "Reading progress could not be saved. It will retry when you reconnect or continue reading.", tone: "danger" });
    void fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, keepalive: true }).then((response) => {
      if (response.ok) saved.current = value;
      else failed();
    }, failed);
  }, [archiveOnFinish, entryId, toast]);

  useEffect(() => {
    const target = document.querySelector<HTMLElement>("[data-reading-target]");
    if (!target) return;

    const measure = () => {
      const rect = target.getBoundingClientRect();
      const top = rect.top + window.scrollY;
      // The last viewport of an article is readable without scrolling, so the
      // scrollable span ends one viewport before the element's true bottom.
      const span = Math.max(1, target.offsetHeight - window.innerHeight * 0.65);
      return clampProgress((window.scrollY - top + window.innerHeight * 0.65) / span);
    };

    const onScroll = () => {
      const value = measure();
      latest.current = value;
      setProgress(value);
      if (timer.current) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        persist(latest.current, false);
      }, SAVE_INTERVAL_MS);
    };

    const onLeave = () => {
      if (timer.current) { clearTimeout(timer.current); timer.current = null; }
      persist(latest.current, true);
    };
    const onVisibility = () => { if (document.visibilityState === "hidden") onLeave(); };
    const onOnline = () => persist(latest.current, false);

    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    window.addEventListener("pagehide", onLeave);
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisibility);

    // Restore before the first scroll event so the reader lands where they
    // stopped rather than watching the page jump after they start reading.
    const start = clampProgress(initialProgress);
    if (shouldResume(start)) {
      const rect = target.getBoundingClientRect();
      const top = rect.top + window.scrollY;
      const span = Math.max(1, target.offsetHeight - window.innerHeight * 0.65);
      window.scrollTo({ top: top + start * span - window.innerHeight * 0.65, behavior: "instant" as ScrollBehavior });
    }
    onScroll();

    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("pagehide", onLeave);
      window.removeEventListener("online", onOnline);
      document.removeEventListener("visibilitychange", onVisibility);
      onLeave();
    };
  }, [initialProgress, persist]);

  return (
    <>
      <div className="reading-progress-bar" role="progressbar" aria-label="Reading progress" aria-valuenow={progressPercent(progress)} aria-valuemin={0} aria-valuemax={100}>
        <span style={{ transform: `scaleX(${clampProgress(progress)})` }} />
      </div>
      {resuming ? (
        <div className="resume-notice" role="status">
          <span>Picked up where you left off.</span>
          <button type="button" onClick={() => { window.scrollTo({ top: 0, behavior: "smooth" }); setDismissed(true); }}>
            <ArrowUp size={13} /> Start from the top
          </button>
          <button type="button" className="resume-dismiss" aria-label="Dismiss" onClick={() => setDismissed(true)}><X size={13} /></button>
        </div>
      ) : null}
    </>
  );
}
