import { describe, expect, it } from "vitest";

import { parseTheme, type Theme, themeAttribute, themeBootstrapScript, themes } from "./theme";

describe("parseTheme", () => {
  it("accepts every supported theme", () => {
    for (const theme of themes) expect(parseTheme(theme)).toBe(theme);
  });

  it("falls back to auto for untrusted input", () => {
    for (const value of ["", "DARK", "solarized", null, undefined, 7, {}, ["dark"]]) {
      expect(parseTheme(value)).toBe("auto");
    }
  });
});

describe("themeAttribute", () => {
  it("commits an explicit choice server-side", () => {
    expect(themeAttribute("light")).toBe("light");
    expect(themeAttribute("dark")).toBe("dark");
  });

  it("leaves auto for the client to resolve", () => {
    expect(themeAttribute("auto")).toBeUndefined();
  });
});

describe("themeBootstrapScript", () => {
  it("embeds the theme as JSON rather than raw interpolation", () => {
    expect(themeBootstrapScript("dark")).toContain('"dark"');
  });

  it("always subscribes to system changes", () => {
    // The listener re-reads the preference, so it must stay attached even when
    // the page was rendered with an explicit choice the reader may later drop.
    for (const theme of themes) expect(themeBootstrapScript(theme)).toContain("addEventListener");
  });

  it("applies the resolved palette and records the preference", () => {
    const script = themeBootstrapScript("auto");
    expect(script).toContain("d.dataset.theme");
    expect(script).toContain("d.dataset.themePreference");
    expect(script).toContain("prefers-color-scheme: dark");
  });

  it("never throws for a caller that skipped validation", () => {
    // The bootstrap runs before React; a parse failure must not block paint.
    expect(themeBootstrapScript("auto")).toContain("catch(e){}");
  });

  it("resolves auto against the media query in a DOM", () => {
    const { root } = runBootstrap("auto", true);
    expect(root.dataset.theme).toBe("dark");
    expect(root.dataset.themePreference).toBe("auto");
  });

  it("ignores the media query for an explicit light choice", () => {
    const { root } = runBootstrap("light", true);
    expect(root.dataset.theme).toBe("light");
  });

  it("follows a preference changed after load when the system flips", () => {
    const { root, media } = runBootstrap("auto", false);
    expect(root.dataset.theme).toBe("light");

    // The toggle writes the preference; the bootstrap listener must respect it
    // rather than the value the server rendered with.
    root.dataset.themePreference = "dark";
    media.matches = true;
    media.fire();
    expect(root.dataset.theme).toBe("dark");

    root.dataset.themePreference = "light";
    media.fire();
    expect(root.dataset.theme).toBe("light");
  });
});

function runBootstrap(theme: Theme, prefersDark: boolean) {
  const root: { dataset: Record<string, string> } = { dataset: {} };
  const listeners: (() => void)[] = [];
  const media = {
    matches: prefersDark,
    addEventListener: (_: string, handler: () => void) => { listeners.push(handler); },
    fire: () => { for (const handler of listeners) handler(); },
  };
  new Function("document", "window", themeBootstrapScript(theme))(
    { documentElement: root },
    { matchMedia: () => media },
  );
  return { root, media };
}
