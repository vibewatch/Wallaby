import { join } from "node:path";

import { Extractor } from "@wallaby/extractor";
import { loadSiteConfigDirectory } from "@wallaby/extractor/node";

let instance: Extractor | undefined;

/**
 * Resolves the opt-in fetch-fallback flags from the environment. Enabling
 * `WALLABY_BROWSER_RENDER` implies bot-profile rotation, since headless
 * rendering is the last resort after the profile chain.
 */
export function resolveFetchFallbackFlags(env: Record<string, string | undefined> = process.env): { botProfiles: boolean; browserRender: boolean } {
  const flag = (name: string) => {
    const value = env[name]?.trim().toLowerCase();
    return value === "1" || value === "true" || value === "yes" || value === "on";
  };
  const browserRender = flag("WALLABY_BROWSER_RENDER");
  return { browserRender, botProfiles: browserRender || flag("WALLABY_BOT_PROFILES") };
}

export function getExtractor(): Extractor {
  if (!instance) {
    const directory = join(process.cwd(), "packages", "extractor-site-config", "configs");
    instance = new Extractor({
      siteConfigs: loadSiteConfigDirectory(directory),
      ...resolveFetchFallbackFlags(),
    });
  }
  return instance;
}
