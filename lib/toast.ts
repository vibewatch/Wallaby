/**
 * Feedback for entry mutations. A completed action returns both a sentence for
 * the reader and, where the change is exactly reversible, the data needed to
 * reverse it — so the client never carries mutation logic and a single server
 * action can apply any undo.
 */

export type ToastTone = "info" | "success" | "danger";

/**
 * The state the affected entries were in before the action ran. `on` and `off`
 * are explicit id lists rather than a single boolean because a bulk toggle
 * flips entries that started in different states.
 */
export type UndoToken =
  | { kind: "archive"; on: string[]; off: string[] }
  | { kind: "star"; on: string[]; off: string[] };

export type ActionResult = { message: string; tone?: ToastTone; undo?: UndoToken } | null;

export const undoKinds = ["archive", "star"] as const;

/** Bulk actions are already capped at 100 entries; mirror that on the way back. */
const MAX_UNDO_IDS = 100;

/**
 * Builds the token that restores `previous`. Pass the value each entry held
 * *before* the action, and applying the token puts it back.
 */
export function undoFor(kind: UndoToken["kind"], previous: { id: string; value: boolean }[]): UndoToken | undefined {
  const on = previous.filter((entry) => entry.value).map((entry) => entry.id);
  const off = previous.filter((entry) => !entry.value).map((entry) => entry.id);
  if (!on.length && !off.length) return undefined;
  return { kind, on, off };
}

/** Undo tokens make a round trip through the client, so re-validate on arrival. */
export function parseUndoToken(value: unknown): UndoToken | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const token = value as Record<string, unknown>;
  if (!(undoKinds as readonly string[]).includes(token.kind as string)) return null;
  const on = parseIds(token.on);
  const off = parseIds(token.off);
  if (!on.length && !off.length) return null;
  return { kind: token.kind as UndoToken["kind"], on, off };
}

function parseIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 64);
  return [...new Set(ids)].slice(0, MAX_UNDO_IDS);
}

export function pluralizeEntries(count: number): string {
  return `${count} ${count === 1 ? "entry" : "entries"}`;
}
