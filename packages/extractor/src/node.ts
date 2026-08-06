import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function loadSiteConfigDirectory(directory: string): Record<string, string> {
  const sources: Record<string, string> = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".txt")) continue;
    sources[entry.name] = readFileSync(join(directory, entry.name), "utf8");
  }
  return sources;
}
