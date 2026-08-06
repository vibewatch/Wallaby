import { afterEach, describe, expect, it } from "vitest";

import { closeBrowser, renderViaBrowser, type BrowserFactory, type RenderRoute } from "../src";

// A scriptable fake Playwright browser: records routed URLs and returns a
// scripted sequence of page.content() results (to simulate a challenge clearing).
function fakeBrowser(script: { status: number; contents: string[] }) {
  const routed: string[] = [];
  const aborted: string[] = [];
  let contentIndex = 0;

  const factory: BrowserFactory = async () => ({
    on() {},
    async close() {},
    async newContext() {
      return {
        async route(_pattern, handler) {
          // Exercise the SSRF route guard with one safe (public IP) and one
          // private subresource. A public IP literal avoids a real DNS lookup.
          for (const sub of ["https://93.184.216.34/app.js", "http://127.0.0.1/secret"]) {
            const route: RenderRoute = {
              request: () => ({ url: () => sub, resourceType: () => "script" }),
              abort: async () => {
                aborted.push(sub);
              },
              continue: async () => {
                routed.push(sub);
              },
            };
            await handler(route);
          }
        },
        async newPage() {
          return {
            async goto() {
              return { status: () => script.status };
            },
            async content() {
              const value = script.contents[Math.min(contentIndex, script.contents.length - 1)];
              contentIndex += 1;
              return value;
            },
            async waitForTimeout() {},
          };
        },
        async close() {},
      };
    },
  });

  return { factory, routed, aborted };
}

describe("renderViaBrowser", () => {
  afterEach(async () => {
    // Reset the shared-browser singleton so each test uses its own fake factory.
    await closeBrowser();
  });

  it("returns the rendered DOM and status via an injected browser", async () => {
    const { factory } = fakeBrowser({ status: 200, contents: ["<html><body><article>rendered</article></body></html>"] });
    const result = await renderViaBrowser("https://93.184.216.34/a", 5_000, { factory, now: () => 0, sleep: async () => {} });
    expect(result.status).toBe(200);
    expect(result.html).toContain("rendered");
  });

  it("allows public subresources but aborts private ones (SSRF route guard)", async () => {
    const { factory, routed, aborted } = fakeBrowser({ status: 200, contents: ["<html><body><article>ok</article></body></html>"] });
    await renderViaBrowser("https://93.184.216.34/a", 5_000, { factory, now: () => 0, sleep: async () => {} });
    expect(routed).toContain("https://93.184.216.34/app.js");
    expect(aborted).toContain("http://127.0.0.1/secret");
  });

  it("waits through a clearing challenge page", async () => {
    // First content() is a challenge, second is the real page.
    const { factory } = fakeBrowser({
      status: 200,
      contents: ["<html><body>Just a moment... checking your browser</body></html>", "<html><body><article>cleared</article></body></html>"],
    });
    let clock = 0;
    const result = await renderViaBrowser("https://93.184.216.34/a", 30_000, {
      factory,
      now: () => (clock += 100),
      sleep: async () => {},
    });
    expect(result.html).toContain("cleared");
  });

  it("rejects a private target before rendering", async () => {
    const { factory } = fakeBrowser({ status: 200, contents: ["x"] });
    await expect(renderViaBrowser("http://127.0.0.1/x", 5_000, { factory })).rejects.toThrow(/non-public address/);
  });
});
