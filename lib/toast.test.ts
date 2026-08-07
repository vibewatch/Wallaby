import { describe, expect, it } from "vitest";

import { parseUndoToken, pluralizeEntries, undoFor } from "./toast";

describe("undoFor", () => {
  it("records the state a single entry came from", () => {
    expect(undoFor("archive", [{ id: "a", value: false }])).toEqual({ kind: "archive", on: [], off: ["a"] });
    expect(undoFor("star", [{ id: "a", value: true }])).toEqual({ kind: "star", on: ["a"], off: [] });
  });

  it("splits a bulk toggle by each entry's prior state", () => {
    expect(undoFor("archive", [
      { id: "a", value: true },
      { id: "b", value: false },
      { id: "c", value: true },
    ])).toEqual({ kind: "archive", on: ["a", "c"], off: ["b"] });
  });

  it("offers no undo when nothing was affected", () => {
    expect(undoFor("archive", [])).toBeUndefined();
  });
});

describe("parseUndoToken", () => {
  it("accepts a token it produced", () => {
    const token = undoFor("archive", [{ id: "a", value: true }, { id: "b", value: false }]);
    expect(parseUndoToken(token)).toEqual(token);
  });

  it("rejects unknown or malformed kinds", () => {
    expect(parseUndoToken({ kind: "delete", on: ["a"], off: [] })).toBeNull();
    expect(parseUndoToken({ kind: 7, on: ["a"], off: [] })).toBeNull();
    expect(parseUndoToken({ on: ["a"], off: [] })).toBeNull();
  });

  it("rejects values that are not tokens at all", () => {
    for (const value of [null, undefined, "archive", 12, [], [{ kind: "archive" }]]) {
      expect(parseUndoToken(value)).toBeNull();
    }
  });

  it("rejects a token that would change nothing", () => {
    expect(parseUndoToken({ kind: "archive", on: [], off: [] })).toBeNull();
    expect(parseUndoToken({ kind: "archive", on: "a", off: 3 })).toBeNull();
  });

  it("drops entries that are not usable ids", () => {
    expect(parseUndoToken({ kind: "star", on: ["a", "", null, 5, {}, "b"], off: [] }))
      .toEqual({ kind: "star", on: ["a", "b"], off: [] });
    expect(parseUndoToken({ kind: "star", on: ["x".repeat(65)], off: ["b"] }))
      .toEqual({ kind: "star", on: [], off: ["b"] });
  });

  it("removes duplicates so a count is not inflated", () => {
    expect(parseUndoToken({ kind: "star", on: ["a", "a", "b"], off: [] }))
      .toEqual({ kind: "star", on: ["a", "b"], off: [] });
  });

  it("caps the number of ids a round trip can carry back", () => {
    const ids = Array.from({ length: 250 }, (_, index) => `id-${index}`);
    const parsed = parseUndoToken({ kind: "archive", on: ids, off: ids });
    expect(parsed?.on).toHaveLength(100);
    expect(parsed?.off).toHaveLength(100);
  });
});

describe("pluralizeEntries", () => {
  it("agrees with the count", () => {
    expect(pluralizeEntries(0)).toBe("0 entries");
    expect(pluralizeEntries(1)).toBe("1 entry");
    expect(pluralizeEntries(2)).toBe("2 entries");
  });
});
