import { describe, expect, it } from "vitest";

import {
  goToViews,
  isEditableTarget,
  isGoToKey,
  nextIndex,
  shortcutGroups,
  shortcutKey,
  shouldHandleKey,
} from "./shortcuts";

describe("isEditableTarget", () => {
  it("claims the keystroke for form fields", () => {
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT", "input"]) {
      expect(isEditableTarget({ tagName })).toBe(true);
    }
  });

  it("claims the keystroke for rich-text regions", () => {
    expect(isEditableTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isEditableTarget({ tagName: "SPAN", closest: (s: string) => (s.includes("contenteditable") ? {} : null) })).toBe(true);
  });

  it("leaves ordinary elements to the shortcut layer", () => {
    expect(isEditableTarget({ tagName: "ARTICLE", closest: () => null })).toBe(false);
    expect(isEditableTarget({ tagName: "BUTTON" })).toBe(false);
    expect(isEditableTarget(null)).toBe(false);
    expect(isEditableTarget(undefined)).toBe(false);
  });
});

describe("shouldHandleKey", () => {
  const target = { tagName: "BODY", closest: () => null };

  it("handles bare printable keys", () => {
    expect(shouldHandleKey({ key: "j", target })).toBe(true);
    expect(shouldHandleKey({ key: "?", target })).toBe(true);
  });

  it("handles Enter and Escape but no other named keys", () => {
    expect(shouldHandleKey({ key: "Enter", target })).toBe(true);
    expect(shouldHandleKey({ key: "Escape", target })).toBe(true);
    expect(shouldHandleKey({ key: "ArrowDown", target })).toBe(false);
    expect(shouldHandleKey({ key: "Tab", target })).toBe(false);
  });

  it("yields to browser and OS chords", () => {
    expect(shouldHandleKey({ key: "r", metaKey: true, target })).toBe(false);
    expect(shouldHandleKey({ key: "f", ctrlKey: true, target })).toBe(false);
    expect(shouldHandleKey({ key: "s", altKey: true, target })).toBe(false);
  });

  it("yields while the reader is typing", () => {
    expect(shouldHandleKey({ key: "s", target: { tagName: "INPUT" } })).toBe(false);
  });
});

describe("shortcutKey", () => {
  it("lowercases printable keys so Shift+/ and / agree", () => {
    expect(shortcutKey({ key: "J" })).toBe("j");
    expect(shortcutKey({ key: "?" })).toBe("?");
  });

  it("preserves named keys", () => {
    expect(shortcutKey({ key: "Enter" })).toBe("Enter");
    expect(shortcutKey({ key: "Escape" })).toBe("Escape");
  });
});

describe("isGoToKey", () => {
  it("accepts only the mapped views", () => {
    expect(isGoToKey("u")).toBe(true);
    expect(isGoToKey("t")).toBe(true);
    expect(isGoToKey("z")).toBe(false);
    expect(isGoToKey("constructor")).toBe(false);
    expect(isGoToKey("toString")).toBe(false);
  });
});

describe("nextIndex", () => {
  it("enters the list from either end when nothing is focused", () => {
    expect(nextIndex(-1, 1, 5)).toBe(0);
    expect(nextIndex(-1, -1, 5)).toBe(4);
  });

  it("steps through the list", () => {
    expect(nextIndex(0, 1, 5)).toBe(1);
    expect(nextIndex(3, -1, 5)).toBe(2);
  });

  it("stops at the ends rather than wrapping", () => {
    expect(nextIndex(4, 1, 5)).toBe(4);
    expect(nextIndex(0, -1, 5)).toBe(0);
  });

  it("reports no target for an empty list", () => {
    expect(nextIndex(-1, 1, 0)).toBe(-1);
  });
});

describe("shortcutGroups", () => {
  it("documents every go-to view", () => {
    const documented = shortcutGroups.flatMap((group) => group.hints.map((hint) => hint.keys));
    for (const key of Object.keys(goToViews)) {
      expect(documented).toContain(`g then ${key}`);
    }
  });

  it("keeps key hints unique within a group", () => {
    for (const group of shortcutGroups) {
      const keys = group.hints.map((hint) => hint.keys);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });
});
