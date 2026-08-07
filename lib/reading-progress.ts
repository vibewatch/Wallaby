/**
 * Reading progress is stored as a fraction of the article scrolled, not a pixel
 * offset, so a position recorded on a phone still resolves on a wide desktop
 * reader or after a font-size change.
 */

/** Below this the reader has barely moved; treat it as "not started". */
export const PROGRESS_STARTED = 0.02;

/** Long articles rarely scroll to a literal 1.0, so finishing is generous. */
export const PROGRESS_FINISHED = 0.95;

export function clampProgress(value: unknown): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, Math.round(number * 1000) / 1000));
}

export function isStarted(progress: number): boolean {
  return progress >= PROGRESS_STARTED && progress < PROGRESS_FINISHED;
}

export function isFinished(progress: number): boolean {
  return progress >= PROGRESS_FINISHED;
}

export function progressPercent(progress: number): number {
  return Math.round(clampProgress(progress) * 100);
}

/**
 * Progress only ever moves forward on its own. Scrolling back up to re-read a
 * paragraph should not discard how far the reader actually got, so a lower
 * value is accepted only when it is an explicit reset to the start.
 */
export function mergeProgress(stored: number, incoming: number): number {
  const next = clampProgress(incoming);
  if (next === 0) return 0;
  return Math.max(clampProgress(stored), next);
}

export function progressLabel(progress: number): string | null {
  const percent = progressPercent(progress);
  if (isFinished(progress)) return "Finished";
  if (percent < PROGRESS_STARTED * 100) return null;
  return `${percent}% read`;
}

/**
 * Whether opening the entry should jump back to the saved position. Restoring a
 * barely-started article is noise, and restoring a finished one would strand
 * the reader at the bottom of something they already closed.
 */
export function shouldResume(progress: unknown): boolean {
  return isStarted(clampProgress(progress));
}
