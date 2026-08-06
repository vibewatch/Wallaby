import safeRegex from "safe-regex2";

import { db } from "@/lib/db";

export const DEFAULT_IGNORE_ORIGIN_RULES = [
  'host = "feedproxy.google.com"',
  'host = "feeds.reuters.com"',
  '_all ~ "https?://www\\.lemonde\\.fr/tiny.*"',
] as const;

type ParsedRule = { field: "host" | "_all"; operator: "=" | "~"; value: string };
type RedirectResolution = { url: string; originUrl: string | null; ignored: boolean };

export function validateIgnoreOriginRule(rule: string): void {
  parseIgnoreOriginRule(rule);
}

export function matchesIgnoreOriginRule(rule: string, input: string | URL): boolean {
  const parsed = parseIgnoreOriginRule(rule);
  const url = input instanceof URL ? input : new URL(input);
  const subject = parsed.field === "host" ? url.hostname : url.toString();
  if (parsed.operator === "=") return parsed.field === "host" ? subject.toLowerCase() === parsed.value.toLowerCase() : subject === parsed.value;
  return new RegExp(parsed.value, "i").test(subject);
}

export function resolveRedirectUrl(current: string, effective: string, originUrl: string | null, rules: string[]): RedirectResolution {
  const currentUrl = new URL(current);
  const effectiveUrl = new URL(effective);
  if (currentUrl.toString() === effectiveUrl.toString()) return { url: currentUrl.toString(), originUrl, ignored: false };
  if (rules.some((rule) => matchesIgnoreOriginRule(rule, currentUrl))) {
    return { url: effectiveUrl.toString(), originUrl, ignored: true };
  }

  const changed = changedUrlParts(currentUrl, effectiveUrl);
  if (changed.length === 1 && changed[0] === "path") {
    const trailingSlash = `${currentUrl.pathname}/` === effectiveUrl.pathname;
    let decoded = false;
    try { decoded = effectiveUrl.toString() === decodeURIComponent(currentUrl.toString()); } catch { decoded = false; }
    return { url: trailingSlash || decoded ? effectiveUrl.toString() : currentUrl.toString(), originUrl, ignored: false };
  }
  if (changed.length === 1 && changed[0] === "scheme") return { url: effectiveUrl.toString(), originUrl, ignored: false };
  if (changed.length === 1 && changed[0] === "fragment") return { url: currentUrl.toString(), originUrl, ignored: false };
  return { url: effectiveUrl.toString(), originUrl: originUrl ?? currentUrl.toString(), ignored: false };
}

export async function resolveEntryRedirect(userId: string, current: string, effective: string, originUrl: string | null): Promise<RedirectResolution> {
  if (new URL(current).toString() === new URL(effective).toString()) return { url: new URL(current).toString(), originUrl, ignored: false };
  const [instanceRules, userRules] = await Promise.all([
    db.ignoreOriginInstanceRule.findMany({ select: { rule: true }, orderBy: { createdAt: "asc" } }),
    db.ignoreOriginRule.findMany({ where: { userId }, select: { rule: true }, orderBy: { createdAt: "asc" } }),
  ]);
  return resolveRedirectUrl(current, effective, originUrl, [...instanceRules, ...userRules].map(({ rule }) => rule));
}

function parseIgnoreOriginRule(source: string): ParsedRule {
  const rule = source.trim();
  if (!rule || rule.length > 255) throw new Error("Ignore-origin rules must contain between 1 and 255 characters");
  const prefix = /^(host|_all)\s*(=|~)\s*/.exec(rule);
  if (!prefix) throw new Error('Use host or _all with the = or ~ operator');
  const rest = rule.slice(prefix[0].length);
  const quote = rest[0];
  if (quote !== '"' && quote !== "'") throw new Error("Rule values must be quoted");
  let value = "";
  let index = 1;
  for (; index < rest.length && rest[index] !== quote; index += 1) {
    if (rest[index] !== "\\") { value += rest[index]; continue; }
    if (index + 1 >= rest.length) throw new Error("Rule value has a trailing escape");
    const escaped = rest[index + 1];
    value += escaped === quote || escaped === "\\" ? escaped : `\\${escaped}`;
    index += 1;
  }
  if (rest[index] !== quote || rest.slice(index + 1).trim()) throw new Error("Rule value is not terminated correctly");
  if (!value) throw new Error("Rule value cannot be empty");
  if (prefix[2] === "~") {
    let expression: RegExp;
    try { expression = new RegExp(value, "i"); } catch { throw new Error("Rule contains an invalid regular expression"); }
    if (!safeRegex(expression)) throw new Error("Rule contains an unsafe regular expression");
  }
  return { field: prefix[1] as ParsedRule["field"], operator: prefix[2] as ParsedRule["operator"], value };
}

function changedUrlParts(left: URL, right: URL): string[] {
  const parts = {
    scheme: [left.protocol, right.protocol],
    host: [left.hostname, right.hostname],
    port: [left.port, right.port],
    user: [left.username, right.username],
    pass: [left.password, right.password],
    path: [left.pathname, right.pathname],
    query: [left.search, right.search],
    fragment: [left.hash, right.hash],
  };
  return Object.entries(parts).filter(([, [first, second]]) => first !== second).map(([name]) => name).sort();
}
