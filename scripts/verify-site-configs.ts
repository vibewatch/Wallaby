import { join } from "node:path";

import { JSDOM } from "jsdom";

import { parseSiteConfig } from "@wallaby/extractor";
import { loadSiteConfigDirectory } from "@wallaby/extractor/node";

const directory = join(process.cwd(), "packages", "extractor-site-config", "configs");
const sources = loadSiteConfigDirectory(directory);
const names = Object.keys(sources);

if (names.length !== 2_037) throw new Error(`Expected 2,037 site configs, found ${names.length}`);
for (const required of ["global.txt", ".wikipedia.org.txt", ".wordpress.com.txt", "medium.com.txt"]) {
  if (!(required in sources)) throw new Error(`Required site config is missing: ${required}`);
}

const xpathFields = ["title", "body", "author", "date", "strip", "native_ad_clue", "single_page_link", "next_page_link", "post_strip_attr"] as const;
// Known-bad upstream XPath JSDOM cannot evaluate; extraction skips these safely.
const maxUnevaluableXPath = 4;

const document = new JSDOM("<html><body><article><h1>t</h1><p>p</p></article></body></html>").window.document;
const anyType = document.defaultView!.XPathResult.ANY_TYPE;

let titleRules = 0;
let bodyRules = 0;
let stripRules = 0;
let loginConfigs = 0;
let xpathTotal = 0;
const unevaluable: string[] = [];
for (const [name, source] of Object.entries(sources)) {
  const config = parseSiteConfig(source);
  titleRules += config.title.length;
  bodyRules += config.body.length;
  stripRules += config.strip.length + config.strip_id_or_class.length;
  loginConfigs += Number(config.requires_login);
  if (!name.endsWith(".txt")) throw new Error(`Unexpected site config filename: ${name}`);
  if (config.find_string.length !== config.replace_string.length) {
    throw new Error(`find_string/replace_string mismatch in ${name}`);
  }
  for (const field of xpathFields) {
    for (const expression of config[field]) {
      xpathTotal += 1;
      try {
        document.evaluate(expression, document, null, anyType, null);
      } catch {
        unevaluable.push(`${name} [${field}] ${expression}`);
      }
    }
  }
}

if (bodyRules < 1_800 || titleRules < 800 || stripRules < 8_000 || loginConfigs < 40) {
  throw new Error(`Site-config semantic coverage is unexpectedly low: ${JSON.stringify({ titleRules, bodyRules, stripRules, loginConfigs })}`);
}

if (unevaluable.length > maxUnevaluableXPath) {
  throw new Error(`Too many unevaluable XPath expressions (${unevaluable.length} > ${maxUnevaluableXPath}):\n${unevaluable.join("\n")}`);
}

console.log(JSON.stringify({ configs: names.length, titleRules, bodyRules, stripRules, loginConfigs, xpathTotal, unevaluableXPath: unevaluable.length }));
