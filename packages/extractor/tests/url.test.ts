import { describe, expect, it } from "vitest";

import { absoluteUrl, assertPublicUrl, normalizeUrl } from "../src";

describe("normalizeUrl", () => {
  it("defaults protocol-less input to https and trims", () => {
    expect(normalizeUrl("  example.com/story  ").toString()).toBe("https://example.com/story");
  });

  it("keeps explicit http and https schemes", () => {
    expect(normalizeUrl("http://example.com/").protocol).toBe("http:");
    expect(normalizeUrl("https://example.com/").protocol).toBe("https:");
  });

  it("rewrites the feed: scheme to https", () => {
    const url = normalizeUrl("feed://example.com/rss");
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe("example.com");
  });

  it("rejects unparseable or non-fetchable schemes", () => {
    expect(() => normalizeUrl("javascript:alert(1)")).toThrow();
    // mailto: is prepended with https:// and then rejected (its "user" becomes credentials).
    expect(() => normalizeUrl("mailto:someone@example.com")).toThrow();
  });

  it("rejects URLs that embed credentials", () => {
    expect(() => normalizeUrl("https://user:pass@example.com/")).toThrow(/credentials are not allowed/);
    expect(() => normalizeUrl("https://user@example.com/")).toThrow(/credentials are not allowed/);
  });

  it("returns a fresh URL instance when given a URL", () => {
    const input = new URL("https://example.com/a");
    const output = normalizeUrl(input);
    expect(output).not.toBe(input);
    expect(output.toString()).toBe(input.toString());
  });
});

describe("absoluteUrl", () => {
  const base = new URL("https://example.com/dir/page.html");

  it("resolves relative, root-relative, and protocol-relative references", () => {
    expect(absoluteUrl("img.png", base)).toBe("https://example.com/dir/img.png");
    expect(absoluteUrl("/root.png", base)).toBe("https://example.com/root.png");
    expect(absoluteUrl("//cdn.example.net/a.png", base)).toBe("https://cdn.example.net/a.png");
  });

  it("returns absolute URLs unchanged", () => {
    expect(absoluteUrl("https://other.example/x", base)).toBe("https://other.example/x");
  });

  it("drops data: URIs and empty values", () => {
    expect(absoluteUrl("data:image/png;base64,AAAA", base)).toBeNull();
    expect(absoluteUrl("", base)).toBeNull();
    expect(absoluteUrl(null, base)).toBeNull();
    expect(absoluteUrl(undefined, base)).toBeNull();
  });
});

describe("assertPublicUrl SSRF guard", () => {
  it("allows a public IP literal without a DNS lookup", async () => {
    await expect(assertPublicUrl(new URL("http://93.184.216.34/"))).resolves.toBeUndefined();
  });

  it.each([
    ["loopback IPv4", "http://127.0.0.1/"],
    ["loopback IPv6", "http://[::1]/"],
    ["private 10/8", "http://10.0.0.5/"],
    ["private 192.168/16", "http://192.168.1.1/"],
    ["carrier-grade NAT", "http://100.64.0.1/"],
    ["link-local cloud metadata", "http://169.254.169.254/latest/meta-data/"],
    ["unique local IPv6", "http://[fd00::1]/"],
  ])("blocks %s", async (_label, url) => {
    await expect(assertPublicUrl(new URL(url))).rejects.toThrow(/non-public address/);
  });

  it.each([
    ["localhost", "http://localhost/"],
    ["google metadata host", "http://metadata.google.internal/"],
    ["a .localhost subdomain", "http://api.localhost/"],
    ["a .local mDNS host", "http://printer.local/"],
  ])("blocks the reserved hostname %s", async (_label, url) => {
    await expect(assertPublicUrl(new URL(url))).rejects.toThrow(/Private hostname is not allowed/);
  });
});
