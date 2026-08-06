import { join } from "node:path";

import { Graby } from "@wallaby/graby";
import { loadSiteConfigDirectory } from "@wallaby/graby/node";

let instance: Graby | undefined;

export function getGraby(): Graby {
  if (!instance) {
    const directory = join(process.cwd(), "packages", "graby-site-config", "configs");
    instance = new Graby({ siteConfigs: loadSiteConfigDirectory(directory) });
  }
  return instance;
}
