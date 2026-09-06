"use client";

import { Keyboard, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  CHORD_TIMEOUT_MS,
  goToViews,
  isGoToKey,
  nextIndex,
  shortcutGroups,
  shortcutKey,
  shouldHandleKey,
} from "@/lib/shortcuts";

const CARD_SELECTOR = "[data-entry-card]";

/**
 * Global keyboard layer for the signed-in app. Actions live in server-action
 * forms already rendered on the page, so a shortcut clicks the matching
 * `[data-shortcut]` control rather than duplicating the mutation logic.
 */
export function KeyboardShortcuts() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [helpOpen, setHelpOpen] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const chord = useRef<{ key: string; timer: ReturnType<typeof setTimeout> } | null>(null);

  const clearChord = useCallback(() => {
    if (chord.current) clearTimeout(chord.current.timer);
    chord.current = null;
  }, []);

  const focusSearch = useCallback(() => {
    const input = document.querySelector<HTMLInputElement>('.search-bar input[name="q"]');
    if (!input) return false;
    input.focus();
    input.select();
    return true;
  }, []);

  // The sidebar's Search link carries ?focus=search; honour it on arrival.
  useEffect(() => {
    if (searchParams.get("focus") === "search") focusSearch();
  }, [focusSearch, pathname, searchParams]);

  // <dialog> is driven imperatively so it gets the native focus trap, inert
  // background, and Escape handling instead of hand-rolled equivalents.
  useEffect(() => {
    const node = dialog.current;
    if (!node) return;
    if (helpOpen && !node.open) node.showModal();
    if (!helpOpen && node.open) node.close();
  }, [helpOpen]);

  // Paint the focus ring on whichever card the keyboard is pointing at.
  useEffect(() => {
    for (const card of document.querySelectorAll<HTMLElement>(CARD_SELECTOR)) {
      if (card.dataset.entryCard === activeId) card.dataset.active = "true";
      else delete card.dataset.active;
    }
  }, [activeId]);

  useEffect(() => {
    const cards = () => Array.from(document.querySelectorAll<HTMLElement>(CARD_SELECTOR));
    const reader = () => document.querySelector<HTMLElement>("[data-reading-target]");

    const trigger = (scope: HTMLElement | Document, name: string) => {
      const control = scope.querySelector<HTMLElement>(`[data-shortcut="${name}"]`);
      control?.click();
      return Boolean(control);
    };

    const move = (delta: number) => {
      const list = cards();
      if (!list.length) return;
      const current = list.findIndex((card) => card.dataset.entryCard === activeId);
      const target = list[nextIndex(current, delta, list.length)];
      if (!target) return;
      setActiveId(target.dataset.entryCard ?? null);
      target.scrollIntoView({ block: "nearest", behavior: "smooth" });
    };

    const activeCard = () => cards().find((card) => card.dataset.entryCard === activeId) ?? null;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && document.activeElement instanceof HTMLElement) {
        // Escape inside the search field returns control to the shortcut layer.
        if (document.activeElement.closest(".search-bar")) document.activeElement.blur();
      }
      if (!shouldHandleKey(event)) return;
      const key = shortcutKey(event);

      if (helpOpen) {
        if (key === "Escape" || key === "?") { event.preventDefault(); setHelpOpen(false); }
        return;
      }

      if (chord.current?.key === "g") {
        clearChord();
        if (isGoToKey(key)) {
          event.preventDefault();
          router.push(`/entries?view=${goToViews[key].view}`);
        }
        return;
      }

      const article = reader();

      switch (key) {
        case "?":
          event.preventDefault();
          setHelpOpen(true);
          return;
        case "/":
          if (focusSearch()) event.preventDefault();
          return;
        case "g":
          event.preventDefault();
          clearChord();
          chord.current = { key: "g", timer: setTimeout(clearChord, CHORD_TIMEOUT_MS) };
          return;
        case "Escape":
          setActiveId(null);
          return;
      }

      if (article) {
        switch (key) {
          case "j":
            event.preventDefault();
            window.scrollBy({ top: window.innerHeight * 0.45, behavior: "smooth" });
            return;
          case "k":
            event.preventDefault();
            window.scrollBy({ top: -window.innerHeight * 0.45, behavior: "smooth" });
            return;
          case "b":
            event.preventDefault();
            router.push("/entries");
            return;
          case "s":
          case "e":
          case "r":
          case "v":
            if (trigger(document, readerActions[key])) event.preventDefault();
            return;
        }
        return;
      }

      switch (key) {
        case "j":
          event.preventDefault();
          move(1);
          return;
        case "k":
          event.preventDefault();
          move(-1);
          return;
        case "o":
        case "Enter":
        case "s":
        case "e":
        case "v": {
          const card = activeCard();
          if (!card) return;
          if (trigger(card, key === "o" || key === "Enter" ? "open" : cardActions[key])) event.preventDefault();
          return;
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeId, clearChord, focusSearch, helpOpen, router]);

  useEffect(() => clearChord, [clearChord]);

  return (
    <dialog className="shortcut-help" ref={dialog} onClose={() => setHelpOpen(false)} aria-label="Keyboard shortcuts">
      <div className="shortcut-help-head">
        <h2><Keyboard size={18} /> Keyboard shortcuts</h2>
        <button type="button" onClick={() => setHelpOpen(false)} aria-label="Close"><X size={16} /></button>
      </div>
      <div className="shortcut-help-grid">
        {shortcutGroups.map((group) => (
          <section key={group.title}>
            <h3>{group.title}</h3>
            <dl>
              {group.hints.map((hint) => (
                <div key={hint.keys}>
                  <dt>{hint.keys.split(" ").map((part, index) => part === "then" || part === "or"
                    ? <span key={index}> {part} </span>
                    : <kbd key={index}>{part}</kbd>)}</dt>
                  <dd>{hint.description}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </dialog>
  );
}

const readerActions: Record<string, string> = { s: "star", e: "archive", r: "refetch", v: "original" };
const cardActions: Record<string, string> = { s: "star", e: "archive", v: "original" };
