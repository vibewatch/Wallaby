import { describe, expect, it } from "vitest";

import { InvalidEntryUrlError, parseEntryUrl } from "./entry-url";

describe("parseEntryUrl", () => {
  it("accepts what people paste", () => {
    expect(parseEntryUrl("  https://example.com/story ").href).toBe("https://example.com/story");
    expect(parseEntryUrl("HTTP://Example.com/a?b=1#c").href).toBe("http://example.com/a?b=1#c");
    expect(parseEntryUrl("example.com/story").href).toBe("https://example.com/story");
    expect(parseEntryUrl("example.com:8080/story").href).toBe("https://example.com:8080/story");
    expect(parseEntryUrl("example.com:8080").href).toBe("https://example.com:8080/");
    expect(parseEntryUrl("feed://example.com/rss").href).toBe("https://example.com/rss");
    expect(parseEntryUrl("https://[2001:db8::1]/x").hostname).toBe("[2001:db8::1]");
  });

  it.each([
    ["", /Enter the address/],
    ["   ", /Enter the address/],
    ["ftp://example.com/file", /not ftp: links/],
    ["javascript:alert(1)", /not javascript: links/],
    ["mailto:reader@example.com", /not mailto: links/],
    ["data:text/html,<p>x</p>", /not data: links/],
    ["https://user:secret@example.com/", /username or password/],
    ["https://reader@example.com/", /username or password/],
    ["https://exa mple.com/", /does not look like a web address/],
    ["intranet", /missing a domain name/],
    [`https://example.com/${"a".repeat(9_000)}`, /too long/],
  ])("rejects %j", (input, message) => {
    expect(() => parseEntryUrl(input)).toThrow(InvalidEntryUrlError);
    expect(() => parseEntryUrl(input)).toThrow(message);
  });
});
