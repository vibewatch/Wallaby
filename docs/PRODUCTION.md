# Production operations

Wallaby's supported production profile is one Next.js web process, one durable import worker, SQLite on a persistent local volume, and a TLS-terminating reverse proxy. The web and worker must share the database and media volume. Do not place multiple web replicas over the SQLite file; a future PostgreSQL profile is required before horizontal web scaling is supported.

For the EduLoop-style Azure VM and GitHub Actions setup, see [Webstack deployment](VM_DEPLOYMENT.md), including the SQLite-specific rollout and off-VM backup requirements.

## Release gate

Run the complete gate from a clean checkout:

```bash
npm ci
npx playwright install --with-deps chromium
DATABASE_URL=file:/tmp/wallaby-release-check.db npm run release
```

The release gate requires a running Docker Engine. It runs lint, TypeScript, the complete unit/integration suite, the complete 2,037-site extraction corpus, a production build, isolated desktop/mobile Playwright workflows, the production dependency audit, Prisma schema validation, and a production-container acceptance test. The container test builds a production-dependency-only image, migrates a fresh volume, proves liveness/readiness and security headers as the non-root runtime user, checks Docker health and graceful shutdown, starts the durable worker once, and then removes its uniquely named test resources. Playwright likewise creates a migrated database and media directory under `.tmp/e2e` and removes both after the run; neither gate uses the operator's normal database. The placeholder URL above satisfies schema validation, while browser tests supply their own database and test-only encryption keys without relying on a developer's `.env`.

The scoped `@prisma/config` override selects `deepmerge-ts` 8 to address GHSA-ggr8-5vv4-36mx without downgrading Prisma or mismatching its CLI and generated client. The application uses plain-record Prisma configuration, not the Map-merging behavior changed by that release. Reassess the override when upgrading Prisma.

## Required configuration

Production startup fails before migrations or traffic when `AUTH_SECRET` is missing, short, or still a placeholder; when `DATABASE_URL` targets `dev.db`; or when encryption, SMTP, feature-flag, or public-origin settings are malformed. Generate independent secrets rather than copying `.env.example` values:

```bash
openssl rand -base64 48
openssl rand -base64 32
```

Use the first value for `AUTH_SECRET`. Use separate 32-byte base64 values for `SITE_CREDENTIALS_KEY`, `TWO_FACTOR_KEY`, `POCKET_TOKEN_KEY`, and `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` when those boundaries are enabled. Keep keys stable across upgrades; losing an encryption key makes the corresponding stored credentials unusable.

Set `AUTH_URL` to the public HTTPS origin. `NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` must be identical for every process serving the same build, and `DEPLOYMENT_VERSION` should be a commit SHA or image digest during rolling deployments.

## TLS and reverse proxy

Expose Wallaby only through an HTTPS reverse proxy. Preserve the original `Host` and set `X-Forwarded-Proto: https`; do not accept client-supplied forwarding headers without replacing them at the proxy. The application emits HSTS, CSP, clickjacking, MIME-sniffing, referrer, permissions, and no-index headers. Restrict request body size and connection rates at the proxy as an additional outer boundary.

## Storage and backups

Mount `/app/storage` on durable storage. It contains the SQLite database and, when enabled, downloaded article media. Back up both as one consistency unit. The safest simple procedure is:

1. Stop the web and worker containers.
2. Copy the SQLite database, its `-wal`/`-shm` companions if present, and the media directory.
3. Restart both containers and verify `/api/health/ready`.
4. Regularly restore a backup into an isolated environment and run the health probe plus a sign-in/read/export smoke test.

Before upgrades, take a backup. The container entrypoint applies forward migrations before starting either process. Rollback therefore means restoring the previous image and its pre-upgrade database/media backup; code rollback alone is not a database rollback.

## Health and monitoring

- `GET /api/health/live` proves the HTTP process is alive without touching persistence.
- `GET /api/health/ready` proves SQLite is queryable and, when local image capture is enabled, that the media directory is readable and writable.
- Both endpoints are public, return no secrets, and are explicitly non-cacheable.

The Docker image includes a readiness-based health check. Unexpected server failures are written as single-line JSON with event name, route template, error type, digest, and timestamp; request headers, query strings, feed tokens, and article contents are deliberately excluded. Ship stdout/stderr to the deployment's log collector and alert on readiness failures, container restarts, `request.failed`, and sustained `auth.credentials_rejected` events. `request.aborted` is informational: the browser stopped reading a page it had requested, usually because the reader navigated on.

## Worker and external boundaries

Run the import worker continuously. The default Compose profile starts it only after the web container is healthy. Jobs and their initial items are published atomically, active claims renew every 30 seconds, and abandoned claims are recovered after five minutes. Unique claim tokens prevent stale workers from publishing results after recovery, and retries are bounded. For the SQLite profile, keep one worker process; its internal concurrency already processes three items at once.

Recovered imports finish image processing and automatic tagging before completing. Image downloads stay outside database transactions; only a current claim can publish their results. Abrupt process death can leave unreferenced media files, which the existing `images:cleanup` command reconciles.

The continuous worker also prunes expired credentials and old import payloads hourly, logging `maintenance.pruned` with per-table counts (or `maintenance.prune_failed`). Deployments that only run `import:worker:once` from a scheduler should schedule `npm run maintenance:prune` too.

A bulk **Fetch again** from the library runs in the web process after the response and logs `entries.refetch.completed` with `fetched`, `incomplete`, and `failed` counts. A restart abandons the rest of a batch harmlessly; for whole-library reloads, prefer `npm run entries:reload`.

With SMTP configured and `AUTH_URL` set, the sign-in page offers **Forgot your password?**. Reset emails are sent after the response so its timing does not reveal whether an account exists; a delivery failure is logged as `password_reset.delivery_failed` and the user sees the same confirmation, so alert on that event. Without SMTP, administrators reset passwords on the **Administration** page (`/entries/admin`).

SMTP delivery, Pocket authorization, authenticated publication login, and optional Chromium extraction depend on real external providers and must be smoke-tested with deployment-owned accounts. Browser extraction also requires `INSTALL_CHROMIUM=true` at image build time together with `WALLABY_BROWSER_RENDER=true` at runtime; ordinary HTTP extraction remains available when both are off.

## Operational checks

After every deployment:

1. Confirm `/api/health/live` and `/api/health/ready` return 200.
2. Sign in, save a known public article, open its reader, and remove the temporary entry.
3. Queue a one-entry import and confirm the worker completes it.
4. Export the library and verify the download opens.
5. Check structured logs for configuration warnings, request failures, or restart loops.
