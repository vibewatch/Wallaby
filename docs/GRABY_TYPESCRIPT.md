# Graby TypeScript implementation map

`packages/graby` is a clean TypeScript implementation of the public behavior used by wallabag's `ContentProxy`. The comparison authority was `j0k3r/graby` at `3f89075` and wallabag's integration at `f9d890d53`.

The package intentionally exposes familiar entry points:

- `Graby.fetchContent(url)`
- `Graby.cleanupHtml(html, url)`
- `Graby.setContentAsPrefetched(html)`
- `Graby.toggleImgNoReferrer(value)`
- `Graby.reloadConfigFiles(sources)`
- `ContentExtractor`, `ConfigBuilder`, and `SiteConfig`

## Contract matrix

| Graby behavior | Status | TypeScript implementation | Gap to full compatibility |
|---|---|---|---|
| Human-entered URL normalization and `feed:` handling | Supported | `normalizeUrl` | Add IDN fixture matrix and PHP edge-case comparison |
| SSRF-aware URL fetching | Supported | DNS resolution blocks private/reserved ranges before each redirect; userinfo blocked | Pin resolved IP through connection to eliminate DNS rebinding window; proxy support |
| Redirect, timeout, response-size limits | Supported | Manual bounded redirects, abort timeout, streamed byte cap | Retry policy and HTTP cache |
| Custom headers and user agent | Supported | Site-config headers merged into request | Cookie jar and referer policy per site |
| Character decoding | Supported | HTTP charset precedence, BOM detection, XML declaration and HTML meta sniffing, Windows-1252/UTF family decoding | Port the malformed-encoding and replacement-character fixtures |
| Exact host config | Supported | `ConfigBuilder` | Load config directories/packages from disk |
| One-level wildcard config | Supported | `.example.com` lookup | Mirror every invalid-host/cache nuance |
| Global config merge | Supported | Arrays, scalar fallback, headers, replacements | Full `if_page_contains` merge behavior for next-page rules |
| Site-config parser | Supported | Repeated XPath, booleans, strings, header, replacement, wrap, conditional directives | Differential output fixtures for the smaller set of directives Graby intentionally ignores |
| Site-config corpus | Supported | 2,037 unmodified CC0 configs from `j0k3r/graby-site-config` at `017c2ed`, loaded once per server process | Add an automated upstream refresh and semantic-diff workflow |
| Fingerprint-based configs | Supported | Default Blogger, WordPress, Medium, and Substack fingerprints plus configurable regex-to-host map | Port the complete upstream fingerprint fixture matrix |
| OpenGraph metadata | Supported | Title, image, locale, published/modified date | Fixture parity for duplicate/invalid properties |
| JSON-LD metadata | Supported | Graph flattening, headline/name, authors, dates, images, article body | Match Graby's ignored type list and title conflict behavior exactly |
| Site XPath title/body/author/date | Supported | JSDOM XPath evaluation with string/node handling | Port Graby's full malformed-XPath and DOM mutation fixtures |
| Readability fallback | Supported | Mozilla Readability | Compare scoring and pruning against `j0k3r/php-readability`; tune divergent fixtures |
| String replacement, strip, class/id strip, attribute strip, wrap | Supported | Pre- and post-extraction DOM transforms | Conditional transform ordering parity corpus |
| Lazy image promotion | Supported | Configured and common lazy attributes | Port complete source/srcset edge-case fixtures |
| Relative URL rewriting | Supported | `href`, `src`, `poster`, and `srcset` | CSS URL rewriting and `<base>` corner cases |
| XSS cleanup | Supported | Allowlist sanitizer removes scripts, event handlers, styles, unsafe schemes | Differential security corpus against htmLawed; policy review for embeds |
| No-referrer images | Supported | `referrerpolicy=no-referrer` | None known |
| Link preserve/footnotes/remove | Supported | Configurable cleanup modes with deduplicated footnotes (disabled for Wikipedia like Graby) | Port upstream footnote DOM fixtures |
| Native-ad clue | Supported | XPath match | Behavioral fixture |
| Next-page and multipage extraction | Supported | Conditional XPath discovery, normalized fetch, loop detection, bounded concatenation | Preserve upstream page-break wording and port failure fixtures |
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

Full equivalence requires porting the upstream Graby fixtures and running a differential corpus that compares semantic fields and sanitized DOM output. Until those contract rows and fixtures are complete, this package is production-useful but is not claimed to be a byte-for-byte Graby replacement.
