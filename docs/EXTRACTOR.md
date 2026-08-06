# Extraction engine map

`packages/extractor` (`@wallaby/extractor`) is Wallaby's own TypeScript article-extraction engine. Its public behavior was validated against the extraction contracts exercised by wallabag's `ContentProxy`; the reference implementations consulted during development were `j0k3r/graby` at `3f89075` (MIT) and wallabag's integration at `f9d890d53`. It is an independent implementation, not a port of that code.

The engine exposes these entry points:

- `Extractor.fetchContent(url)`
- `Extractor.cleanupHtml(html, url)`
- `Extractor.setContentAsPrefetched(html)`
- `Extractor.toggleImgNoReferrer(value)`
- `Extractor.reloadConfigFiles(sources)`
- `ContentExtractor`, `ConfigBuilder`, and `SiteConfig`

## Contract matrix

| Extraction behavior | Status | Engine implementation | Gap to full compatibility |
|---|---|---|---|
| Human-entered URL normalization and `feed:` handling | Supported | `normalizeUrl`; protocol-less URLs default to `https://` (deliberate divergence from upstream `http://` for a modern self-hosted deployment) | Add IDN fixture matrix and PHP edge-case comparison |
| SSRF-aware URL fetching | Supported | DNS resolution blocks private/reserved ranges before each redirect; userinfo blocked | Pin resolved IP through connection to eliminate DNS rebinding window; proxy support |
| Redirect, timeout, response-size limits | Supported | Manual bounded redirects, abort timeout, streamed byte cap | Retry policy and HTTP cache |
| Bot-challenge fallback (search-bot profiles) | Supported (opt-in) | `botProfiles` rotates Googlebot/Bingbot then desktop/mobile browser profiles when a GET is met with a challenge status or a 200 interstitial (Cloudflare/Vercel/DataDome/PerimeterX/Akamai); `looksLikeBotChallenge` guards against flagging real articles | Per-host winning-profile memory; `Retry-After`/429 backoff |
| Real-browser rendering | Supported (opt-in) | `browserRender` renders JS-heavy or still-challenged GETs in headless Chromium via the optional `playwright` peer dependency (lazy-loaded); every navigation and subresource is SSRF-revalidated and heavy resources are blocked | Reader-proxy / archival fallbacks; per-host render caching |
| Custom headers and user agent | Supported | Site-config headers merged into request; upstream default UA/referer, per-host `user_agents`, and `rewrite_url` map | Cookie jar and referer policy per site |
| Character decoding | Supported | HTTP charset precedence, BOM detection, XML declaration and HTML meta sniffing (`http-equiv` first), `none`/`iso-8850-1` fixups, Windows-1252/UTF family decoding | Port the malformed-encoding and replacement-character fixtures |
| Meta-refresh / Refresh header following | Supported | Follows `Refresh` header and `<meta http-equiv=refresh>` (both attribute orders), bounded by `maxRedirects` | Port `_escaped_fragment_` AJAX-crawl fixtures |
| Tracker stripping | Supported | Removes `utm_*`/`mtm_*` query params and `xtor=RSS` fragment from the effective URL | — |
| Allowed/blocked URL policy | Supported | `allowedUrls` allowlist and `blockedUrls` denylist checked before fetch | — |
| Exact host config | Supported | `ConfigBuilder` | Load config directories/packages from disk |
| One-level wildcard config | Supported | `.example.com` lookup | Mirror every invalid-host/cache nuance |
| Global config merge | Supported | Arrays, scalar fallback, headers, replacements | Full `if_page_contains` merge behavior for next-page rules |
| Site-config parser | Supported | Repeated XPath, booleans, strings, header, replacement, conditional directives, and `wrap_in(blockquote\|p\|div)` matching upstream tags | Differential output fixtures for the smaller set of directives upstream graby intentionally ignores |
| Site-config corpus | Supported | 2,037 unmodified CC0 configs from `j0k3r/graby-site-config` at `017c2ed`, loaded once per server process | Add an automated upstream refresh and semantic-diff workflow |
| Fingerprint-based configs | Supported | Default Blogger (both orders), WordPress, Medium (`data-rh`), Substack, and ippen.media fingerprints plus configurable regex-to-host map | Port the complete upstream fingerprint fixture matrix |
| OpenGraph metadata | Supported | Title, non-`data:` image (og:image → url → secure_url), locale, published-over-modified date | Fixture parity for duplicate/invalid properties |
| JSON-LD metadata | Supported | Graph flattening, headline/name, authors, dates, images, article body; ignores `Organization\|WebSite\|Person\|VideoGame` and their names as title candidates | Match upstream graby's title conflict behavior on every fixture |
| Site XPath title/body/author/date | Supported | JSDOM XPath evaluation with string/node handling; matched entity nodes removed from the DOM | Port upstream graby's full malformed-XPath and DOM mutation fixtures |
| hNews / Instapaper / Schema.org autodetection | Supported | `hentry` entry-title/entry-content/published/vcard-author, `instapaper_title`/`instapaper_body`, `itemprop=articleBody`, `rel=author`, `meta[name=author]`, `time[pubdate]` fallbacks | Port upstream microformat fixtures |
| Language detection | Supported | `html[lang]`/`DC.language` over `og:locale`, then `Content-Language` response header | — |
| Readability fallback | Supported | Mozilla Readability, used only for still-missing title/body | Compare scoring and pruning against `j0k3r/php-readability`; tune divergent fixtures |
| String replacement, strip, class/id strip, attribute strip, wrap | Supported | Pre- and post-extraction DOM transforms; quote-stripped class/id/image-src matching | Conditional transform ordering parity corpus |
| Lazy image promotion | Supported | Upstream default attribute set incl. `data-srcset`→`srcset`, plus WordPress `noscript` sibling restoration | Port complete source/srcset edge-case fixtures |
| Content cleanup | Supported | Empty `<a>`/`<p>` removal, single-child container unwrap, leading duplicate-title heading removal, self-closing iframe placeholder | Port `normalize()`/nested-unwrap fixtures |
| Relative URL rewriting | Supported | `href`, `src`, `poster`, and `srcset`; in-page `#anchor` links preserved | CSS URL rewriting and `<base>` corner cases |
| XSS cleanup | Supported | Allowlist sanitizer removes scripts, event handlers, styles, unsafe schemes; disable with `xssFilter: false` | Differential security corpus against htmLawed; policy review for embeds |
| No-referrer images | Supported | `referrerpolicy=no-referrer` | None known |
| Link preserve/footnotes/remove | Supported | Configurable cleanup modes with deduplicated footnotes (disabled for Wikipedia as upstream graby does) | Port upstream footnote DOM fixtures |
| Native-ad clue | Supported | XPath match | Behavioral fixture |
| Next-page and multipage extraction | Supported | Conditional XPath discovery, normalized fetch, loop/MIME/ceiling detection; interrupted walks discard partial pages and append the upstream "continues on subsequent pages" notice | Port remaining page-break failure fixtures |
| Single-page link | Supported | Conditional XPath fetch and re-extraction before multipage handling | Port upstream redirect/failure fixtures |
| Authenticated sites | Supported | Per-user AES-256-GCM credentials, config-driven form POST, cookie redirects, `not_logged_in_xpath` retry, and sandboxed `request_html`, `xpath`, `preg_match`, and `config.getLoginUri` dynamic fields | Live smoke tests remain deployment/provider-specific and require real credentials |
| HTML and XHTML MIME | Supported | Metadata and readable extraction | Feed/oEmbed discovery behavior |
| Images | Supported | Safe linked image document | Dimensions/type metadata |
| Plain text | Supported | Escaped `<pre>` output | Charset fixtures |
| PDF | Supported | Bounded byte-preserving fetch, text/title/author/creation-date extraction through PDF.js, escaped readable output, and safe-link fallback for invalid, encrypted, or image-only files | — |
| Other MIME actions | Supported | Full-MIME-first and top-level-type fallback matrix, configurable link labels, safe generic download fallback, and explicit exclusion errors | — |
| Summary/excerpt | Supported | Clean, bounded excerpt | Entity-aware truncation parity |
| Logging | Supported | Injectable debug/info/warn/error interface; host/status/MIME/auth lifecycle events; no-op default; tests prove credentials and cookies are never emitted | — |

## Security boundaries

The fetcher does not trust a URL merely because parsing succeeds. It accepts only HTTP(S), rejects URL credentials and local hostnames, resolves every redirect target, and rejects non-public IP ranges. Responses are streamed into a fixed byte budget. Extracted HTML passes through a narrow allowlist before it is persisted or rendered.

Site credentials are stored only as versioned AES-256-GCM payloads with a fresh nonce per value. The deployment key is validated as a base64-encoded 32-byte value and never stored in Prisma. Rotating it requires re-entering saved credentials; corrupted or incorrectly keyed ciphertext fails authentication rather than returning partial plaintext.

## Verification currently present

The test suite covers:

- repeated, boolean, header, replacement, conditional, and wrapper site-config directives;
- exact host, wildcard host, and global fallback precedence;
- XPath-selected content and title;
- OpenGraph and JSON-LD metadata;
- Readability fallback;
- lazy image promotion, URL absolutization, no-referrer images, and script removal;
- injected transport and prefetched-content paths.
- fingerprint config selection plus bounded single-page and multipage retrieval.
- static and dynamic authenticated form fields, XPath/regex token discovery, login cookies, and protected article retrieval through an injected transport.
- the default ZIP/audio/video actions, full-MIME precedence, custom labels, escaped link output, and configured MIME exclusions.
- reconciliation of all 2,037 configs: 905 title rules, 1,994 body rules, 8,815 strip rules, and 49 authenticated-site definitions.

Full equivalence with the upstream reference implementations requires porting their fixtures and running a differential corpus that compares semantic fields and sanitized DOM output. Until those contract rows and fixtures are complete, the engine is production-useful but does not claim byte-for-byte output equivalence with any other engine.
