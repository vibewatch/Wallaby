// Bot-challenge detection and search-bot / browser request profiles.
//
// Bot-protection layers (Cloudflare, Vercel, DataDome, PerimeterX, Akamai)
// answer a plain crawler request either with a challenge status
// (401/403/406/429/451/503) or with an HTTP 200 carrying an interstitial
// "checking your browser" page. `looksLikeBotChallenge` detects both so the
// fetcher can rotate through realistic search-bot / browser profiles (and,
// optionally, a headless browser) before giving up.
//
// Adapted from the multi-strategy fetch fallback used in the ReadWise scraper.

/** Response statuses that indicate a bot challenge worth retrying with another profile. */
export const BOT_CHALLENGE_STATUSES = new Set([401, 403, 406, 429, 451, 503]);

// Named vendor markers that uniquely identify a bot-protection interstitial.
// These appear even on an HTTP 200, so a status check alone never catches them.
// Matched case-insensitively against the raw HTML body.
const CHALLENGE_VENDOR_MARKERS: readonly string[] = [
  // Cloudflare
  "just a moment...",
  "attention required! | cloudflare",
  "checking your browser before accessing",
  "cf-browser-verification",
  "cf-challenge",
  "performing security verification",
  "enable javascript and cookies to continue",
  "__cf_chl",
  // Vercel
  "vercel security checkpoint",
  "we're verifying your browser",
  // DataDome / PerimeterX / Akamai
  "datadome",
  "px-captcha",
  "access to this page has been denied",
  "pardon our interruption",
];

// A "tiny" rendered body (visible-text characters) below which a page with a
// `noindex` robots meta and no article markers is treated as a challenge.
const TINY_BODY_TEXT_CHARS = 250;

function visibleTextLength(html: string): number {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length;
}

function paragraphCount(html: string): number {
  return (html.match(/<p[\s>]/gi) ?? []).length;
}

// Strong signals of a real article, used to suppress false positives.
function hasArticleMarkers(html: string): boolean {
  const lower = html.toLowerCase();
  if (lower.includes("<article")) return true;
  if (paragraphCount(html) >= 3) return true;
  if (lower.includes("application/ld+json")) return true;
  if (lower.includes('property="og:title"') || lower.includes("property='og:title'")) return true;
  return false;
}

function hasNoindexMeta(html: string): boolean {
  return /<meta[^>]+name=["']robots["'][^>]+content=["'][^"']*noindex/i.test(html);
}

/**
 * Heuristically detects a bot-protection interstitial so the fetcher can escalate.
 *
 * Conservative by design — a real (even short) article must never be flagged:
 * anything with an `<article>`, >=3 `<p>`, JSON-LD, or an og:title is treated as
 * real content. Otherwise it is a challenge when the status is a known challenge
 * status, a named vendor marker is present, or the body is tiny with a `noindex`
 * meta and no article markers.
 */
export function looksLikeBotChallenge(html: string, status?: number): boolean {
  if (typeof status === "number" && BOT_CHALLENGE_STATUSES.has(status)) return true;
  if (!html) return false;
  if (hasArticleMarkers(html)) return false;

  const lower = html.toLowerCase();
  for (const marker of CHALLENGE_VENDOR_MARKERS) {
    if (lower.includes(marker)) return true;
  }
  if (hasNoindexMeta(html) && visibleTextLength(html) < TINY_BODY_TEXT_CHARS) return true;
  return false;
}

/** A realistic search-bot / browser fingerprint: a matching set of request headers. */
export interface BotProfile {
  readonly name: string;
  readonly headers: Record<string, string>;
}

const DESKTOP_FETCH_HEADERS: Record<string, string> = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "sec-fetch-mode": "navigate",
  "sec-fetch-site": "none",
  "sec-fetch-dest": "document",
  "upgrade-insecure-requests": "1",
};

const SIMPLE_FETCH_HEADERS: Record<string, string> = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
};

/**
 * Search-bot and browser profiles tried, in order, on a bot-challenged origin.
 * Verifiable search-bot identities come first (many sites intentionally allow
 * Googlebot/Bingbot), then a rotation of realistic desktop and mobile browsers.
 */
export const SEARCH_BOT_PROFILES: readonly BotProfile[] = [
  {
    name: "googlebot",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      ...SIMPLE_FETCH_HEADERS,
    },
  },
  {
    name: "bingbot",
    headers: {
      "user-agent": "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
      ...SIMPLE_FETCH_HEADERS,
    },
  },
  {
    name: "desktop-chrome",
    headers: {
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      ...DESKTOP_FETCH_HEADERS,
    },
  },
  {
    name: "desktop-firefox",
    headers: {
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
      ...DESKTOP_FETCH_HEADERS,
    },
  },
  {
    name: "desktop-safari",
    headers: {
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
      ...DESKTOP_FETCH_HEADERS,
    },
  },
  {
    name: "mobile-safari",
    headers: {
      "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
      ...SIMPLE_FETCH_HEADERS,
    },
  },
];
