import { join } from "node:path";

import { parseSiteConfig } from "@wallaby/graby";
import { loadSiteConfigDirectory } from "@wallaby/graby/node";

const directory = join(process.cwd(), "packages", "graby-site-config", "configs");
const sources = loadSiteConfigDirectory(directory);
const names = Object.keys(sources);

if (names.length !== 2_037) throw new Error(`Expected 2,037 Graby site configs, found ${names.length}`);
for (const required of ["global.txt", ".wikipedia.org.txt", ".wordpress.com.txt", "medium.com.txt"]) {
  if (!(required in sources)) throw new Error(`Required Graby config is missing: ${required}`);
}

let titleRules = 0;
let bodyRules = 0;
let stripRules = 0;
let loginConfigs = 0;
for (const [name, source] of Object.entries(sources)) {
  const config = parseSiteConfig(source);
  titleRules += config.title.length;
  bodyRules += config.body.length;
  stripRules += config.strip.length + config.strip_id_or_class.length;
  loginConfigs += Number(config.requires_login);
  if (!name.endsWith(".txt")) throw new Error(`Unexpected site config filename: ${name}`);
}

if (bodyRules < 1_800 || titleRules < 800 || stripRules < 8_000 || loginConfigs < 40) {
  throw new Error(`Site-config semantic coverage is unexpectedly low: ${JSON.stringify({ titleRules, bodyRules, stripRules, loginConfigs })}`);
}

console.log(JSON.stringify({ configs: names.length, titleRules, bodyRules, stripRules, loginConfigs }));
