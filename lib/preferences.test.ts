import { describe, expect, it } from "vitest";

import { sanitizeReaderCss } from "./preferences";

describe("reader CSS preferences", () => {
  it("normalizes a declaration list that can be scoped to article content", () => {
    expect(sanitizeReaderCss(" letter-spacing: .02em; text-align: justify ")).toBe("letter-spacing: .02em; text-align: justify;");
    expect(sanitizeReaderCss("  ")).toBeNull();
  });

  it("rejects selectors, markup escapes, and external resource loads", () => {
    expect(() => sanitizeReaderCss("body { display: none }")).toThrow("declarations only");
    expect(() => sanitizeReaderCss("background: url(https://tracker.example/pixel)")).toThrow("external resources");
    expect(() => sanitizeReaderCss("color: red;</style><script>alert(1)</script>")).toThrow("declarations only");
  });
});
