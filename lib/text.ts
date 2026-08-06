export function parseTags(value: string | string[] | null | undefined): string[] {
  const values = Array.isArray(value) ? value : (value ?? "").split(",");
  return [...new Set(values.map((tag) => tag.trim()).filter(Boolean))].slice(0, 50);
}

export function stripHtml(value: string): string {
  return value
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
