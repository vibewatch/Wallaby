/**
 * Suggestions for a comma-separated tag field. Only the segment being typed —
 * the text after the last comma — is matched, and tags already listed earlier
 * are not offered again. A leading `-` (remove this tag, in bulk edits) is
 * ignored for matching and kept when a suggestion is applied.
 */

export function matchTagSuggestions(value: string, suggestions: string[], limit = 8): string[] {
  const segments = value.split(",");
  const needle = splitPrefix(segments.at(-1) ?? "").term.toLowerCase();
  if (!needle) return [];
  const taken = new Set(segments.slice(0, -1).map((segment) => splitPrefix(segment).term.toLowerCase()));
  const found = suggestions.filter((suggestion) => {
    const lower = suggestion.toLowerCase();
    return lower.includes(needle) && lower !== needle && !taken.has(lower);
  });
  // Prefix matches first; otherwise keep the most-used-first order given.
  const prefixed = found.filter((item) => item.toLowerCase().startsWith(needle));
  const inner = found.filter((item) => !item.toLowerCase().startsWith(needle));
  return [...prefixed, ...inner].slice(0, limit);
}

export function applyTagSuggestion(value: string, suggestion: string): string {
  const segments = value.split(",");
  const { prefix } = splitPrefix(segments.at(-1) ?? "");
  const kept = segments.slice(0, -1).map((segment) => segment.trim()).filter(Boolean);
  return `${[...kept, `${prefix}${suggestion}`].join(", ")}, `;
}

function splitPrefix(segment: string): { prefix: string; term: string } {
  const trimmed = segment.trim();
  return trimmed.startsWith("-") ? { prefix: "-", term: trimmed.slice(1).trim() } : { prefix: "", term: trimmed };
}
