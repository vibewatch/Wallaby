import { describe, expect, it } from "vitest";

import { BOT_CHALLENGE_STATUSES, looksLikeBotChallenge, SEARCH_BOT_PROFILES } from "../src";

const realArticle = `<!doctype html><html><head><meta property="og:title" content="A Story"></head>
  <body><article><p>First paragraph of a genuine article.</p><p>Second.</p><p>Third.</p></article></body></html>`;

describe("looksLikeBotChallenge", () => {
  it.each([...BOT_CHALLENGE_STATUSES])("flags challenge status %i", (status) => {
    expect(looksLikeBotChallenge("<html></html>", status)).toBe(true);
  });

  it("does not flag a normal 200", () => {
    expect(looksLikeBotChallenge(realArticle, 200)).toBe(false);
  });

  it.each([
    ["Cloudflare", "<html><head><title>Just a moment...</title></head><body>Checking your browser before accessing</body></html>"],
    ["Vercel", "<html><body>Vercel Security Checkpoint — we're verifying your browser</body></html>"],
    ["DataDome", "<html><body>Access to this page has been denied. datadome</body></html>"],
    ["PerimeterX", "<html><body>Please verify you are a human px-captcha</body></html>"],
  ])("flags a 200 %s interstitial by content", (_vendor, html) => {
    expect(looksLikeBotChallenge(html)).toBe(true);
  });

  it("flags a tiny noindex body with no article markers", () => {
    const tiny = '<html><head><meta name="robots" content="noindex,nofollow"></head><body>blocked</body></html>';
    expect(looksLikeBotChallenge(tiny)).toBe(true);
  });

  it("does NOT flag a real article even if it mentions a vendor string in prose", () => {
    const html = `<!doctype html><html><body><article>
      <p>This article discusses how DataDome and Cloudflare protect websites.</p>
      <p>It is a legitimate piece of writing about bot protection.</p>
      <p>Nothing here is an interstitial.</p></article></body></html>`;
    expect(looksLikeBotChallenge(html)).toBe(false);
  });

  it("does not flag empty input", () => {
    expect(looksLikeBotChallenge("")).toBe(false);
  });
});

describe("SEARCH_BOT_PROFILES", () => {
  it("leads with verifiable search-bot identities", () => {
    expect(SEARCH_BOT_PROFILES[0].name).toBe("googlebot");
    expect(SEARCH_BOT_PROFILES[1].name).toBe("bingbot");
  });

  it("every profile carries a user-agent header", () => {
    for (const profile of SEARCH_BOT_PROFILES) {
      expect(profile.headers["user-agent"]).toBeTruthy();
    }
  });
});
