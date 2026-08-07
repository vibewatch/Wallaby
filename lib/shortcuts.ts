/** Views reachable with the `g` prefix, in the order they appear in the sidebar. */
export const goToViews = {
  u: { view: "unread", label: "Unread" },
  s: { view: "starred", label: "Starred" },
  a: { view: "archive", label: "Archive" },
  l: { view: "all", label: "All entries" },
  n: { view: "annotated", label: "Annotated" },
  t: { view: "untagged", label: "Untagged" },
} as const;

export type GoToKey = keyof typeof goToViews;

export function isGoToKey(key: string): key is GoToKey {
  return Object.hasOwn(goToViews, key);
}

/** How long the `g` prefix waits for its second key before lapsing. */
export const CHORD_TIMEOUT_MS = 1_500;

export type ShortcutHint = { keys: string; description: string };
export type ShortcutGroup = { title: string; hints: ShortcutHint[] };

export const shortcutGroups: ShortcutGroup[] = [
  {
    title: "Anywhere",
    hints: [
      { keys: "?", description: "Show this list" },
      { keys: "/", description: "Search your library" },
      { keys: "g then u", description: "Go to Unread" },
      { keys: "g then s", description: "Go to Starred" },
      { keys: "g then a", description: "Go to Archive" },
      { keys: "g then l", description: "Go to All entries" },
      { keys: "g then n", description: "Go to Annotated" },
      { keys: "g then t", description: "Go to Untagged" },
      { keys: "Esc", description: "Close this list or leave the search box" },
    ],
  },
  {
    title: "In the library",
    hints: [
      { keys: "j", description: "Focus the next entry" },
      { keys: "k", description: "Focus the previous entry" },
      { keys: "o or Enter", description: "Open the focused entry" },
      { keys: "s", description: "Star or unstar the focused entry" },
      { keys: "e", description: "Archive or unarchive the focused entry" },
      { keys: "v", description: "Open the original article in a new tab" },
    ],
  },
  {
    title: "While reading",
    hints: [
      { keys: "j", description: "Scroll down" },
      { keys: "k", description: "Scroll up" },
      { keys: "s", description: "Star or unstar" },
      { keys: "e", description: "Archive or unarchive" },
      { keys: "r", description: "Fetch the article again" },
      { keys: "v", description: "Open the original article in a new tab" },
      { keys: "b", description: "Back to the library" },
    ],
  },
];

type EditableTarget = {
  tagName?: string;
  isContentEditable?: boolean;
  closest?: (selector: string) => unknown;
};

/**
 * Typing must always win over shortcuts, otherwise the letters of a search
 * query would each fire an action instead of reaching the field.
 */
export function isEditableTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const element = target as EditableTarget;
  if (element.isContentEditable) return true;
  const tag = typeof element.tagName === "string" ? element.tagName.toUpperCase() : "";
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return typeof element.closest === "function" && Boolean(element.closest("[contenteditable='true']"));
}

type KeyEventLike = {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  target?: unknown;
};

/**
 * Single, unmodified keys only: browser and OS chords (Cmd+R, Ctrl+F, …) keep
 * their meaning, and anything typed into a field is left alone.
 */
export function shouldHandleKey(event: KeyEventLike): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey) return false;
  if (isEditableTarget(event.target)) return false;
  return event.key.length === 1 || event.key === "Enter" || event.key === "Escape";
}

/** Normalizes to the lowercase character used by the shortcut table. */
export function shortcutKey(event: KeyEventLike): string {
  return event.key.length === 1 ? event.key.toLowerCase() : event.key;
}

/** Moves the focus ring, stopping at either end rather than wrapping around. */
export function nextIndex(current: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  if (current < 0) return delta > 0 ? 0 : length - 1;
  return Math.min(length - 1, Math.max(0, current + delta));
}
