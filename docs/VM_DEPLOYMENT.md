# GitHub Actions deployment to Webstack

Wallaby uses the same Azure VM, GHCR registry, GitHub OIDC authentication, and
Caddy HTTPS entry point as EduLoop. It runs at **https://wallaby.genisisiq.com**,
with a loopback-only upstream on port **10002**.

Unlike EduLoop, this release supports SQLite, not PostgreSQL, and needs a
continuous import worker. Webstack's `webstack-deploy.yml@v1.0.0` creates a
PostgreSQL environment and a single container, so copying EduLoop's reusable
workflow call would lose persistence and fail Wallaby's configuration checks.
Wallaby instead owns a small app-specific rollout using the same Azure Run
Command transport. It does not change EduLoop, PostgreSQL, or the global Caddy
configuration.

## Runtime and storage

`docker-compose.vm.yml` starts exactly one web container and one worker, using
the same image digest and `/data/apps/wallaby/storage` bind mount. Each container
runs as UID/GID 1001 with a 1 GiB memory ceiling, dropped capabilities, bounded
logs, and automatic restart. Only the web service publishes a port, and only on
`127.0.0.1`.

| Resource | Requirement |
| --- | --- |
| Azure VM | Existing Webstack host with Docker Compose 2.30+ and Caddy |
| DNS | `wallaby.genisisiq.com` must resolve to that VM |
| Local persistence | Mounted `/data`; SQLite and media share `storage/` |
| Blob Storage | **Not required for runtime**; blobs cannot replace SQLite's local filesystem |
| PostgreSQL / Redis | Not required by this release |
| SMTP | Optional; enables email two-factor authentication and self-service password reset |
| Chromium | Disabled in this profile; ordinary HTTP extraction works without it |

The application does not need a new Azure Storage account to serve articles or
images. The VM's existing off-host backup storage can also hold Wallaby backups,
but its current `webstack-backup` job only dumps PostgreSQL. **It does not protect
Wallaby's SQLite database, media, or encryption keys.**

Rollouts take a consistent, root-only pre-upgrade archive under
`/data/backups/wallaby/` after stopping only Wallaby's two containers. A failed
upgrade restores the prior database, media, environment, Compose configuration,
and image. Failed-upgrade storage is retained for diagnosis rather than deleted.
These local archives are not disaster recovery: VM/disk loss can destroy both
the live data and local archives. Before relying on the service for irreplaceable
data, schedule consistent database/media/key backups to off-VM storage and test
restoration. Follow [the production backup procedure](PRODUCTION.md#storage-and-backups).
Old local archives are not automatically deleted.

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
The workflow builds a linux/amd64 image, tags it with that commit, then deploys
the immutable digest. The commit is embedded as `DEPLOYMENT_VERSION` at build
time and supplied at runtime. A rollout lock prevents overlapping Wallaby
deployments; the single-instance SQLite profile intentionally has brief upgrade
downtime instead of overlapping writers from different releases.

After configuration validation and image pull, the VM snapshots existing data,
starts the web and worker, bootstraps an administrator if needed, and validates
only Wallaby's Caddy site. Actions then checks public HTTPS readiness, liveness,
and the sign-in page. Azure Run Command's HTTP success alone is not accepted as
deployment success: the remote script must emit a matching completion marker.

If GitHub reports that a job never started because of billing or a spending
limit, correct that account setting and rerun `release-gate`. Do not bypass the
gate or move secret-bearing deployments to pull-request jobs.
