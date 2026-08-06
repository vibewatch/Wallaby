import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import sanitizeHtml from "sanitize-html";

import type { ExtractedContent } from "./types";
import { SiteConfig } from "./types";
import { absoluteUrl } from "./url";

type Metadata = {
  title: string | null;
  image: string | null;
  language: string | null;
  date: string | null;
  authors: string[];
  body: string | null;
};

export interface ContentExtractorOptions {
  contentLinks: "preserve" | "footnotes" | "remove";
  rewriteRelativeUrls: boolean;
  imgNoReferrer: boolean;
  xssFilter?: boolean;
}

// Mirrors ContentExtractorConfig::$src_lazy_load_attributes plus per-site src_lazy_load_attr.
const defaultLazyAttributes = ["data-src", "data-lazy-src", "data-original", "data-sources", "data-hi-res-src", "data-srcset"];

export class ContentExtractor {
  hasXPathMatch(html: string, url: URL, pattern: string | null): boolean {
    if (!pattern) return false;
    const document = new JSDOM(html, { url: url.toString(), contentType: "text/html" }).window.document;
    return evaluateNodes(document, pattern).length > 0;
  }

  findHostUsingFingerprints(html: string, fingerprints: Record<string, string>): string | null {
    for (const [pattern, host] of Object.entries(fingerprints)) {
      try {
        if (new RegExp(pattern, "is").test(html)) return host;
      } catch {
        // A custom invalid fingerprint is ignored like a malformed site XPath.
      }
    }
    return null;
  }

  process(html: string, url: URL, siteConfig = new SiteConfig(), options: ContentExtractorOptions = defaultOptions): ExtractedContent {
    let source = html;
    if (siteConfig.find_string.length === siteConfig.replace_string.length) {
      siteConfig.find_string.forEach((find, index) => {
        source = source.split(find).join(siteConfig.replace_string[index] ?? "");
      });
    }

    const dom = new JSDOM(source, { url: url.toString(), contentType: "text/html" });
    const { document } = dom.window;
    this.applyLazyImages(document, siteConfig);
    const metadata = extractMetadata(document, siteConfig);

    const nativeAd = siteConfig.native_ad_clue.some((pattern) => evaluateNodes(document, pattern).length > 0);
    const nextPageUrl = findLinkedUrl(document, siteConfig.next_page_link, url, siteConfig.if_page_contains.next_page_link);
    const singlePageUrl = findLinkedUrl(document, siteConfig.single_page_link, url, siteConfig.if_page_contains.single_page_link);

    for (const [tag, pattern] of Object.entries(siteConfig.wrap_in)) {
      for (const node of evaluateNodes(document, pattern)) {
        if (!(node instanceof dom.window.Element)) continue;
        const wrapper = document.createElement(tag);
        node.parentNode?.insertBefore(wrapper, node);
        wrapper.appendChild(node);
      }
    }

    for (const pattern of siteConfig.strip) removeNodes(document, pattern);
    for (const value of siteConfig.strip_id_or_class) {
      const clean = value.replace(/["']/g, "");
      for (const element of document.querySelectorAll(`[id], [class]`)) {
        if (element.id.split(/\s+/).includes(clean) || element.classList.contains(clean)) element.remove();
      }
    }
    for (const value of siteConfig.strip_image_src) {
      const clean = value.replace(/["']/g, "");
      for (const image of document.querySelectorAll("img")) if (image.getAttribute("src")?.includes(clean)) image.remove();
    }
    for (const pattern of siteConfig.post_strip_attr) removeAttributeNodes(document, pattern);
    for (const element of document.querySelectorAll(".entry-unrelated, .instapaper_ignore, [style*='display:none'], [style*='visibility:hidden']")) element.remove();
    // strip empty <a> elements (no child elements and no text)
    for (const anchor of [...document.querySelectorAll("a")]) {
      if (anchor.children.length === 0 && !cleanText(anchor.textContent)) anchor.remove();
    }

    let title = firstStringRemove(document, siteConfig.title) ?? metadata.title;
    let authors = firstStrings(document, siteConfig.author);
    if (!authors.length) authors = metadata.authors;
    let date = firstStringRemove(document, siteConfig.date) ?? metadata.date;
    let body = firstBody(document, siteConfig.body) ?? metadata.body;

    const hasTitleRules = siteConfig.title.length > 0;
    const hasBodyRules = siteConfig.body.length > 0;
    const hasDateRules = siteConfig.date.length > 0;
    const hasAuthorRules = siteConfig.author.length > 0;
    let detectTitle = !title && (!hasTitleRules || siteConfig.autodetectOnFailure());
    let detectBody = !body && (!hasBodyRules || siteConfig.autodetectOnFailure());
    let detectDate = !date && (!hasDateRules || siteConfig.autodetectOnFailure());
    let detectAuthor = !authors.length && (!hasAuthorRules || siteConfig.autodetectOnFailure());

    // hNews microformat
    if (detectTitle || detectBody || detectDate || detectAuthor) {
      const hentry = firstNode(document, classQuery("hentry"));
      if (hentry instanceof dom.window.Element) {
        if (detectTitle) {
          const value = textFromScopedClass(document, hentry, "entry-title");
          if (value) { title = value; detectTitle = false; }
        }
        if (detectDate) {
          const value = scopedText(document, hentry, ".//time[@pubdate or @pubDate] | .//abbr[contains(concat(' ',normalize-space(@class),' '),' published ')]");
          if (value) { date = value; detectDate = false; }
        }
        if (detectAuthor) {
          const found = hnewsAuthors(document, hentry);
          if (found.length) { authors = found; detectAuthor = false; }
        }
        if (detectBody) {
          const value = scopedBody(document, hentry, ".//*[contains(concat(' ',normalize-space(@class),' '),' entry-content ')]");
          if (value) { body = value; detectBody = false; }
        }
      }
    }

    if (detectTitle) {
      const value = textFromScopedClass(document, document, "instapaper_title");
      if (value) { title = value; detectTitle = false; }
    }
    if (detectBody) {
      const value = scopedBody(document, document, "//*[contains(concat(' ',normalize-space(@class),' '),' instapaper_body ')]");
      if (value) { body = value; detectBody = false; }
    }
    if (detectBody) {
      const value = scopedBody(document, document, "//*[@itemprop='articleBody']");
      if (value) { body = value; detectBody = false; }
    }
    if (detectAuthor) {
      const relAuthors = evaluateNodes(document, "//a[contains(concat(' ',normalize-space(@rel),' '),' author ')]")
        .map((node) => cleanText(node.textContent)).filter(Boolean) as string[];
      if (relAuthors.length) authors = [...authors, ...relAuthors];
      const metaAuthors = evaluateNodes(document, '//meta[@name="author"]/@content')
        .map((node) => cleanText(node.nodeValue)).filter(Boolean) as string[];
      if (metaAuthors.length) authors = [...authors, ...metaAuthors];
    }
    if (detectDate) {
      const value = scopedText(document, document, "//time[@pubdate or @pubDate]");
      if (value) date = value;
    }

    // Readability fallback for title and/or body only when still missing
    if (detectTitle || detectBody) {
      const article = new Readability(document.cloneNode(true) as Document, { keepClasses: true }).parse();
      if (detectTitle && article?.title) title = cleanText(article.title);
      if (detectBody && article?.content) body = article.content;
      if (detectTitle && !title) title = cleanText(article?.title) || null;
    }

    date = validateDate(date);

    const finalTitle = cleanText(title ?? document.title) || null;
    const finalAuthors = uniqueStrings(authors);
    const language = cleanText(metadata.language) || null;
    const image = absoluteUrl(metadata.image, url);

    const preparedBody = body ?? "";
    const cleaned = preparedBody ? cleanupHtml(preparedBody, url, options, finalTitle) : "";
    const summary = excerpt(new JSDOM(cleaned).window.document.body.textContent ?? "");

    return {
      title: finalTitle,
      html: cleaned,
      summary,
      language,
      date,
      authors: finalAuthors,
      image,
      isNativeAd: nativeAd,
      nextPageUrl,
      singlePageUrl,
      isSuccess: cleaned.trim().length > 0,
    };
  }

  cleanupHtml(html: string, url: URL, options: ContentExtractorOptions = defaultOptions): string {
    const extracted = this.process(html, url, new SiteConfig(), options);
    return extracted.html || cleanupHtml(html, url, options);
  }

  validateDate(value: string | null | undefined): string | null {
    return validateDate(value);
  }

  private applyLazyImages(document: Document, config: SiteConfig): void {
    const attributes = [...new Set([config.src_lazy_load_attr, ...defaultLazyAttributes].filter(Boolean) as string[])];
    for (const image of [...document.querySelectorAll("img")]) {
      const present = attributes.filter((attribute) => image.hasAttribute(attribute));
      if (!present.length) continue;

      // WordPress lazy-load plugin keeps the real markup inside a following <noscript>.
      const sibling = image.nextElementSibling;
      if (sibling && sibling.tagName.toLowerCase() === "noscript") {
        const fragment = JSDOM.fragment(sibling.innerHTML);
        sibling.replaceWith(fragment);
        image.remove();
        continue;
      }

      for (const attribute of present) {
        const key = attribute === "data-srcset" ? "srcset" : "src";
        const value = image.getAttribute(attribute);
        image.removeAttribute(attribute);
        if (value) image.setAttribute(key, value);
      }
    }
  }
}

const defaultOptions: ContentExtractorOptions = {
  contentLinks: "preserve",
  rewriteRelativeUrls: true,
  imgNoReferrer: true,
};

function extractMetadata(document: Document, config: SiteConfig): Metadata {
  const meta = (selector: string) => document.querySelector<HTMLMetaElement>(selector)?.content?.trim() || null;
  const ogImage =
    firstNonDataImage(meta('meta[property="og:image"]'), meta('meta[property="og:image:url"]'), meta('meta[property="og:image:secure_url"]'));
  // html[lang] and DC.language take precedence over og:locale (mirrors ContentExtractor ordering).
  const htmlLang = document.documentElement.getAttribute("lang")?.trim() || null;
  const dcLanguage = meta('meta[name="DC.language"]');
  const metadata: Metadata = {
    title: meta('meta[property="og:title"]'),
    image: ogImage,
    language: htmlLang ?? dcLanguage ?? meta('meta[property="og:locale"]'),
    date: meta('meta[property="article:modified_time"]') ?? meta('meta[property="article:published_time"]'),
    authors: [],
    body: null,
  };
  // article:published_time overrides article:modified_time when both present.
  const published = meta('meta[property="article:published_time"]');
  if (published) metadata.date = published;

  if (config.skip_json_ld) return metadata;
  const ignoredTypes = new Set(["Organization", "WebSite", "Person", "VideoGame"]);
  const ignoredNames = new Set<string>();
  const candidateNames: string[] = [];
  for (const script of document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]')) {
    let raw: unknown;
    try {
      raw = JSON.parse(script.textContent ?? "");
    } catch {
      continue; // Invalid JSON-LD is common and must not prevent extraction.
    }
    for (const data of flattenJsonLd(raw)) {
      const type = Array.isArray(data["@type"]) ? data["@type"] : [data["@type"]];
      if (type.some((value) => typeof value === "string" && ignoredTypes.has(value))) {
        const name = stringValue(data.name);
        if (name) ignoredNames.add(name);
        continue;
      }
      if (stringValue(data.dateModified)) metadata.date = stringValue(data.dateModified);
      if (stringValue(data.datePublished)) metadata.date = stringValue(data.datePublished);
      metadata.authors.push(...extractAuthors(data.author));
      const image = extractImage(data.image);
      if (image) metadata.image ??= image;
      const articleBody = stringValue(data.articleBody);
      if (articleBody) metadata.body = `<p>${escapeHtml(articleBody)}</p>`;
      const headline = stringValue(data.headline);
      if (headline) candidateNames.push(headline);
      const name = stringValue(data.name);
      if (name) candidateNames.push(name);
    }
  }
  for (const name of candidateNames) {
    if (!ignoredNames.has(name)) metadata.title = metadata.title ?? name;
  }
  metadata.authors = uniqueStrings(metadata.authors);
  return metadata;
}

function firstNonDataImage(...values: (string | null)[]): string | null {
  for (const value of values) {
    if (value && !/^data:image/i.test(value)) return value;
  }
  return null;
}

function flattenJsonLd(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(flattenJsonLd);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  return [record, ...flattenJsonLd(record["@graph"])];
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) return stringValue(value[0]);
  return null;
}

function extractAuthors(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(extractAuthors);
  if (value && typeof value === "object") {
    const name = (value as Record<string, unknown>).name;
    if (typeof name === "string") return [name];
    if (Array.isArray(name)) return name.filter((entry): entry is string => typeof entry === "string");
    return [];
  }
  return [];
}

function extractImage(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return extractImage(value[0]);
  if (value && typeof value === "object") return stringValue((value as Record<string, unknown>).url);
  return null;
}

function evaluate(document: Document, pattern: string, context: Node = document): XPathResult | null {
  try {
    return document.evaluate(pattern, context, null, document.defaultView?.XPathResult.ANY_TYPE ?? 0, null);
  } catch {
    return null;
  }
}

function evaluateNodes(document: Document, pattern: string, context: Node = document): Node[] {
  const result = evaluate(document, pattern, context);
  if (!result) return [];
  const nodes: Node[] = [];
  if (result.resultType === 4 || result.resultType === 5) {
    let node: Node | null;
    while ((node = result.iterateNext())) nodes.push(node);
  } else if (result.resultType === 6 || result.resultType === 7) {
    for (let index = 0; index < result.snapshotLength; index++) {
      const node = result.snapshotItem(index);
      if (node) nodes.push(node);
    }
  } else if (result.singleNodeValue) nodes.push(result.singleNodeValue);
  return nodes;
}

function evaluateResultFirstNode(result: XPathResult): Node | null {
  if (result.resultType === 4 || result.resultType === 5) return result.iterateNext();
  if (result.resultType === 6 || result.resultType === 7) return result.snapshotItem(0);
  return result.singleNodeValue;
}

function firstNode(document: Document, pattern: string, context: Node = document): Node | null {
  const result = evaluate(document, pattern, context);
  return result ? evaluateResultFirstNode(result) : null;
}

// Extract the first matching string and remove the matched node from the tree,
// mirroring ContentExtractor::extractEntityFromPattern so titles/dates don't linger in the body.
function firstStringRemove(document: Document, patterns: string[]): string | null {
  for (const pattern of patterns) {
    const result = evaluate(document, pattern);
    if (!result) continue;
    if (result.resultType === 2) {
      const value = cleanText(result.stringValue);
      if (value) return value;
      continue;
    }
    const node = evaluateResultFirstNode(result);
    const value = cleanText(node?.textContent);
    if (value) {
      node?.parentNode?.removeChild(node);
      return value;
    }
  }
  return null;
}

function firstStrings(document: Document, patterns: string[]): string[] {
  for (const pattern of patterns) {
    const result = evaluate(document, pattern);
    if (!result) continue;
    if (result.resultType === 2) {
      const value = cleanText(result.stringValue);
      if (value) return [value];
    }
    const nodes = evaluateNodes(document, pattern);
    const values = nodes.map((node) => cleanText(node.textContent)).filter(Boolean) as string[];
    if (values.length) {
      for (const node of nodes) node.parentNode?.removeChild(node);
      return values;
    }
  }
  return [];
}

function firstBody(document: Document, patterns: string[]): string | null {
  for (const pattern of patterns) {
    const nodes = evaluateNodes(document, pattern);
    if (!nodes.length) continue;
    if (nodes.length === 1 && nodes[0] instanceof document.defaultView!.Element) {
      return (nodes[0] as Element).outerHTML;
    }
    const wrapper = document.createElement("div");
    for (const node of nodes) wrapper.append(node.cloneNode(true));
    return wrapper.innerHTML;
  }
  return null;
}

function classQuery(className: string): string {
  return `//*[contains(concat(' ',normalize-space(@class),' '),' ${className} ')]`;
}

function scopedText(document: Document, context: Node, pattern: string): string | null {
  const node = firstNode(document, pattern, context);
  const value = cleanText(node?.textContent);
  if (value) {
    node?.parentNode?.removeChild(node);
    return value;
  }
  return null;
}

function textFromScopedClass(document: Document, context: Node, className: string): string | null {
  return scopedText(document, context, `.//*[contains(concat(' ',normalize-space(@class),' '),' ${className} ')]`);
}

function scopedBody(document: Document, context: Node, pattern: string): string | null {
  const nodes = evaluateNodes(document, pattern, context);
  if (!nodes.length) return null;
  if (nodes.length === 1 && nodes[0] instanceof document.defaultView!.Element) return (nodes[0] as Element).outerHTML;
  const wrapper = document.createElement("div");
  for (const node of nodes) wrapper.append(node.cloneNode(true));
  return wrapper.innerHTML;
}

function hnewsAuthors(document: Document, hentry: Node): string[] {
  const vcard = firstNode(
    document,
    ".//*[contains(concat(' ',normalize-space(@class),' '),' vcard ') and (contains(concat(' ',normalize-space(@class),' '),' author ') or contains(concat(' ',normalize-space(@class),' '),' byline '))]",
    hentry,
  );
  if (!vcard) return [];
  const fns = evaluateNodes(document, ".//*[contains(concat(' ',normalize-space(@class),' '),' fn ')]", vcard)
    .map((node) => cleanText(node.textContent)).filter(Boolean) as string[];
  if (fns.length) return fns;
  const value = cleanText(vcard.textContent);
  return value ? [value] : [];
}

function removeNodes(document: Document, pattern: string): void {
  for (const node of evaluateNodes(document, pattern)) {
    if (node.nodeType === 2) (node as Attr).ownerElement?.removeAttribute((node as Attr).name);
    else node.parentNode?.removeChild(node);
  }
}

function removeAttributeNodes(document: Document, pattern: string): void {
  for (const node of evaluateNodes(document, pattern)) {
    if (node.nodeType === 2) (node as Attr).ownerElement?.removeAttribute((node as Attr).name);
  }
}

function findLinkedUrl(document: Document, patterns: string[], base: URL, conditions: Record<string, string> = {}): string | null {
  for (const pattern of patterns) {
    const condition = conditions[pattern];
    if (condition && evaluateNodes(document, condition).length === 0) continue;
    const result = evaluate(document, pattern);
    if (!result) continue;
    if (result.resultType === 2) return absoluteUrl(result.stringValue, base);
    const node = evaluateResultFirstNode(result);
    if (node instanceof document.defaultView!.Element) {
      return absoluteUrl(node.getAttribute("href") ?? node.getAttribute("src"), base);
    }
    if (node?.nodeType === 2) return absoluteUrl((node as Attr).value, base);
  }
  return null;
}

// Remove a leading h1-h6 whose text duplicates the title (mirrors ContentExtractor body handling).
function removeLeadingTitleHeading(root: Element, title: string | null): void {
  if (!title) return;
  let first = root.firstChild;
  while (first && first.nodeType !== 1) first = first.nextSibling;
  const doc = root.ownerDocument;
  if (first && first.nodeType === 1 && doc?.defaultView && first instanceof doc.defaultView.Element && /^h[1-6]$/i.test(first.tagName) && cleanText(first.textContent).toLowerCase() === title.toLowerCase()) {
    first.remove();
  }
}

function cleanupHtml(html: string, base: URL, options: ContentExtractorOptions, title: string | null = null): string {
  const dom = new JSDOM(`<main id="wallaby-content">${html}</main>`, { url: base.toString() });
  let root: Element = dom.window.document.querySelector("#wallaby-content")!;
  for (const element of root.querySelectorAll<HTMLElement>("[style], [srcdoc]")) {
    element.removeAttribute("style");
    element.removeAttribute("srcdoc");
  }

  // Give self-closing iframes some text so they survive serialization/sanitization.
  for (const frame of root.querySelectorAll("iframe")) {
    if (!frame.hasChildNodes()) frame.textContent = "[embedded content]";
  }

  // Unwrap redundant single-child container nesting: <div><div><p>…</p></div></div> → <p>…</p>
  while (root.children.length === 1 && ["div", "article", "section", "header", "footer"].includes(root.children[0].tagName.toLowerCase())) {
    root = root.children[0];
  }
  removeLeadingTitleHeading(root, title);
  // Remove empty <p> elements.
  for (const paragraph of [...root.querySelectorAll("p")]) {
    if (!paragraph.children.length && !cleanText(paragraph.textContent)) paragraph.remove();
  }

  if (options.rewriteRelativeUrls) {
    for (const element of root.querySelectorAll<HTMLElement>("a[href], img[src], source[src], video[src], audio[src], iframe[src], [poster]")) {
      for (const attribute of ["href", "src", "poster"] as const) {
        const value = element.getAttribute(attribute);
        if (!value) continue;
        if (value.startsWith("#")) continue; // keep in-page anchors intact
        const absolute = absoluteUrl(value, base);
        if (absolute) element.setAttribute(attribute, absolute);
        else element.removeAttribute(attribute);
      }
    }
    for (const element of root.querySelectorAll<HTMLElement>("[srcset]")) {
      const srcset = element
        .getAttribute("srcset")!
        .split(",")
        .map((candidate) => {
          const [value, descriptor] = candidate.trim().split(/\s+/, 2);
          const absolute = absoluteUrl(value, base);
          return absolute ? `${absolute}${descriptor ? ` ${descriptor}` : ""}` : "";
        })
        .filter(Boolean)
        .join(", ");
      if (srcset) element.setAttribute("srcset", srcset);
      else element.removeAttribute("srcset");
    }
  }
  if (options.imgNoReferrer) for (const image of root.querySelectorAll("img")) image.setAttribute("referrerpolicy", "no-referrer");
  if (options.contentLinks === "footnotes" && !base.hostname.endsWith("wikipedia.org")) addFootnotes(root, dom.window.document);
  if (options.contentLinks === "remove") for (const link of root.querySelectorAll("a")) link.replaceWith(...link.childNodes);

  if (options.xssFilter === false) return root.innerHTML.trim();

  return sanitizeHtml(root.innerHTML, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(["img", "figure", "figcaption", "video", "audio", "source", "iframe", "mark"]),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      "*": ["class", "id", "title", "lang", "dir"],
      a: ["href", "name", "target", "rel"],
      img: ["src", "srcset", "sizes", "alt", "width", "height", "loading", "referrerpolicy"],
      source: ["src", "srcset", "type", "media"],
      video: ["src", "poster", "controls", "width", "height"],
      audio: ["src", "controls"],
      iframe: ["src", "width", "height", "title", "allow", "allowfullscreen", "loading"],
      time: ["datetime"],
    },
    allowedSchemes: ["http", "https", "mailto"],
    allowedIframeHostnames: ["www.youtube.com", "youtube.com", "player.vimeo.com"],
    transformTags: {
      a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer" }, true),
    },
  }).trim();
}

function addFootnotes(root: Element, document: Document): void {
  const destinations = new Map<string, number>();
  for (const link of [...root.querySelectorAll<HTMLAnchorElement>("a[href]")]) {
    const href = link.href;
    if (!/^https?:/i.test(href) || !cleanText(link.textContent)) continue;
    const number = destinations.get(href) ?? destinations.size + 1;
    destinations.set(href, number);
    const reference = document.createElement("sup");
    reference.className = "wallaby-footnote-ref";
    reference.innerHTML = `<a href="#wallaby-footnote-${number}" aria-label="Footnote ${number}">[${number}]</a>`;
    link.after(reference);
  }
  if (!destinations.size) return;
  const section = document.createElement("section");
  section.className = "wallaby-footnotes";
  section.setAttribute("aria-label", "Links");
  const list = document.createElement("ol");
  for (const [href, number] of destinations) {
    const item = document.createElement("li");
    item.id = `wallaby-footnote-${number}`;
    const link = document.createElement("a");
    link.href = href;
    link.textContent = href;
    item.append(link);
    list.append(item);
  }
  section.append(list);
  root.append(section);
}

function validateDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const timestamp = /^\d{9,13}$/.test(value) ? Number(value) * (value.length > 10 ? 1 : 1000) : Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString();
}

function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map(cleanText).filter(Boolean))];
}

function excerpt(value: string, length = 250): string {
  const text = cleanText(value);
  return text.length <= length ? text : `${text.slice(0, length).replace(/\s+\S*$/, "")} …`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]!);
}
