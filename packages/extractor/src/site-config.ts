import { SiteConfig, type MultiValueDirective } from "./types";

const multiValueDirectives = new Set<MultiValueDirective>([
  "title",
  "body",
  "author",
  "date",
  "strip",
  "strip_id_or_class",
  "strip_image_src",
  "native_ad_clue",
  "test_url",
  "single_page_link",
  "next_page_link",
  "find_string",
  "replace_string",
  "login_extra_fields",
  "post_strip_attr",
]);

const booleanDirectives = new Set([
  "tidy",
  "prune",
  "autodetect_on_failure",
  "requires_login",
  "skip_json_ld",
]);

const stringDirectives = new Set([
  "parser",
  "login_username_field",
  "login_password_field",
  "not_logged_in_xpath",
  "login_uri",
  "src_lazy_load_attr",
]);

const acceptedWrapTags = new Set(["blockquote", "p", "div"]);

export function parseSiteConfig(source: string): SiteConfig {
  const config = new SiteConfig();

  for (const sourceLine of source.split(/\r?\n/)) {
    const line = sourceLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf(":");
    if (separator === -1) continue;

    let command = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!command) continue;
    if (command === "strip_attr") command = "strip";

    if (multiValueDirectives.has(command as MultiValueDirective)) {
      config[command as MultiValueDirective].push(value);
      continue;
    }

    if (booleanDirectives.has(command)) {
      (config as unknown as Record<string, unknown>)[command] = value === "yes" || value === "true";
      continue;
    }

    if (stringDirectives.has(command)) {
      (config as unknown as Record<string, unknown>)[command] = value;
      continue;
    }

    const replaceMatch = /^replace_string\((.*)\)$/i.exec(command);
    if (replaceMatch) {
      config.find_string.push(replaceMatch[1]);
      config.replace_string.push(value);
      continue;
    }

    const headerMatch = /^http_header\(([a-z0-9_-]+)\)$/i.exec(command);
    if (headerMatch) {
      config.http_header[headerMatch[1].toLowerCase()] = value;
      continue;
    }

    const wrapMatch = /^wrap_in\(([a-z]+)\)$/i.exec(command);
    if (wrapMatch && acceptedWrapTags.has(wrapMatch[1].toLowerCase())) {
      config.wrap_in[wrapMatch[1].toLowerCase()] = value;
      continue;
    }

    if (command === "if_page_contains") {
      const rule = config.single_page_link.length ? "single_page_link" : config.next_page_link.length ? "next_page_link" : null;
      if (rule) {
        const link = config[rule].at(-1)!;
        config.if_page_contains[rule] ??= {};
        config.if_page_contains[rule][link] = value;
      }
    }
  }

  if (config.find_string.length !== config.replace_string.length) {
    config.find_string = [];
    config.replace_string = [];
  }

  return config;
}

const mergedArrayKeys = [
  "title",
  "body",
  "strip",
  "strip_id_or_class",
  "strip_image_src",
  "single_page_link",
  "next_page_link",
  "date",
  "author",
  "post_strip_attr",
] as const;

export function mergeSiteConfig(current: SiteConfig, fallback: SiteConfig): SiteConfig {
  for (const key of mergedArrayKeys) current[key] = [...new Set([...current[key], ...fallback[key]])];

  for (const key of ["tidy", "prune", "parser", "autodetect_on_failure"] as const) {
    if (current[key] === null) current[key] = fallback[key] as never;
  }
  if (!current.requires_login) current.requires_login = fallback.requires_login;
  if (!current.skip_json_ld) current.skip_json_ld = fallback.skip_json_ld;

  current.http_header = { ...fallback.http_header, ...current.http_header };
  current.if_page_contains = {
    ...fallback.if_page_contains,
    ...current.if_page_contains,
  };

  const replacements = new Map<string, string>();
  current.find_string.forEach((find, index) => replacements.set(find, current.replace_string[index]));
  fallback.find_string.forEach((find, index) => replacements.set(find, fallback.replace_string[index]));
  current.find_string = [...replacements.keys()];
  current.replace_string = [...replacements.values()];
  return current;
}

export function normalizeHost(host: string): string {
  const normalized = host.trim().toLowerCase().replace(/\.$/, "");
  return normalized.startsWith("www.") ? normalized.slice(4) : normalized;
}

export class ConfigBuilder {
  private readonly configs = new Map<string, SiteConfig>();
  private readonly cache = new Map<string, SiteConfig>();

  constructor(sources: Record<string, string> = {}) {
    for (const [name, source] of Object.entries(sources)) {
      const key = name.replace(/\.txt$/i, "").toLowerCase();
      this.configs.set(key, parseSiteConfig(source));
    }
  }

  reload(sources: Record<string, string>): void {
    this.configs.clear();
    this.cache.clear();
    for (const [name, source] of Object.entries(sources)) {
      this.configs.set(name.replace(/\.txt$/i, "").toLowerCase(), parseSiteConfig(source));
    }
  }

  create(): SiteConfig {
    return new SiteConfig();
  }

  buildFromUrl(url: URL): SiteConfig {
    return this.buildForHost(url.hostname);
  }

  buildForHost(hostname: string): SiteConfig {
    const host = normalizeHost(hostname);
    const cached = this.cache.get(host);
    if (cached) return structuredCloneConfig(cached);

    const labels = host.split(".");
    const wildcard = labels.length > 1 ? `.${labels.slice(1).join(".")}` : null;
    const matched = this.configs.get(host) ?? (wildcard ? this.configs.get(wildcard) : undefined);
    let config = matched ? structuredCloneConfig(matched) : new SiteConfig();
    const global = this.configs.get("global");
    if (config.autodetectOnFailure() && global) config = mergeSiteConfig(config, structuredCloneConfig(global));
    config.cache_key = host;
    this.cache.set(host, structuredCloneConfig(config));
    return config;
  }
}

function structuredCloneConfig(value: SiteConfig): SiteConfig {
  return Object.assign(new SiteConfig(), structuredClone(value));
}
