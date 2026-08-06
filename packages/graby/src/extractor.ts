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

export interface ExtractorOptions {
  contentLinks: "preserve" | "footnotes" | "remove";
  rewriteRelativeUrls: boolean;
  imgNoReferrer: boolean;
}

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

  process(html: string, url: URL, siteConfig = new SiteConfig(), options: ExtractorOptions = defaultOptions): ExtractedContent {
    let source = html;
    siteConfig.find_string.forEach((find, index) => {
      source = source.split(find).join(siteConfig.replace_string[index] ?? "");
    });

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
      for (const element of document.querySelectorAll(`[id], [class]`)) {
        if (element.id.split(/\s+/).includes(value) || element.classList.contains(value)) element.remove();
      }
    }
    for (const value of siteConfig.strip_image_src) {
      for (const image of document.querySelectorAll("img")) if (image.src.includes(value)) image.remove();
    }
    for (const pattern of siteConfig.post_strip_attr) removeAttributeNodes(document, pattern);
    for (const element of document.querySelectorAll(".entry-unrelated, .instapaper_ignore, [style*='display:none'], [style*='visibility:hidden']")) element.remove();

    const customTitle = firstString(document, siteConfig.title);
    const customAuthors = firstStrings(document, siteConfig.author);
    const customDate = validateDate(firstString(document, siteConfig.date));
    let customBody = firstBody(document, siteConfig.body);

    const shouldAutodetect = !customBody || siteConfig.autodetectOnFailure();
    const article = shouldAutodetect
      ? new Readability(document.cloneNode(true) as Document, { keepClasses: true }).parse()
      : null;
    if (!customBody) customBody = article?.content ?? metadata.body;

    const title = cleanText(customTitle ?? metadata.title ?? article?.title ?? document.title) || null;
    const authors = uniqueStrings(customAuthors.length ? customAuthors : metadata.authors.length ? metadata.authors : splitAuthors(article?.byline));
    const language = cleanText(metadata.language ?? article?.lang) || null;
    const date = customDate ?? validateDate(metadata.date);
    const image = absoluteUrl(metadata.image, url);
    const cleaned = customBody ? cleanupHtml(customBody, url, options) : "";
    const summary = excerpt(article?.excerpt ?? new JSDOM(cleaned).window.document.body.textContent ?? "");

    return {
      title,
      html: cleaned,
      summary,
      language,
      date,
      authors,
      image,
      isNativeAd: nativeAd,
      nextPageUrl,
      singlePageUrl,
      isSuccess: cleaned.trim().length > 0,
    };
  }

  cleanupHtml(html: string, url: URL, options: ExtractorOptions = defaultOptions): string {
    const extracted = this.process(html, url, new SiteConfig(), options);
    return extracted.html || cleanupHtml(html, url, options);
  }

  validateDate(value: string | null | undefined): string | null {
    return validateDate(value);
  }

  private applyLazyImages(document: Document, config: SiteConfig): void {
    const attributes = [config.src_lazy_load_attr, "data-src", "data-lazy-src", "data-original", "data-url"].filter(Boolean) as string[];
    for (const image of document.querySelectorAll("img")) {
      if (image.getAttribute("src") && !image.getAttribute("src")?.startsWith("data:")) continue;
      const lazy = attributes.map((attribute) => image.getAttribute(attribute)).find(Boolean);
      if (lazy) image.setAttribute("src", lazy);
    }
  }
}

const defaultOptions: ExtractorOptions = {
  contentLinks: "preserve",
  rewriteRelativeUrls: true,
  imgNoReferrer: true,
};

function extractMetadata(document: Document, config: SiteConfig): Metadata {
  const meta = (selector: string) => document.querySelector<HTMLMetaElement>(selector)?.content?.trim() || null;
  const metadata: Metadata = {
    title: meta('meta[property="og:title"]'),
    image:
      meta('meta[property="og:image:secure_url"]') ??
      meta('meta[property="og:image:url"]') ??
      meta('meta[property="og:image"]'),
    language: meta('meta[property="og:locale"]') ?? document.documentElement.lang ?? meta('meta[name="DC.language"]'),
    date: meta('meta[property="article:published_time"]') ?? meta('meta[property="article:modified_time"]'),
    authors: [],
    body: null,
  };

  if (config.skip_json_ld) return metadata;
  const ignoredTypes = new Set(["BreadcrumbList", "WebSite", "Organization", "Person"]);
  for (const script of document.querySelectorAll<HTMLScriptElement>('script[type="application/ld+json"]')) {
    try {
      const raw = JSON.parse(script.textContent ?? "") as unknown;
      for (const data of flattenJsonLd(raw)) {
        const type = Array.isArray(data["@type"]) ? data["@type"] : [data["@type"]];
        if (type.some((value) => typeof value === "string" && ignoredTypes.has(value))) continue;
        metadata.date = stringValue(data.datePublished) ?? stringValue(data.dateModified) ?? metadata.date;
        metadata.title = stringValue(data.headline) ?? stringValue(data.name) ?? metadata.title;
        metadata.authors.push(...extractAuthors(data.author));
        metadata.image = extractImage(data.image) ?? metadata.image;
        metadata.body = stringValue(data.articleBody) ? `<p>${escapeHtml(stringValue(data.articleBody)!)}</p>` : metadata.body;
      }
    } catch {
      // Invalid JSON-LD is common and must not prevent extraction.
    }
  }
  metadata.authors = uniqueStrings(metadata.authors);
  return metadata;
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
    return typeof name === "string" ? [name] : [];
  }
  return [];
}

function extractImage(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return extractImage(value[0]);
  if (value && typeof value === "object") return stringValue((value as Record<string, unknown>).url);
  return null;
}

function evaluate(document: Document, pattern: string): XPathResult | null {
  try {
    return document.evaluate(pattern, document, null, document.defaultView?.XPathResult.ANY_TYPE ?? 0, null);
  } catch {
    return null;
  }
}

function evaluateNodes(document: Document, pattern: string): Node[] {
  const result = evaluate(document, pattern);
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

function resultString(result: XPathResult | null): string | null {
  if (!result) return null;
  if (result.resultType === 2) return cleanText(result.stringValue) || null;
  const node = evaluateResultFirstNode(result);
  return cleanText(node?.textContent) || null;
}

function evaluateResultFirstNode(result: XPathResult): Node | null {
  if (result.resultType === 4 || result.resultType === 5) return result.iterateNext();
  if (result.resultType === 6 || result.resultType === 7) return result.snapshotItem(0);
  return result.singleNodeValue;
}

function firstString(document: Document, patterns: string[]): string | null {
  for (const pattern of patterns) {
    const value = resultString(evaluate(document, pattern));
    if (value) return value;
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
    const values = evaluateNodes(document, pattern).map((node) => cleanText(node.textContent)).filter(Boolean) as string[];
    if (values.length) return values;
  }
  return [];
}

function firstBody(document: Document, patterns: string[]): string | null {
  for (const pattern of patterns) {
    const nodes = evaluateNodes(document, pattern);
    if (!nodes.length) continue;
    const wrapper = document.createElement("div");
    for (const node of nodes) wrapper.append(node.cloneNode(true));
    return wrapper.innerHTML;
  }
  return null;
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

function cleanupHtml(html: string, base: URL, options: ExtractorOptions): string {
  const dom = new JSDOM(`<main id="wallaby-content">${html}</main>`, { url: base.toString() });
  const root = dom.window.document.querySelector("#wallaby-content")!;
  for (const element of root.querySelectorAll<HTMLElement>("[style], [srcdoc]")) {
    element.removeAttribute("style");
    element.removeAttribute("srcdoc");
  }
  if (options.rewriteRelativeUrls) {
    for (const element of root.querySelectorAll<HTMLElement>("a[href], img[src], source[src], video[src], audio[src], iframe[src], [poster]")) {
      for (const attribute of ["href", "src", "poster"] as const) {
        const value = element.getAttribute(attribute);
        if (!value) continue;
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

function splitAuthors(value: string | null | undefined): string[] {
  return value ? value.split(/\s+(?:and|&)\s+|\s*,\s*/i) : [];
}

function excerpt(value: string, length = 250): string {
  const text = cleanText(value);
  return text.length <= length ? text : `${text.slice(0, length).replace(/\s+\S*$/, "")} …`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]!);
}
