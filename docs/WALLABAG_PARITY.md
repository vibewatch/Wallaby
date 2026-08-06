# wallabag parity map

This is the implementation ledger for the clone, not a marketing checklist. It was derived from the adjacent wallabag checkout at `f9d890d53`: 123 Symfony controller routes across 38 controllers, the entity model, CLI commands, templates, and user/developer documentation.

Status meanings:

- **Supported** — the principal workflow is implemented and persisted.
- **Partial** — useful behavior exists, but a named upstream contract or interaction remains.
- **Planned** — schema or design may exist, but users cannot complete the workflow yet.

## User-facing product

| wallabag capability | Status | Current evidence | Remaining parity work |
|---|---|---|---|
| Sign in and session management | Supported | Auth.js credentials provider, Prisma adapter models, protected app routes, versioned cross-browser session invalidation, and two-phase 2FA grants | Registration, password reset, email verification, OAuth providers |
| Add an entry by URL | Supported | Save form and `POST /api/entries`; normalized per-user dedupe | Bookmarklet and browser-extension landing flow |
| Extract readable article content | Supported | `@wallaby/graby` feeds title/content/metadata into Prisma | Complete Graby matrix below; background retry queue |
| Imported/prefetched HTML | Supported | API accepts `content`; Graby prefetched path cleans it | Import UI and importer-specific normalization |
| Unread, archive, starred, all lists | Supported | Persisted views, counts, pagination, responsive cards | wallabag's list/grid mode switch and bulk selection |
| Untagged, annotated, same-domain, random views | Supported | Persisted filtered lists, sidebar/card/reader navigation, and origin-preserving random-entry redirects with browser coverage | — |
| Archive, star, delete, reload | Supported | Reader/card server actions and entry API | Undo notification and configurable post-action redirect |
| Edit entry title | Supported | Reader inline editor and API patch with ownership checks and browser coverage | — |
| Tags: add, remove, list, filter | Supported | Reader controls, sidebar/list filters, rename/merge/delete settings UI, nested entry-tag and bulk APIs, browser coverage | — |
| Search and filters | Supported | Title/content/domain/tag search; reading-time and saved/published date ranges; domain, language, HTTP, extraction, preview, note, sharing, and status filters; pagination preserves the full query; API all-tag/detail/filter semantics have browser coverage | — |
| Annotations | Supported | Notes and DOM-range text selection; persisted selectors with quote fallback after content changes; rendered/deletable highlights; GET/POST/PUT/DELETE API; reload browser coverage | — |
| Public entry sharing | Supported | Revocable random share token and public sanitized reader | Optional external services configured by wallabag |
| Private feeds | Supported | Revocable all/unread/archive/starred and tag feeds; configurable pagination limit; Atom navigation links; RSS variant; browser coverage | — |
| Reader preferences | Supported | Page size, language, reading speed, typography and width are applied; resource-safe custom article declarations; compact-list and thumbnail switches; API and computed-style browser coverage | — |
| Site credentials/paywall login | Supported | AES-256-GCM credential CRUD, exact/wildcard lookup, config-driven login POST, redirect cookie jar, login-page XPath retry, and sandboxed `@=` request/XPath/regex dynamic fields; deterministic provider-flow coverage | — |
| Auto-tagging rules | Supported | All wallabag-allowed fields/operators; automatic application on saves and imports; settings create/edit/delete/reset and apply-all; validated JSON import/export; authenticated API CRUD; `npm run tag:all`; unit and browser coverage | — |
| Ignore-origin rules | Supported | Seeded instance and personal safe `host`/`_all` rules; new saves and reloads preserve or ignore redirect origins with wallabag's URL-difference semantics; user and administrator create/edit/delete workflows have unit and browser coverage | — |
| Download article images | Supported | Admin-controlled opt-in capture rewrites `src`, `srcset`, poster, and preview URLs to public immutable local assets; SSRF-aware fetches, raster re-encoding, byte/pixel/count/user quotas, cascading deletion, and `npm run images:cleanup -- --dry-run` are covered | Persistent deployments must mount `WALLABY_MEDIA_DIR`; SVG is intentionally left remote rather than served as active content |
| Two-factor authentication | Supported | Password-confirmed TOTP QR enrollment, encrypted app secrets, RFC 6238 verification, SMTP email-code setup/sign-in, bounded short-lived challenges, one-time hashed sign-in grants, bcrypt-hashed single-use recovery codes, 15-day hashed trusted devices, replacement/revocation/disable UX, direct Auth.js callback bypass coverage, and full browser lifecycle evidence | Email delivery requires instance SMTP configuration; SMS is intentionally unsupported because upstream offers app or email codes |
| Account/profile management | Supported | Name/username/email updates with uniqueness checks; current-password-authorized password changes invalidate versioned JWT sessions across browsers; annotation/tag/archive/entry/tag-rule reset scopes; cascading account deletion; complete temporary-account browser lifecycle coverage | — |
| Multi-user administration | Supported | Admin-only user list/create/edit/delete, role controls, password reset with cross-browser session revocation, per-user counts, final-admin/self-deletion guards, and instance ignore-origin policy; browser coverage includes live role elevation and access denial | — |
| Quick start/about/help | Supported | Responsive in-product quick start, feature guidance, privacy/extraction boundaries, role-aware administration link, and direct workflow navigation | — |

## Imports and exports

The upstream checkout has dedicated import controllers for Browser, Chrome, Delicious, Elcurator, Firefox, HTML, Instapaper, Omnivore, Pinboard, Pocket API, Pocket CSV, Pocket HTML, Readability, Shaarli, wallabag v1, and wallabag v2.

| Capability | Status | Remaining parity work |
|---|---|---|
| Import job persistence | Supported | File and remote imports enqueue durable per-item records; guarded claims, stale-lock recovery, bounded exponential retries, concurrency-three processing, deterministic annotation replay, duplicate accounting, progress UI, manual authenticated processing, and `npm run import:worker` survive process restarts |
| Browser/Chrome/Firefox bookmarks | Supported | Netscape bookmark HTML parser preserves URL, title, tags, and timestamp |
| Pocket (API, CSV, HTML) | Supported | Quoted CSV and anchor HTML imports plus retrieve-only Pocket OAuth, encrypted short-lived request/access tokens, bounded paginated API hydration, read/star/tag/date/image normalization, and durable background processing | — |
| Instapaper/Readability/Pinboard/Delicious/Shaarli | Supported | Dedicated CSV, JSON, and Shaarli bookmark-HTML normalizers preserve URLs, titles, tags, state, and timestamps; upstream-shaped Readability and Shaarli fixtures cover their distinct contracts | — |
| wallabag v1/v2 and generic JSON | Supported | URL/content/title, tags, status, timestamps, authors, origin metadata, annotations, and selectors round trip with browser coverage | — |
| Omnivore/Elcurator | Supported | Both JSON shapes normalize URL, title, tags, state, and timestamps; Elcurator's `is_saved` contract and auto-detection have a dedicated fixture | — |
| Export single entry | Supported | JSON, XML, TXT, CSV, Markdown, EPUB 3, and multilingual PDF support authenticated `id` downloads; EPUB/PDF archives and route headers have unit and browser coverage | — |
| Export categories/search/tag results | Supported | Every text, EPUB, and PDF endpoint shares the visible library's view, search, tag, reading-time, date, domain, language, HTTP, extraction, preview, annotation, and sharing predicate; the result page exposes an export link and browser coverage verifies the exact filtered IDs | — |
| CLI import/export/reload/tag/cleanup | Supported | TypeScript commands cover durable multi-format file import, single-URL import, JSON library export, all-user or scoped reload with not-parsed filtering and explicit confirmation, tagging-rule application, downloaded-image reconciliation, duplicate merging, and one-shot/continuous import workers |

## API and developer surface

| Upstream API contract | Status | Wallaby route / note |
|---|---|---|
| Entry exists | Supported | `GET /api/entries/exists?url=` |
| List/create entries | Supported | `GET/POST /api/entries` with wallabag-style fields and pagination envelope |
| Get/update/delete/reload entry | Supported | `GET/PATCH/DELETE /api/entries/:id`; patch accepts `reload` |
| Entry tags | Supported | Tags included and replaceable through entry patch; wallabag-compatible nested list/add/remove routes, including `.json` aliases | — |
| Bulk entry and bulk tag operations | Supported | Ownership-checked list selection UI; ID-based `/api/entries/bulk`; wallabag URL-list delete and tag add/remove endpoints; browser coverage | — |
| Search | Supported | `GET /api/search?term=`; filter breadth remains partial |
| List/delete tags | Supported | `GET/DELETE /api/tags` |
| Annotation CRUD | Supported | `/api/annotations/:id`, method-dispatched like upstream |
| User configuration | Supported | Authenticated `GET/PATCH /api/config` with wallabag field names and validation | — |
| Version and instance info | Supported | `/api/version`, `/api/info` |
| Tagging-rule export | Supported | Authenticated `GET /api/taggingrule/export.json` returns the wallabag `{ rule, tags }[]` download contract; settings import/export round trip has browser coverage | — |
| OAuth2 client/access/refresh tokens | Supported | `/oauth/v2/auth` and `/oauth/v2/token` implement authenticated consent, authorization-code with optional S256 PKCE, legacy implicit, password, and rotating refresh grants; one-hour access and 30-day refresh credentials are hashed, scoped, expiring, single-use where applicable, and client deletion cascades revocation; 2FA accounts cannot use password grants |
| Developer client UI | Supported | Authenticated application creation lists exact redirects and selectable grants, reveals the random secret once, shows token counts, and deletes owned clients; `npm run oauth:create-client` supports text, env, and JSON provisioning output; browser coverage completes creation, consent, code exchange, API use, refresh rotation, replay rejection, and revocation |
| wallabag response compatibility | Supported | JSON and XML format routes, `.json`/`.xml` aliases, form or JSON mutations, wallabag pagination/search envelopes and query spellings, SHA-1 exists checks, metadata detail behavior, preserved filter links, public instance info, upstream-style tag counts, structured OAuth/Hydra errors, entry export/reload aliases, and contract browser fixtures; IDs are consistently opaque collision-resistant strings rather than unsafe sequential integers and every route/relationship accepts that representation |

## Data model coverage

Prisma currently models wallabag's central `User`, `Entry`, `Tag`, `Annotation`, `Config` (as `UserPreference`), `SiteCredential`, `TaggingRule`, ignore-origin rule, personal API tokens, OAuth clients/access/refresh/code grants, and durable import jobs/items. It also records extraction headers/status, both given and effective URL, published metadata, parse failure state, timestamps, share state, downloaded images, and short-lived or revocable 2FA setup/challenge/grant/trusted-device/recovery material.

The schema is broader than the UI on purpose, but a modeled table is never counted as a supported feature by itself.

## Completion rule

Clone parity is not complete while any row above is **Partial** or **Planned**, or while `docs/GRABY_TYPESCRIPT.md` has incomplete contract rows. Each promotion to **Supported** should add behavior-level tests, not only a route or schema field.
