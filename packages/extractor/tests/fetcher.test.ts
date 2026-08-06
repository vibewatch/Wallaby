import { describe, expect, it } from "vitest";

import { decodeBody } from "../src";

describe("HTTP body decoding", () => {
  it("sniffs a Windows-1252 HTML meta charset", () => {
    const prefix = new TextEncoder().encode('<html><head><meta charset="windows-1252"></head><body>caf');
    const suffix = new TextEncoder().encode("</body></html>");
    const bytes = new Uint8Array(prefix.length + 1 + suffix.length);
    bytes.set(prefix);
    bytes[prefix.length] = 0xe9;
    bytes.set(suffix, prefix.length + 1);
    expect(decodeBody(bytes)).toContain("café");
  });

  it("lets a response header override an incorrect document declaration", () => {
    const bytes = new TextEncoder().encode('<meta charset="windows-1252"><p>naïve</p>');
    expect(decodeBody(bytes, "text/html; charset=utf-8")).toContain("naïve");
  });
});
