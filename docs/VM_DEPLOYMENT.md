# GitHub Actions deployment to Webstack

Wallaby uses the same Azure VM, GHCR registry, GitHub OIDC authentication, and
Caddy HTTPS entry point as EduLoop. It runs at **https://wallaby.genisisiq.com**,
with a loopback-only upstream on port **10002**.

Like EduLoop, production uses the shared host's PostgreSQL 16 server, with a
dedicated `app_wallaby` database and restricted role. Wallaby also needs a
continuous import worker and persistent article media, so it owns an
app-specific rollout using the same Azure Run Command transport. It does not
change EduLoop's database or the global Caddy configuration. SQLite remains
available for local development, but production images are built for PostgreSQL.

## Runtime and storage

`docker-compose.vm.yml` starts exactly one web container and one worker, using
the same image digest, PostgreSQL database and `/data/apps/wallaby/storage` media
bind mount, connected to the existing `webstack-apps` network. Each container
runs as UID/GID 1001 with a 1 GiB memory ceiling, dropped capabilities, bounded
logs, and automatic restart. Only the web service publishes a port, and only on
`127.0.0.1`.

| Resource | Requirement |
| --- | --- |
| Azure VM | Existing Webstack host with Docker Compose 2.30+ and Caddy |
| DNS | `wallaby.genisisiq.com` must resolve to that VM |
| Local persistence | Mounted `/data`; media uses `storage/`, PostgreSQL uses the host's persistent database storage |
| Blob Storage | **Not required for runtime** |
| PostgreSQL | Existing PostgreSQL 16 server, dedicated Wallaby database/role |
| Redis | Not required |
| SMTP | Optional; enables email two-factor authentication and self-service password reset |
| Chromium | Disabled in this profile; ordinary HTTP extraction works without it |

The application does not need a new Azure Storage account to serve articles or
images. The VM's existing off-host backup storage can also hold Wallaby backups,
and its current `webstack-backup` job's `pg_dumpall` covers the new PostgreSQL
database. **It still does not protect Wallaby's media or encryption keys.**
Verify off-host backup delivery and restoration before treating it as disaster
recovery.

Rollouts take a consistent, root-only pre-upgrade archive under
`/data/backups/wallaby/` after stopping only Wallaby's two containers, plus a
custom-format PostgreSQL dump. A failed upgrade restores only Wallaby's database,
media, environment, Compose configuration, and image. Failed-upgrade storage is
retained for diagnosis rather than deleted.
These local archives are not disaster recovery: VM/disk loss can destroy both
the live data and local archives. Before relying on the service for irreplaceable
data, schedule consistent media/key backups alongside the PostgreSQL backup and test
restoration. Follow [the production backup procedure](PRODUCTION.md#storage-and-backups).
Old local archives are not automatically deleted.

## Existing SQLite cutover

The first PostgreSQL rollout snapshots the stopped SQLite database and media,
exports every application table plus article/tag relationships, applies native
PostgreSQL migrations, and transfers rows in one transaction. IDs, passwords,
encrypted credentials, tokens, dates, annotations, reading state and import
history are retained. Search metadata is rebuilt rather than copied. The
destination must be empty; transfer never merges or overwrites an existing
database. A failed rollout restores the pre-upgrade PostgreSQL state and old
SQLite image/environment, with the original file retained in the archive.

The dedicated role's connection URL is generated in root-only
`/data/apps/wallaby/postgres.env` and used in `app.env`. These files must be
backed up with application keys. An existing database without its managed
credential file blocks deployment instead of resetting its password.

## One-time GitHub and Azure configuration

Create a `production` GitHub environment restricted to `main`. Configure a
repository-specific Azure managed identity with GitHub federation for this
environment and the Webstack **VM deployment** custom role scoped to this VM.
The role needs only VM read, instance-view read, start, and Run Command actions;
do not grant subscription Contributor or access to another app's database.

GitHub uses immutable repository IDs in this repository's OIDC subject. Obtain
the actual prefix rather than constructing a lowercase `repo:owner/name` subject:

```bash
gh api repos/huangyingting/Wallaby/actions/oidc/customization/sub
```

The Azure federation subject is the returned `sub_claim_prefix` followed by
`:environment:production`, with issuer `https://token.actions.githubusercontent.com`
and audience `api://AzureADTokenExchange`.

Set these **production environment variables**:

| Variable | Purpose |
| --- | --- |
| `AZURE_CLIENT_ID` | Wallaby deployment managed identity client ID |
| `AZURE_TENANT_ID` | Azure tenant |
| `AZURE_SUBSCRIPTION_ID` | Webstack subscription |
| `AZURE_RESOURCE_GROUP` | Webstack resource group |
| `AZURE_VM_NAME` | Webstack VM |

Set repository variable `VM_DEPLOY_ENABLED=true` to enable automatic deployment.
Keep the identity and federation in Webstack's infrastructure inventory; when
adopting an identity initially created through Azure CLI into Terraform, import
it before applying the matching `github_repositories` entry.

No SSH private key, registry PAT, or storage-account key is required. Each run
uses a short-lived GitHub token to pull its private GHCR image and removes its
temporary Docker credentials.

## Application secrets and initial administrator

On first deployment, the VM generates independent random authentication and
encryption keys in root-only `/data/apps/wallaby/app.env`. Later deployments
preserve them. Back up this file with the database; losing the keys makes
encrypted credentials unreadable.

The optional `VM_APP_ENV` **production environment secret** accepts literal,
unquoted `KEY=value` lines for `AUTH_SECRET`, dedicated encryption keys,
`WALLABY_BOT_PROFILES`, and the `TWO_FACTOR_SMTP_*` / `TWO_FACTOR_EMAIL_FROM`
settings. Do not rotate existing keys inadvertently. Managed database, origin,
media, browser-rendering, and release-version settings cannot be overridden.
There is no need to copy EduLoop's application secrets.

Deployment creates the initial `admin` account with a random password. Its
one-time credentials are in root-only
`/data/apps/wallaby/bootstrap.env` on the VM, not in Actions logs or the running
web container's environment. Retrieve them through the existing administrator
access, sign in, change the password, and remove that bootstrap file. Repeated
bootstrap never resets an existing administrator or promotes another account.
**Production never runs `db:seed`, which creates the development demo account.**

For an operator-supplied initial account, the image also exposes
`npm run users:bootstrap` with `BOOTSTRAP_ADMIN_USERNAME` and
`BOOTSTRAP_ADMIN_PASSWORD`. Passwords must be at least 16 characters and at most
72 UTF-8 bytes. Supply them transiently, not as image build arguments.

## Workflow behavior

`.github/workflows/deploy-vm.yml` runs after a successful `release-gate` push on
`main`, or through manual dispatch:

```bash
gh workflow run deploy-vm.yml --ref main
```

Both paths require a successful release-gate run for the exact source commit.
The workflow builds a linux/amd64 PostgreSQL image, tags it with that commit, then deploys
the immutable digest. The commit is embedded as `DEPLOYMENT_VERSION` at build
time and supplied at runtime. A rollout lock prevents overlapping Wallaby
deployments; upgrades intentionally have brief downtime rather than overlapping
writers or allowing writes during database/media snapshots.

After configuration validation and image pull, the VM snapshots existing data,
starts the web and worker, bootstraps an administrator if needed, and validates
only Wallaby's Caddy site. Actions then checks public HTTPS readiness, liveness,
and the sign-in page. Azure Run Command's HTTP success alone is not accepted as
deployment success: the remote script must emit a matching completion marker.

If GitHub reports that a job never started because of billing or a spending
limit, correct that account setting and rerun `release-gate`. Do not bypass the
gate or move secret-bearing deployments to pull-request jobs.
