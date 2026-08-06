import { describe, expect, it } from "vitest";

import { clientAddress, identityThrottleKey } from "@/lib/auth-throttle";

describe("authentication throttle identifiers", () => {
  it("normalizes identities without storing the submitted username or email", () => {
    const first = identityThrottleKey(" Reader@Example.COM ");
    expect(first).toBe(identityThrottleKey("reader@example.com"));
    expect(first).toMatch(/^identity:[0-9a-f]{64}$/);
    expect(first).not.toContain("reader");
  });

  it("accepts only concrete forwarded or real IP addresses", () => {
    expect(clientAddress(new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.2" }))).toBe("203.0.113.9");
    expect(clientAddress(new Headers({ "x-real-ip": "2001:db8::1" }))).toBe("2001:db8::1");
    expect(clientAddress(new Headers({ "x-forwarded-for": "spoofed-value" }))).toBeNull();
  });
});
