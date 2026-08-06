import { ConfigBuilder, mergeSiteConfig } from "./site-config";
import { ContentExtractor, type ExtractorOptions } from "./extractor";
import { HttpFetcher } from "./fetcher";
import { evaluateLoginExpression } from "./login-expression";
import { extractPdf } from "./pdf";
import type { Content, ContentTypeAction, ExtractedContent, FetchResult, GrabyLogger, GrabyOptions, SiteCredential } from "./types";
import { normalizeUrl } from "./url";

const defaultContentTypeActions: Record<string, ContentTypeAction> = {
  "application/zip": { action: "link", name: "ZIP" },
  "application/pdf": { action: "link", name: "PDF" },
  image: { action: "link", name: "Image" },
  audio: { action: "link", name: "Audio" },
  video: { action: "link", name: "Video" },
  "text/plain": { action: "link", name: "Plain text" },
};

const defaults = {
  errorMessage: "Unable to retrieve a readable version of this article.",
  errorMessageTitle: "Content extraction failed",
  contentLinks: "preserve" as const,
  rewriteRelativeUrls: true,
  maxRedirects: 5,
  maxResponseBytes: 10 * 1024 * 1024,
  requestTimeoutMs: 15_000,
  userAgent: "Wallaby Graby/0.1 (+https://github.com/j0k3r/graby)",
  singlePage: true,
  multiPage: true,
  maxPages: 8,
  contentTypeActions: defaultContentTypeActions,
  fingerprints: {
    '<meta\\s+[^>]*name=["\\\']generator["\\\'][^>]*content=["\\\']Blogger': "fingerprint.blogspot.com",
    '<meta\\s+[^>]*name=["\\\']generator["\\\'][^>]*content=["\\\']WordPress': "fingerprint.wordpress.com",
    '<meta\\s+[^>]*property=["\\\']al:ios:app_name["\\\'][^>]*content=["\\\']Medium': "fingerprint.medium.com",
    '<link\\s+[^>]*href=["\\\']https://substackcdn\\.com/': "fingerprint.substack.com",
  },
};

export class Graby {
  private readonly options: Omit<Required<GrabyOptions>, "siteConfigs" | "fetcher" | "logger">;
  private readonly extractor: ContentExtractor;
  private readonly configBuilder: ConfigBuilder;
  private readonly fetcher;
  private readonly logger: GrabyLogger;
  private prefetchedContent: string | null = null;
  private imgNoReferrer = true;

  constructor(options: GrabyOptions = {}) {
    this.options = {
      ...defaults,
      ...options,
      contentTypeActions: normalizeContentTypeActions(options.contentTypeActions),
    };
    this.extractor = new ContentExtractor();
    this.configBuilder = new ConfigBuilder(options.siteConfigs);
    this.logger = options.logger ?? noOpLogger;
    this.fetcher =
      options.fetcher ??
      new HttpFetcher({
        maxRedirects: this.options.maxRedirects,
        maxResponseBytes: this.options.maxResponseBytes,
        requestTimeoutMs: this.options.requestTimeoutMs,
        userAgent: this.options.userAgent,
      });
  }

  reloadConfigFiles(sources: Record<string, string>): void {
    this.configBuilder.reload(sources);
  }

  setContentAsPrefetched(content: string): void {
    this.prefetchedContent = content;
  }

  toggleImgNoReferrer(toggle = false): void {
    this.imgNoReferrer = toggle;
  }

  async fetchContent(input: string | URL, prefetchedContent?: string, credential?: SiteCredential): Promise<Content> {
    const requestedUrl = normalizeUrl(input);
    this.logger.debug("graby.fetch.start", { host: requestedUrl.hostname, prefetched: prefetchedContent !== undefined, authenticated: Boolean(credential) });
    let siteConfig = this.configBuilder.buildFromUrl(requestedUrl);
    let cookies = credential ? await this.login(requestedUrl, siteConfig, credential) : [];
    const prefetched = prefetchedContent ?? (this.prefetchedContent === null ? null : this.takePrefetchedContent());
    let fetched = prefetched === null
      ? await this.fetcher.fetch(requestedUrl, siteConfig.http_header, { cookies })
      : {
          body: prefetched,
          url: requestedUrl.toString(),
          status: 200,
          headers: { "content-type": "text/html" },
          mimeType: "text/html",
        };
    cookies = fetched.setCookies ?? cookies;
    let effectiveUrl = normalizeUrl(fetched.url);

    if (
      prefetched === null &&
      credential &&
      siteConfig.requires_login &&
      this.extractor.hasXPathMatch(fetched.body, effectiveUrl, siteConfig.not_logged_in_xpath)
    ) {
      cookies = await this.login(effectiveUrl, siteConfig, credential);
      fetched = await this.fetcher.fetch(effectiveUrl, siteConfig.http_header, { cookies });
      cookies = fetched.setCookies ?? cookies;
      effectiveUrl = normalizeUrl(fetched.url);
    }

    const mimeAction = this.mimeAction(fetched.mimeType);
    if (mimeAction?.action === "exclude") {
      this.logger.warn("graby.fetch.mime.excluded", { host: effectiveUrl.hostname, mimeType: fetched.mimeType, status: fetched.status });
      throw new Error(`The URL "${effectiveUrl.toString()}" is blocked by its MIME action.`);
    }
    if (mimeAction && fetched.mimeType?.startsWith("image/")) {
      this.logger.info("graby.fetch.mime", { host: effectiveUrl.hostname, mimeType: fetched.mimeType, status: fetched.status });
      const escaped = escapeAttribute(effectiveUrl.toString());
      const name = escapeAttribute(mimeAction.name);
      return this.mimeContent(fetched, mimeAction.name, `<a href="${escaped}"><img src="${escaped}" alt="${name}" referrerpolicy="no-referrer"></a>`);
    }
    if (mimeAction && fetched.mimeType === "text/plain") {
      this.logger.info("graby.fetch.mime", { host: effectiveUrl.hostname, mimeType: fetched.mimeType, status: fetched.status });
      return this.mimeContent(fetched, mimeAction.name, `<pre>${escapeHtml(fetched.body)}</pre>`);
    }
    if (mimeAction && fetched.mimeType === "application/pdf") {
      const escaped = escapeAttribute(effectiveUrl.toString());
      if (fetched.bytes) {
        try {
          const pdf = await extractPdf(fetched.bytes);
          return {
            title: pdf.title ?? mimeAction.name,
            html: pdf.html || downloadLink(escaped, mimeAction.name),
            url: effectiveUrl.toString(),
            summary: pdf.summary,
            language: null,
            date: pdf.date,
            authors: pdf.authors,
            image: null,
            isNativeAd: false,
            nextPageUrl: null,
            status: fetched.status,
            headers: fetched.headers,
            mimeType: fetched.mimeType,
            isNotParsed: !pdf.html,
          };
        } catch {
          this.logger.warn("graby.pdf.extract.failed", { host: effectiveUrl.hostname, status: fetched.status });
          // Invalid or encrypted PDFs remain available through the safe source link.
        }
      }
      return this.mimeContent(fetched, mimeAction.name, downloadLink(escaped, mimeAction.name));
    }
    if (mimeAction) {
      this.logger.info("graby.fetch.mime", { host: effectiveUrl.hostname, mimeType: fetched.mimeType, status: fetched.status });
      const escaped = escapeAttribute(effectiveUrl.toString());
      return this.mimeContent(fetched, mimeAction.name, downloadLink(escaped, mimeAction.name));
    }
    if (fetched.mimeType && !fetched.mimeType.includes("html") && !fetched.mimeType.includes("xml")) {
      this.logger.info("graby.fetch.mime", { host: effectiveUrl.hostname, mimeType: fetched.mimeType, status: fetched.status });
      const escaped = escapeAttribute(effectiveUrl.toString());
      return this.mimeContent(fetched, "Download", `<a href="${escaped}">Download file</a>`);
    }

    if (siteConfig.autodetectOnFailure()) {
      const fingerprintHost = this.extractor.findHostUsingFingerprints(fetched.body, this.options.fingerprints);
      if (fingerprintHost) siteConfig = mergeSiteConfig(siteConfig, this.configBuilder.buildForHost(fingerprintHost));
    }

    let extracted = this.extractor.process(fetched.body, effectiveUrl, siteConfig, this.extractorOptions());
    if (this.options.singlePage && extracted.singlePageUrl && normalizeUrl(extracted.singlePageUrl).toString() !== effectiveUrl.toString()) {
      const singleUrl = normalizeUrl(extracted.singlePageUrl);
      fetched = await this.fetcher.fetch(singleUrl, this.configBuilder.buildFromUrl(singleUrl).http_header, { cookies });
      effectiveUrl = normalizeUrl(fetched.url);
      extracted = this.extractor.process(
        fetched.body,
        effectiveUrl,
        this.configBuilder.buildFromUrl(effectiveUrl),
        this.extractorOptions(),
      );
    }
    if (this.options.multiPage && extracted.nextPageUrl) {
      extracted = await this.fetchRemainingPages(extracted, fetched.url, cookies);
    }
    const content = {
      title: extracted.title ?? this.options.errorMessageTitle,
      html: extracted.isSuccess ? extracted.html : this.options.errorMessage,
      url: effectiveUrl.toString(),
      summary: extracted.summary,
      language: extracted.language,
      date: extracted.date,
      authors: extracted.authors,
      image: extracted.image,
      isNativeAd: extracted.isNativeAd,
      nextPageUrl: extracted.nextPageUrl,
      status: fetched.status,
      headers: fetched.headers,
      mimeType: fetched.mimeType,
      isNotParsed: !extracted.isSuccess,
    };
    this.logger.info("graby.fetch.complete", { host: effectiveUrl.hostname, status: fetched.status, mimeType: fetched.mimeType, parsed: extracted.isSuccess });
    return content;
  }

  cleanupHtml(content: string, input: string | URL): string {
    return this.extractor.cleanupHtml(content, normalizeUrl(input), this.extractorOptions());
  }

  private takePrefetchedContent(): string {
    const content = this.prefetchedContent ?? "";
    this.prefetchedContent = null;
    return content;
  }

  private extractorOptions(): ExtractorOptions {
    return {
      contentLinks: this.options.contentLinks,
      rewriteRelativeUrls: this.options.rewriteRelativeUrls,
      imgNoReferrer: this.imgNoReferrer,
    };
  }

  private mimeAction(mimeType: string | null): ContentTypeAction | null {
    if (!mimeType) return null;
    const normalized = mimeType.toLowerCase();
    const type = normalized.split("/", 1)[0];
    return this.options.contentTypeActions[normalized] ?? this.options.contentTypeActions[type] ?? null;
  }

  private async fetchRemainingPages(first: ExtractedContent, firstUrl: string, cookies: string[]): Promise<ExtractedContent> {
    const visited = new Set([normalizeUrl(firstUrl).toString()]);
    const pages = [first.html];
    let next = first.nextPageUrl;
    let count = 1;

    while (next && count < this.options.maxPages) {
      const pageUrl = normalizeUrl(next);
      if (visited.has(pageUrl.toString())) break;
      visited.add(pageUrl.toString());
      const config = this.configBuilder.buildFromUrl(pageUrl);
      const fetched: FetchResult = await this.fetcher.fetch(pageUrl, config.http_header, { cookies });
      const effective = normalizeUrl(fetched.url);
      if (visited.has(effective.toString()) && effective.toString() !== pageUrl.toString()) break;
      visited.add(effective.toString());
      const extracted = this.extractor.process(fetched.body, effective, config, this.extractorOptions());
      if (!extracted.isSuccess) break;
      pages.push(extracted.html);
      next = extracted.nextPageUrl;
      count += 1;
    }

    return {
      ...first,
      html: pages.join('<hr class="wallaby-page-break">'),
      nextPageUrl: next,
      summary: first.summary,
      isSuccess: pages.some(Boolean),
    };
  }

  private async login(url: URL, config: ReturnType<ConfigBuilder["buildFromUrl"]>, credential: SiteCredential): Promise<string[]> {
    if (
      !config.requires_login ||
      !config.login_uri ||
      !config.login_username_field ||
      !config.login_password_field
    ) return [];

    this.logger.debug("graby.login.start", { host: url.hostname, extraFieldCount: config.login_extra_fields.length });

    const body = new URLSearchParams({
      [config.login_username_field]: credential.username,
      [config.login_password_field]: credential.password,
    });
    for (const extra of config.login_extra_fields) {
      const separator = extra.indexOf("=");
      if (separator <= 0) continue;
      const name = extra.slice(0, separator).trim();
      let value = extra.slice(separator + 1);
      value = value.replaceAll("{username}", credential.username).replaceAll("{password}", credential.password);
      if (value.startsWith("@=")) {
        value = await evaluateLoginExpression(value.slice(2), {
          loginUri: config.login_uri,
          requestHtml: async (input) => {
            const target = normalizeUrl(new URL(input, url));
            const fetched = await this.fetcher.fetch(target, this.configBuilder.buildFromUrl(target).http_header);
            return fetched.body;
          },
        });
      }
      body.set(name, value);
    }
    const response = await this.fetcher.fetch(
      normalizeUrl(new URL(config.login_uri, url)),
      { ...config.http_header, "content-type": "application/x-www-form-urlencoded" },
      { method: "POST", body: body.toString() },
    );
    this.logger.info("graby.login.complete", { host: url.hostname, status: response.status, cookieCount: response.setCookies?.length ?? 0 });
    return response.setCookies ?? [];
  }

  private mimeContent(
    fetched: { url: string; status: number; headers: Record<string, string>; mimeType: string | null },
    title: string,
    html: string,
  ): Content {
    return {
      title,
      html,
      url: fetched.url,
      summary: "",
      language: null,
      date: null,
      authors: [],
      image: fetched.mimeType?.startsWith("image/") ? fetched.url : null,
      isNativeAd: false,
      nextPageUrl: null,
      status: fetched.status,
      headers: fetched.headers,
      mimeType: fetched.mimeType,
      isNotParsed: false,
    };
  }
}

const noOpLogger: GrabyLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]!);
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function downloadLink(escapedUrl: string, name: string): string {
  return `<a href="${escapedUrl}">Download ${escapeHtml(name)}</a>`;
}

function normalizeContentTypeActions(overrides?: Record<string, ContentTypeAction>): Record<string, ContentTypeAction> {
  const normalized = { ...defaultContentTypeActions };
  for (const [mimeType, action] of Object.entries(overrides ?? {})) {
    const key = mimeType.trim().toLowerCase();
    if (key) normalized[key] = action;
  }
  return normalized;
}
