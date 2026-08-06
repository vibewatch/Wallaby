export type HeadersRecord = Record<string, string>;

export interface Content {
  title: string;
  html: string;
  url: string;
  summary: string;
  language: string | null;
  date: string | null;
  authors: string[];
  image: string | null;
  isNativeAd: boolean;
  nextPageUrl: string | null;
  status: number;
  headers: HeadersRecord;
  mimeType: string | null;
  isNotParsed: boolean;
}

export interface ExtractedContent {
  title: string | null;
  html: string;
  summary: string;
  language: string | null;
  date: string | null;
  authors: string[];
  image: string | null;
  isNativeAd: boolean;
  nextPageUrl: string | null;
  singlePageUrl: string | null;
  isSuccess: boolean;
}

export interface FetchResult {
  body: string;
  bytes?: Uint8Array;
  url: string;
  status: number;
  headers: HeadersRecord;
  mimeType: string | null;
  setCookies?: string[];
}

export interface FetchRequestOptions {
  method?: "GET" | "POST";
  body?: string;
  cookies?: string[];
}

export interface Fetcher {
  fetch(url: URL, headers?: HeadersRecord, request?: FetchRequestOptions): Promise<FetchResult>;
}

export interface SiteCredential {
  username: string;
  password: string;
}

export interface ExtractorLogger {
  debug(message: string, context?: Record<string, unknown>): void;
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export interface ContentTypeAction {
  action: "link" | "exclude";
  name: string;
}

export interface ExtractorOptions {
  errorMessage?: string;
  errorMessageTitle?: string;
  contentLinks?: "preserve" | "footnotes" | "remove";
  rewriteRelativeUrls?: boolean;
  maxRedirects?: number;
  maxResponseBytes?: number;
  requestTimeoutMs?: number;
  userAgent?: string;
  defaultReferer?: string;
  userAgents?: Record<string, string>;
  rewriteUrl?: Record<string, Record<string, string>>;
  botProfiles?: boolean;
  browserRender?: boolean;
  allowedUrls?: string[];
  blockedUrls?: string[];
  xssFilter?: boolean;
  singlePage?: boolean;
  multiPage?: boolean;
  maxPages?: number;
  fingerprints?: Record<string, string>;
  contentTypeActions?: Record<string, ContentTypeAction>;
  siteConfigs?: Record<string, string>;
  fetcher?: Fetcher;
  logger?: ExtractorLogger;
}

export type MultiValueDirective =
  | "title"
  | "body"
  | "author"
  | "date"
  | "strip"
  | "strip_id_or_class"
  | "strip_image_src"
  | "native_ad_clue"
  | "test_url"
  | "single_page_link"
  | "next_page_link"
  | "find_string"
  | "replace_string"
  | "login_extra_fields"
  | "post_strip_attr";

export class SiteConfig {
  title: string[] = [];
  body: string[] = [];
  author: string[] = [];
  date: string[] = [];
  strip: string[] = [];
  src_lazy_load_attr: string | null = null;
  strip_id_or_class: string[] = [];
  strip_image_src: string[] = [];
  native_ad_clue: string[] = [];
  http_header: HeadersRecord = {};
  tidy: boolean | null = null;
  autodetect_on_failure: boolean | null = null;
  prune: boolean | null = null;
  test_url: string[] = [];
  if_page_contains: Record<string, Record<string, string>> = {};
  single_page_link: string[] = [];
  next_page_link: string[] = [];
  parser: string | null = null;
  find_string: string[] = [];
  replace_string: string[] = [];
  cache_key: string | null = null;
  requires_login = false;
  not_logged_in_xpath: string | null = null;
  login_uri: string | null = null;
  login_username_field: string | null = null;
  login_password_field: string | null = null;
  login_extra_fields: string[] = [];
  skip_json_ld = false;
  post_strip_attr: string[] = [];
  wrap_in: Record<string, string> = {};

  useTidy(): boolean {
    return this.tidy ?? true;
  }

  usePrune(): boolean {
    return this.prune ?? true;
  }

  autodetectOnFailure(): boolean {
    return this.autodetect_on_failure ?? true;
  }
}
