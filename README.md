# Wallaby

Wallaby is a modern, self-hosted read-it-later application built with Next.js, Auth.js (NextAuth), and Prisma. Its product model and compatibility API follow wallabag, while `@wallaby/graby` provides a native TypeScript article-extraction engine modeled on Graby's public contracts.

The repository is intentionally evidence-driven about parity. The implemented workflow and compatibility matrix, including deliberate opaque-ID semantics, is tracked in [the wallabag parity map](docs/WALLABAG_PARITY.md).

## What works

- Credentials authentication through Auth.js, with Prisma-backed users and adapter tables
- Authenticator-app or SMTP email two-factor authentication, single-use recovery codes, and revocable 15-day trusted devices
- Save a URL, securely fetch it, extract a readable copy, and deduplicate per user
- Unread, archive, starred, all, annotated, tag, and full-text-like library views
- Responsive article reader, tags, notes, archive/star/refetch/delete actions, and public share links
- Per-user reading preferences, private Atom feed tokens, and hashed bearer API tokens
- Profile, password, scoped data-reset, cross-browser session revocation, and account-deletion workflows
- Administrator user/role/password management and instance-wide redirect-origin policy
- Automatic tagging rules with the wallabag operator matrix, apply-all, JSON portability, and settings/API management
- Durable portable imports for wallabag JSON, Pocket OAuth/CSV/HTML, Instapaper, bookmarks, Pinboard, and Omnivore plus JSON/CSV/XML/Markdown/text, EPUB 3, and multilingual PDF exports
- A wallabag-shaped JSON API for entries, search, tags, annotations, configuration, and instance information
- A standalone TypeScript Graby implementation with 2,037 CC0 site configs, XPath rules, metadata, Readability, multipage handling, sanitization, and SSRF-aware fetching

## Local setup

Requirements: Node.js 20.9 or newer and npm 10 or newer.

```bash
cp .env.example .env
npm install
npm run db:setup
npm run dev
```

Open `http://localhost:3000` and use the seeded local account:

- username: `demo` (administrator on a fresh seed)
- password: `wallaby-demo`

Replace `AUTH_SECRET` and `SITE_CREDENTIALS_KEY` before using Wallaby outside local development. The latter must decode to exactly 32 random bytes and protects publication usernames/passwords with AES-256-GCM. Authenticator-app 2FA encrypts TOTP secrets with `TWO_FACTOR_KEY` when provided, or a domain-separated key derived from a strong `AUTH_SECRET`; email-code 2FA additionally requires the `TWO_FACTOR_SMTP_*` and `TWO_FACTOR_EMAIL_FROM` settings documented in `.env.example`. SQLite is the zero-configuration default; the Prisma schema is deliberately portable so a PostgreSQL deployment can become a supported profile.

## Verification

```bash
npm run verify
npm audit --audit-level=moderate
```

Apply every saved tagging rule to an existing user's library from the command line with:

```bash
npm run tag:all -- demo
```

Imports are stored before article processing begins. In production, run one or more worker processes beside the web application:

```bash
npm run import:worker
```

`npm run import:worker:once` claims at most one available job, which is useful for schedulers. Stale claims are recovered after five minutes and every job/item has a bounded retry budget. Pocket OAuth tokens use `POCKET_TOKEN_KEY` when set, or a domain-separated key derived from a strong `AUTH_SECRET`, and are removed after remote pagination finishes.

The operator command surface uses the same persistence and extraction boundaries as the web application:

```bash
npm run import:file -- demo ./wallabag.json --importer=v2
npm run import:url -- demo https://example.com/story --tags=research,web
npm run export:library -- demo ./demo-export.json
npm run entries:reload -- demo --only-not-parsed --yes
npm run entries:dedupe -- demo
npm run tag:all -- demo
npm run images:cleanup -- --dry-run
npm run oauth:create-client -- demo --redirect-uri=https://reader.example/oauth/callback --format=env
```

File imports accept wallabag's importer names and `--markAsRead`, `--useUserId`, and `--disableContentUpdate` spellings as well as kebab-case equivalents. Add `--queue-only` when a separate worker should claim the new job. Exports refuse to overwrite a file unless `--force` is supplied. Duplicate cleanup retains the oldest entry while merging status, tags, and annotations and removing the duplicate's local media.

OAuth2 applications can also be created and revoked under **Settings → API access → Manage developer clients**. Wallaby exposes `/oauth/v2/auth` and `/oauth/v2/token` with authorization-code (including S256 PKCE), rotating refresh-token, password, and legacy implicit grants. Access tokens expire after one hour; refresh tokens expire after 30 days and rotate on every use. Password grants are rejected for accounts with two-factor authentication. Client secrets, access tokens, refresh tokens, and authorization codes are stored only as SHA-256 hashes.

The Graby port has focused tests under `packages/graby/tests`, and `npm run test:site-configs` reconciles the complete site-config corpus. The deeper compatibility work still needed against upstream fixtures is recorded in [the Graby implementation map](docs/GRABY_TYPESCRIPT.md).

Downloaded article images are opt-in under Administration. Set `WALLABY_MEDIA_DIR` to a persistent writable volume before enabling the policy. Wallaby re-encodes supported raster images, applies instance byte/count/pixel quotas, and serves content-addressed immutable responses from `/media/:id`. Use `npm run images:cleanup -- --dry-run` to audit orphaned files, then omit `--dry-run` to reconcile the store.

## TypeScript Graby usage

```ts
import { Graby } from "@wallaby/graby";

const graby = new Graby({
  siteConfigs: {
    "example.com.txt": `
      title: //h1
      body: //article
      strip: //aside
    `,
  },
});

const article = await graby.fetchContent("https://example.com/story");
```

The main compatibility methods are `fetchContent`, `cleanupHtml`, `setContentAsPrefetched`, `toggleImgNoReferrer`, and `reloadConfigFiles`. `ContentExtractor`, `ConfigBuilder`, `SiteConfig`, and the fetch transport are also exported for independent use.

## API

Create a personal bearer token in **Settings → API access**, or register an OAuth2 client under **Developer clients**, then use an access token like this:

```bash
curl -H "Authorization: Bearer wby_..." http://localhost:3000/api/entries
```

Session-authenticated browser calls work too. JSON and XML aliases use wallabag names and envelopes (`is_archived`, `is_starred`, `reading_time`, `published_by`, `_embedded`, and `_links`), and structured errors include OAuth plus Hydra fields. IDs remain opaque strings because Wallaby uses collision-resistant Prisma IDs rather than wallabag's enumerable sequential integers; all API routes accept that representation consistently.

## Architecture

- `app/` — Next.js App Router pages, server actions, imports/exports, public feeds, and REST routes
- `auth.ts` — Auth.js configuration and credentials provider
- `prisma/schema.prisma` — users, entries, tags, annotations, preferences, credentials, rules, API tokens, and import jobs
- `lib/entries.ts` — the extraction-to-persistence boundary
- `packages/graby/` — framework-independent TypeScript extraction package
- `packages/graby-site-config/` — 2,037 versioned host extraction definitions from the CC0 upstream corpus
- `docs/` — evidence-based parity and extraction-contract maps

The adjacent `../wallabag` checkout is treated as the feature authority during development. The current map was derived from its 123 controller routes, entity model, import controllers, and Graby integration at commit `f9d890d53`; Graby behavior was inspected at commit `3f89075`.
