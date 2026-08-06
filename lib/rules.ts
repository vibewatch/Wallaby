import type { Entry } from "@prisma/client";

import { db } from "@/lib/db";

const allowedFields = new Set([
  "title",
  "url",
  "isArchived",
  "isStarred",
  "content",
  "language",
  "mimetype",
  "readingTime",
  "domainName",
]);

type RuleValue = string | number | boolean | null;
type RuleFields = Record<string, RuleValue>;
type Token = { kind: "identifier" | "string" | "number" | "operator" | "paren"; value: string; position: number };
export type TaggingRulePayload = { rule: string; tags: string[] };
type Node =
  | { kind: "logical"; operator: "AND" | "OR"; left: Node; right: Node }
  | { kind: "not"; expression: Node }
  | { kind: "comparison"; field: string; operator: string; value: RuleValue };

export function validateTaggingRule(rule: string): void {
  parseRule(rule);
}

export function matchesTaggingRule(rule: string, fields: RuleFields): boolean {
  return evaluate(parseRule(rule), fields);
}

export function parseTaggingRuleImport(value: unknown): TaggingRulePayload[] {
  if (!Array.isArray(value)) throw new Error("Tagging-rule import must be a JSON array");
  if (!value.length) throw new Error("Tagging-rule import cannot be empty");
  if (value.length > 500) throw new Error("A tagging-rule import is limited to 500 rules");
  return value.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`Tagging rule ${index + 1} must be an object`);
    }
    const { rule, tags } = candidate as Record<string, unknown>;
    if (typeof rule !== "string" || !rule.trim() || rule.length > 2_000) {
      throw new Error(`Tagging rule ${index + 1} has an invalid rule expression`);
    }
    validateTaggingRule(rule.trim());
    if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === "string")) {
      throw new Error(`Tagging rule ${index + 1} must contain a string tags array`);
    }
    const normalizedTags = [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))].slice(0, 50);
    if (!normalizedTags.length) throw new Error(`Tagging rule ${index + 1} must contain at least one tag`);
    return { rule: rule.trim(), tags: normalizedTags };
  });
}

export async function applyTaggingRules(userId: string, entryId: string) {
  const [entry, rules, preference] = await Promise.all([
    db.entry.findFirst({ where: { id: entryId, userId } }),
    db.taggingRule.findMany({ where: { userId }, orderBy: { createdAt: "asc" } }),
    db.userPreference.findUnique({ where: { userId }, select: { readingSpeed: true } }),
  ]);
  if (!entry || !rules.length) return;
  const fields = entryFields(entry, preference?.readingSpeed ?? 200);
  const labels = new Set<string>();
  for (const rule of rules) {
    if (!matchesTaggingRule(rule.rule, fields) || !Array.isArray(rule.tags)) continue;
    for (const value of rule.tags) if (typeof value === "string" && value.trim()) labels.add(value.trim().toLowerCase());
  }
  if (!labels.size) return;
  await db.entry.update({
    where: { id: entry.id },
    data: {
      tags: {
        connectOrCreate: [...labels].map((label) => ({
          where: { userId_slug: { userId, slug: slug(label) } },
          create: { userId, label, slug: slug(label) },
        })),
      },
    },
  });
}

export async function applyTaggingRulesToAll(userId: string): Promise<number> {
  const entries = await db.entry.findMany({ where: { userId }, select: { id: true } });
  for (const entry of entries) await applyTaggingRules(userId, entry.id);
  return entries.length;
}

function entryFields(entry: Entry, readingSpeed: number): RuleFields {
  return {
    title: entry.title,
    url: entry.url,
    isArchived: entry.archived,
    isStarred: entry.starred,
    content: entry.content,
    language: entry.language,
    mimetype: entry.mimeType,
    readingTime: Math.round(entry.readingTime / readingSpeed * 200),
    domainName: entry.domainName,
  };
}

function parseRule(source: string): Node {
  if (!source.trim() || source.length > 2_000) throw new Error("Rule must contain between 1 and 2,000 characters");
  const tokens = tokenize(source);
  let index = 0;

  function parseOr(): Node {
    let node = parseAnd();
    while (peek("OR")) { index += 1; node = { kind: "logical", operator: "OR", left: node, right: parseAnd() }; }
    return node;
  }

  function parseAnd(): Node {
    let node = parseUnary();
    while (peek("AND")) { index += 1; node = { kind: "logical", operator: "AND", left: node, right: parseUnary() }; }
    return node;
  }

  function parseUnary(): Node {
    if (peek("NOT")) { index += 1; return { kind: "not", expression: parseUnary() }; }
    return parsePrimary();
  }

  function parsePrimary(): Node {
    if (tokens[index]?.value === "(") {
      index += 1;
      const node = parseOr();
      expect(")");
      return node;
    }
    const field = tokens[index++];
    if (!field || field.kind !== "identifier" || !allowedFields.has(field.value)) {
      throw syntaxError(source, field?.position ?? source.length, `Unknown rule variable ${field?.value ?? ""}`.trim());
    }
    const operator = tokens[index++];
    if (!operator || operator.kind !== "operator") throw syntaxError(source, operator?.position ?? source.length, "Expected a comparison operator");
    const value = tokens[index++];
    if (!value || !["string", "number", "identifier"].includes(value.kind)) throw syntaxError(source, value?.position ?? source.length, "Expected a comparison value");
    const parsedValue: RuleValue = value.kind === "number" ? Number(value.value) : value.kind === "identifier" && /^(true|false)$/i.test(value.value) ? value.value.toLowerCase() === "true" : value.value;
    return { kind: "comparison", field: field.value, operator: operator.value.toLowerCase(), value: parsedValue };
  }

  function peek(value: string): boolean {
    return tokens[index]?.kind === "operator" && tokens[index].value.toUpperCase() === value;
  }

  function expect(value: string) {
    const token = tokens[index++];
    if (token?.value !== value) throw syntaxError(source, token?.position ?? source.length, `Expected ${value}`);
  }

  const root = parseOr();
  if (index !== tokens.length) throw syntaxError(source, tokens[index].position, `Unexpected token ${tokens[index].value}`);
  return root;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < source.length) {
    if (/\s/.test(source[index])) { index += 1; continue; }
    const position = index;
    const character = source[index];
    if (character === "(" || character === ")") { tokens.push({ kind: "paren", value: character, position }); index += 1; continue; }
    if (character === '"' || character === "'") {
      const quote = character;
      let value = "";
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\" && index + 1 < source.length) { value += source[index + 1]; index += 2; }
        else value += source[index++];
      }
      if (source[index] !== quote) throw syntaxError(source, position, "Unterminated string");
      index += 1;
      tokens.push({ kind: "string", value, position });
      continue;
    }
    const comparison = /^(<=|>=|=>|!=|=|<|>)/.exec(source.slice(index));
    if (comparison) { tokens.push({ kind: "operator", value: comparison[1] === "=>" ? ">=" : comparison[1], position }); index += comparison[1].length; continue; }
    const number = /^-?\d+(?:\.\d+)?/.exec(source.slice(index));
    if (number) { tokens.push({ kind: "number", value: number[0], position }); index += number[0].length; continue; }
    const identifier = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(index));
    if (identifier) {
      const upper = identifier[0].toUpperCase();
      const operator = ["AND", "OR", "NOT", "IS", "MATCHES", "NOTMATCHES"].includes(upper);
      tokens.push({ kind: operator ? "operator" : "identifier", value: operator ? upper : identifier[0], position });
      index += identifier[0].length;
      continue;
    }
    throw syntaxError(source, position, `Unexpected character ${character}`);
  }
  return tokens;
}

function evaluate(node: Node, fields: RuleFields): boolean {
  if (node.kind === "logical") return node.operator === "AND" ? evaluate(node.left, fields) && evaluate(node.right, fields) : evaluate(node.left, fields) || evaluate(node.right, fields);
  if (node.kind === "not") return !evaluate(node.expression, fields);
  const subject = fields[node.field];
  if (node.operator === "matches") return subject !== null && String(subject).toLocaleLowerCase().includes(String(node.value).toLocaleLowerCase());
  if (node.operator === "notmatches") return subject === null || !String(subject).toLocaleLowerCase().includes(String(node.value).toLocaleLowerCase());
  if (node.operator === "=" || node.operator === "is") return subject === coerce(node.value, subject);
  if (node.operator === "!=") return subject !== coerce(node.value, subject);
  if (subject === null) return false;
  const comparison = typeof subject === "number"
    ? Number.isFinite(Number(node.value)) ? subject - Number(node.value) : Number.NaN
    : String(subject).localeCompare(String(node.value));
  if (node.operator === "<=") return comparison <= 0;
  if (node.operator === "<") return comparison < 0;
  if (node.operator === ">=") return comparison >= 0;
  if (node.operator === ">") return comparison > 0;
  return false;
}

function coerce(value: RuleValue, subject: RuleValue): RuleValue {
  if (typeof subject === "number") return Number(value);
  if (typeof subject === "boolean") return value === true || String(value).toLowerCase() === "true" || value === 1;
  return value === null ? null : String(value);
}

function slug(value: string): string {
  return value.normalize("NFKD").toLowerCase().trim().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 120);
}

function syntaxError(source: string, position: number, message: string): Error {
  return new Error(`${message} at character ${position + 1} in “${source}”`);
}
