import { describe, expect, it } from "vitest";

import {
  clampProgress,
  isFinished,
  isStarted,
  mergeProgress,
  progressLabel,
  progressPercent,
  shouldResume,
} from "./reading-progress";

describe("clampProgress", () => {
  it("keeps values inside the unit range", () => {
    expect(clampProgress(-3)).toBe(0);
    expect(clampProgress(0)).toBe(0);
    expect(clampProgress(0.5)).toBe(0.5);
    expect(clampProgress(1)).toBe(1);
    expect(clampProgress(42)).toBe(1);
  });

  it("rounds to a millesimal so scroll jitter is not persisted", () => {
    expect(clampProgress(0.123456)).toBe(0.123);
    expect(clampProgress(0.4567)).toBe(0.457);
  });

  it("treats unusable input as no progress", () => {
    for (const value of [NaN, Infinity, -Infinity, "abc", null, undefined, {}]) {
      expect(clampProgress(value)).toBe(0);
    }
  });

  it("coerces numeric strings from form bodies", () => {
    expect(clampProgress("0.25")).toBe(0.25);
  });
});

describe("state predicates", () => {
  it("does not treat a nudge of the scrollbar as started", () => {
    expect(isStarted(0)).toBe(false);
    expect(isStarted(0.01)).toBe(false);
    expect(isStarted(0.02)).toBe(true);
  });

  it("separates in-progress from finished", () => {
    expect(isStarted(0.94)).toBe(true);
    expect(isStarted(0.95)).toBe(false);
    expect(isFinished(0.95)).toBe(true);
    expect(isFinished(1)).toBe(true);
    expect(isFinished(0.9)).toBe(false);
  });
});

describe("mergeProgress", () => {
  it("advances when the reader moves forward", () => {
    expect(mergeProgress(0.2, 0.6)).toBe(0.6);
  });

  it("keeps the furthest point when scrolling back to re-read", () => {
    expect(mergeProgress(0.8, 0.3)).toBe(0.8);
  });

  it("honours an explicit reset to the top", () => {
    expect(mergeProgress(0.8, 0)).toBe(0);
  });

  it("clamps both sides before comparing", () => {
    expect(mergeProgress(-1, 2)).toBe(1);
    expect(mergeProgress(5, 0.5)).toBe(1);
  });
});

describe("progress presentation", () => {
  it("renders whole percentages", () => {
    expect(progressPercent(0.4567)).toBe(46);
    expect(progressPercent(1)).toBe(100);
  });

  it("stays silent until reading actually began", () => {
    expect(progressLabel(0)).toBeNull();
    expect(progressLabel(0.01)).toBeNull();
  });

  it("labels partial and completed reads", () => {
    expect(progressLabel(0.42)).toBe("42% read");
    expect(progressLabel(0.97)).toBe("Finished");
  });
});

describe("shouldResume", () => {
  it("resumes an article left in the middle", () => {
    expect(shouldResume(0.4)).toBe(true);
    expect(shouldResume(0.94)).toBe(true);
  });

  it("does not resume an unread or barely-touched article", () => {
    expect(shouldResume(0)).toBe(false);
    expect(shouldResume(0.01)).toBe(false);
  });

  it("does not strand the reader at the end of a finished article", () => {
    expect(shouldResume(0.95)).toBe(false);
    expect(shouldResume(1)).toBe(false);
  });

  it("treats unusable stored values as unread", () => {
    expect(shouldResume(null)).toBe(false);
    expect(shouldResume(NaN)).toBe(false);
  });
});
