/**
 * The one definition of "a URL Wallaby can save". Every save path — the
 * library form, the bookmarklet, the API, imports, and the CLI — parses through
 * here, so a value rejected in one place is rejected everywhere, and nothing
 * that could never be fetched is persisted as a permanently broken entry.
 */

export class InvalidEntryUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidEntryUrlError";
  }
}

const MAX_URL_LENGTH = 8_192;

/**
 * Accepts what people paste: bare hosts (`example.com/story`) default to
 * HTTPS and `feed://` links become HTTPS. Any other explicit scheme is refused
 * rather than being silently re-read as a hostname, which is how
 * `ftp://host/file` used to become `https://ftp//host/file`.
 */
export function parseEntryUrl(input: string): URL {
  let value = input.trim();
  if (!value) throw new InvalidEntryUrlError("Enter the address of the article to save.");
  if (value.length > MAX_URL_LENGTH) throw new InvalidEntryUrlError("That address is too long to save.");
  value = value.replace(/^feed:\/\//i, "https://");
  if (!/^https?:\/\//i.test(value)) {
    const scheme = /^([a-z][a-z\d+.-]*):/i.exec(value);
    // `example.com:8080/path` has the shape of a scheme too; a numeric "path"
    // after the colon means it is a port on a bare host.
    if (scheme && !/^[a-z][a-z\d+.-]*:\d+(?:[/?#]|$)/i.test(value)) {
      throw new InvalidEntryUrlError(`Only web addresses can be saved, not ${scheme[1].toLowerCase()}: links.`);
    }
    value = `https://${value}`;
  }

  let url: URL;
  try { url = new URL(value); }
  catch { throw new InvalidEntryUrlError("That does not look like a web address."); }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new InvalidEntryUrlError("Only web addresses can be saved.");
  // Credentials in a saved URL would be stored and displayed in plain text.
  if (url.username || url.password) throw new InvalidEntryUrlError("Remove the username or password from the address before saving it.");
  if (!url.hostname.includes(".") && !url.hostname.startsWith("[")) throw new InvalidEntryUrlError("That address is missing a domain name.");
  return url;
}
