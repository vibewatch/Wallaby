/**
 * Reads what the bookmarklet or the operating-system share sheet handed to
 * `/entries/new`. Share sheets are inconsistent: Android apps commonly put the
 * link in `text` ("Great read https://…") and leave `url` empty, so the first
 * web address in the text is used when no explicit URL arrives.
 */

export type SharedArticle = { url: string; title: string; tags: string };

type Params = Record<string, string | string[] | undefined>;

const MAX_FIELD_LENGTH = 8_192;

export function readSharedArticle(params: Params): SharedArticle {
  const url = field(params.url);
  const text = field(params.text);
  const title = field(params.title).slice(0, 1_000);
  return {
    url: url || firstWebAddress(text) || "",
    // A title that is only the shared link carries no information.
    title: title && title !== url ? title : "",
    tags: field(params.tags).slice(0, 2_000),
  };
}

export function firstWebAddress(text: string): string | null {
  const match = /https?:\/\/[^\s<>"'`]+/i.exec(text);
  // Sentence punctuation directly after a link belongs to the sentence.
  return match ? match[0].replace(/[.,;:!?)\]}]+$/, "") : null;
}

function field(value: string | string[] | undefined): string {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" ? first.trim().slice(0, MAX_FIELD_LENGTH) : "";
}

/**
 * The bookmarklet opens Wallaby's save page for the current tab. It carries only
 * the address and title, never page content or cookies, and the save itself
 * still requires a click inside Wallaby, so a link to `/entries/new` from
 * another site cannot add entries on its own.
 */
export function bookmarkletSource(origin: string): string {
  const target = JSON.stringify(`${origin.replace(/\/+$/, "")}/entries/new`);
  return `javascript:(()=>{const u=new URL(${target});u.searchParams.set("url",location.href);u.searchParams.set("title",document.title);window.open(u.href,"_blank","noopener")})()`;
}
