import { describe, expect, it } from "vitest";

import { resolveFetchFallbackFlags } from "@/lib/extractor";

describe("resolveFetchFallbackFlags", () => {
  it("defaults both flags off when nothing is set", () => {
    expect(resolveFetchFallbackFlags({})).toEqual({ botProfiles: false, browserRender: false });
  });

  it("enables bot profiles alone", () => {
    expect(resolveFetchFallbackFlags({ WALLABY_BOT_PROFILES: "true" })).toEqual({ botProfiles: true, browserRender: false });
  });

  it("browser render implies bot profiles", () => {
    expect(resolveFetchFallbackFlags({ WALLABY_BROWSER_RENDER: "true" })).toEqual({ botProfiles: true, browserRender: true });
  });

  it.each(["1", "true", "TRUE", "yes", "on", " On "])("treats %j as enabled", (value) => {
    expect(resolveFetchFallbackFlags({ WALLABY_BOT_PROFILES: value }).botProfiles).toBe(true);
  });

  it.each(["0", "false", "no", "off", "", "maybe"])("treats %j as disabled", (value) => {
    expect(resolveFetchFallbackFlags({ WALLABY_BOT_PROFILES: value }).botProfiles).toBe(false);
  });
});
