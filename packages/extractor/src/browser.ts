// SSRF-guarded headless-browser rendering for JS-heavy or challenge-gated pages.
//
// Playwright is imported lazily so the extractor has no hard dependency on a
// browser binary: callers who never enable browser rendering never load it.
// A `BrowserFactory` can be injected for tests, so unit tests exercise the full
// routing / SSRF / challenge-wait logic without launching real Chromium.
//
// Adapted from the browser-render strategy used in the ReadWise scraper.
import { assertPublicUrl } from "./url";

export interface RenderedPage {
  status: number;
  html: string;
}

// Structural subset of Playwright we depend on, so tests can supply a fake and
// the real `playwright` types never need to be present at build time.
export interface RenderRoute {
  request(): { url(): string; resourceType(): string };
  abort(): Promise<void>;
  continue(): Promise<void>;
}
export interface RenderPage {
  goto(url: string, options: { waitUntil: "domcontentloaded"; timeout: number }): Promise<{ status(): number } | null>;
  content(): Promise<string>;
  waitForTimeout(ms: number): Promise<void>;
}
export interface RenderContext {
  route(pattern: string, handler: (route: RenderRoute) => Promise<void> | void): Promise<void>;
  newPage(): Promise<RenderPage>;
  close(): Promise<void>;
}
export interface RenderBrowser {
  newContext(options: { userAgent: string; locale: string; viewport: { width: number; height: number } }): Promise<RenderContext>;
  close(): Promise<void>;
  on(event: "disconnected", listener: () => void): void;
}
export type BrowserFactory = () => Promise<RenderBrowser>;

const DESKTOP_CHROME_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
// Skip heavy subresources: we only need the DOM, never pixels.
const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font", "stylesheet"]);
const CHALLENGE_MARKERS = ["just a moment", "cf-mitigated", "checking your browser"];
const CHALLENGE_POLL_INTERVAL_MS = 500;
const MAX_CHALLENGE_WAIT_MS = 15_000;

let sharedBrowser: Promise<RenderBrowser> | null = null;

async function launchPlaywrightChromium(): Promise<RenderBrowser> {
  // Lazy, optional dependency: only imported when browser rendering is used.
  const mod = (await import("playwright").catch(() => {
    throw new Error("Browser rendering requires the optional 'playwright' dependency and its Chromium browser.");
  })) as { chromium: { launch(options: { headless: boolean; args: string[] }): Promise<unknown> } };
  const browser = await mod.chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  return browser as RenderBrowser;
}

function getSharedBrowser(factory: BrowserFactory): Promise<RenderBrowser> {
  if (!sharedBrowser) {
    sharedBrowser = factory()
      .then((browser) => {
        browser.on("disconnected", () => {
          sharedBrowser = null;
        });
        return browser;
      })
      .catch((error) => {
        sharedBrowser = null;
        throw error;
      });
  }
  return sharedBrowser;
}

function isHttpProtocol(protocol: string): boolean {
  return protocol === "http:" || protocol === "https:";
}

function looksLikeBrowserChallenge(html: string): boolean {
  const lower = html.toLowerCase();
  return CHALLENGE_MARKERS.some((marker) => lower.includes(marker));
}

// Re-validate every subresource the page tries to load, so a malicious page
// can't pivot the headless browser to an internal address.
async function handleRoute(route: RenderRoute): Promise<void> {
  const request = route.request();
  try {
    const parsed = new URL(request.url());
    if (!isHttpProtocol(parsed.protocol) || BLOCKED_RESOURCE_TYPES.has(request.resourceType())) {
      await route.abort();
      return;
    }
    await assertPublicUrl(parsed);
    await route.continue();
  } catch {
    await route.abort();
  }
}

async function waitThroughChallenge(page: RenderPage, initialHtml: string, deadline: number, now: () => number, sleep: (ms: number) => Promise<void>): Promise<string> {
  let html = initialHtml;
  while (looksLikeBrowserChallenge(html) && now() < deadline) {
    await sleep(Math.min(CHALLENGE_POLL_INTERVAL_MS, Math.max(0, deadline - now())));
    html = await page.content();
  }
  return html;
}

export interface RenderOptions {
  factory?: BrowserFactory;
  userAgent?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Renders a URL in a headless browser and returns the final DOM HTML.
 *
 * The target and every subresource are SSRF-validated. A shared browser
 * instance is reused across calls; supply `factory` to inject a fake browser in
 * tests. Callers must `assertPublicUrl` semantics still hold — this re-checks.
 */
export async function renderViaBrowser(url: string | URL, timeoutMs: number, options: RenderOptions = {}): Promise<RenderedPage> {
  const target = url instanceof URL ? url : new URL(url);
  await assertPublicUrl(target);

  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const browser = await getSharedBrowser(options.factory ?? launchPlaywrightChromium);
  const context = await browser.newContext({
    userAgent: options.userAgent ?? DESKTOP_CHROME_UA,
    locale: "en-US",
    viewport: { width: 1365, height: 900 },
  });

  try {
    await context.route("**/*", handleRoute);
    const page = await context.newPage();
    const response = await page.goto(target.toString(), { waitUntil: "domcontentloaded", timeout: timeoutMs });
    const status = response?.status() ?? 0;
    const deadline = now() + Math.max(0, Math.min(timeoutMs, MAX_CHALLENGE_WAIT_MS));
    const html = await waitThroughChallenge(page, await page.content(), deadline, now, sleep);
    return { status, html };
  } finally {
    await context.close();
  }
}

/** Closes the shared browser instance, if one was launched. */
export async function closeBrowser(): Promise<void> {
  if (!sharedBrowser) return;
  const current = sharedBrowser;
  sharedBrowser = null;
  try {
    const browser = await current;
    await browser.close();
  } catch {
    // Already gone; nothing to close.
  }
}
