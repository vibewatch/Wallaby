#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

[[ $EUID -eq 0 && $# -eq 3 ]] || { echo "Run as root with IMAGE COMMIT PAYLOAD_DIRECTORY" >&2; exit 1; }
image=$1
commit=$2
payload=$3
[[ "$image" =~ ^ghcr\.io/huangyingting/wallaby@sha256:[a-f0-9]{64}$ ]] || { echo "Invalid immutable Wallaby image" >&2; exit 1; }
[[ "$commit" =~ ^[a-f0-9]{40}$ && "$payload" == /tmp/wallaby-deploy.* && -d "$payload" && ! -L "$payload" ]] || { echo "Invalid deployment payload" >&2; exit 1; }
mountpoint -q /data || { echo "The persistent /data volume is not mounted" >&2; exit 1; }
test -f /etc/caddy/Caddyfile

app=/data/apps/wallaby
site=/etc/caddy/sites/wallaby.caddy
backup_root=/data/backups/wallaby
exec 9>/run/lock/webstack-deploy-wallaby.lock
flock -w 600 9 || { echo "Another Wallaby operation is running" >&2; exit 1; }

python3 - "$app" "$site" <<'PY'
import json
from pathlib import Path
import subprocess
import sys

app, site = map(Path, sys.argv[1:])
expected = {"app": "wallaby", "domain": "wallaby.genisisiq.com", "container_port": 3000, "host_port": 10002}
if app.is_symlink() or site.is_symlink():
    raise SystemExit("Refusing a symlinked application path")
for metadata in Path("/data/apps").glob("*/app.json"):
    other = json.loads(metadata.read_text())
    if metadata.parent == app:
        if other != expected:
            raise SystemExit("Existing Wallaby app metadata does not match this deployment")
    elif other.get("host_port") == 10002 or other.get("domain") == expected["domain"]:
        raise SystemExit("Wallaby's domain or port belongs to another application")
if not (app / "app.json").exists():
    if app.exists() or site.exists():
        raise SystemExit("Unmanaged Wallaby paths already exist; inspect them before deploying")
    if subprocess.check_output(["ss", "-H", "-ltn", "sport = :10002"], text=True).strip():
        raise SystemExit("Port 10002 is already in use")
    app.mkdir(mode=0o700, parents=True)
    (app / "app.json").write_text(json.dumps(expected, indent=2) + "\n")
    import secrets
    (app / "bootstrap.env").write_text(
        "BOOTSTRAP_ADMIN_USERNAME=admin\nBOOTSTRAP_ADMIN_PASSWORD=" + secrets.token_urlsafe(32) + "\n"
    )
for name in ("storage", "app.env", "image.env", "compose.yml", "bootstrap.env"):
    if (app / name).is_symlink():
        raise SystemExit("Refusing a symlinked application file or storage directory")
PY

install -d -m 0750 -o 1001 -g 1001 "$app/storage" "$app/storage/media"
install -d -m 0700 "$backup_root"
python3 - "$app/app.env" "$payload/application.env" "$payload/staged.env" "$commit" <<'PY'
import base64
from pathlib import Path
import re
import secrets
import sys

current, incoming, destination = map(Path, sys.argv[1:4])
values = {}
for path in (current, incoming):
    if not path.exists():
        continue
    for line in path.read_text().splitlines():
        if not line or line.lstrip().startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if not separator or not re.fullmatch(r"[A-Z_][A-Z0-9_]*", key):
            raise SystemExit("Application environment contains an invalid line")
        allowed = {
            "AUTH_SECRET", "SITE_CREDENTIALS_KEY", "TWO_FACTOR_KEY", "POCKET_TOKEN_KEY",
            "WALLABY_BOT_PROFILES", "TWO_FACTOR_SMTP_HOST", "TWO_FACTOR_SMTP_PORT",
            "TWO_FACTOR_SMTP_SECURITY", "TWO_FACTOR_SMTP_USER", "TWO_FACTOR_SMTP_PASSWORD",
            "TWO_FACTOR_EMAIL_FROM",
        }
        if path == incoming and key not in allowed:
            raise SystemExit(f"VM_APP_ENV must not override managed variable {key}")
        values[key] = value
values.setdefault("AUTH_SECRET", secrets.token_urlsafe(48))
for key in ("SITE_CREDENTIALS_KEY", "TWO_FACTOR_KEY", "POCKET_TOKEN_KEY"):
    values.setdefault(key, base64.b64encode(secrets.token_bytes(32)).decode())
values.update({
    "AUTH_URL": "https://wallaby.genisisiq.com",
    "AUTH_TRUST_HOST": "true",
    "DATABASE_URL": "file:/app/storage/wallaby.db",
    "WALLABY_MEDIA_DIR": "/app/storage/media",
    "WALLABY_BROWSER_RENDER": "false",
    "DEPLOYMENT_VERSION": sys.argv[4],
})
destination.write_text("".join(f"{key}={value}\n" for key, value in values.items()))
PY

export DOCKER_CONFIG="$payload/docker"
install -d -m 0700 "$DOCKER_CONFIG"
docker login ghcr.io --username "$(cat "$payload/registry-user")" --password-stdin < "$payload/registry-token" >/dev/null
docker pull "$image"
docker run --rm --entrypoint npm --env-file "$payload/staged.env" "$image" run config:validate

compose() {
  docker compose --project-name wallaby --project-directory "$app" --file "$app/compose.yml" --env-file "$app/image.env" "$@"
}

backup=""
old_image=false
site_existed=false
[[ ! -f "$site" ]] || { cp -- "$site" "$payload/previous.caddy"; site_existed=true; }
rollback() {
  local status=$?
  trap - ERR
  set +e
  echo "Wallaby deployment failed; recovering the previous state." >&2
  if [[ -f "$app/image.env" && -f "$app/compose.yml" ]]; then
    compose stop
  fi
  if [[ -n "$backup" && -f "$backup" ]]; then
    local failed
    failed=$(mktemp -d "$backup_root/failed-storage.XXXXXXXX")
    if ! mv -- "$app/storage" "$failed/storage" || ! tar -xzf "$backup" -C "$app"; then
      echo "Database/media restoration failed; containers remain stopped and both copies are retained." >&2
      exit "$status"
    fi
  fi
  if [[ "$old_image" == true ]]; then
    if ! compose up -d --no-build --wait --wait-timeout 180; then
      echo "Previous Wallaby containers could not be restored; operator intervention is required." >&2
    fi
  fi
  if [[ "$site_existed" == true ]]; then
    cp -- "$payload/previous.caddy" "$site"
  else
    rm -f -- "$site"
  fi
  if ! caddy validate --config /etc/caddy/Caddyfile || ! systemctl reload caddy; then
    echo "Caddy recovery failed; inspect the existing configuration." >&2
  fi
  exit "$status"
}
trap rollback ERR

if [[ -f "$app/image.env" ]]; then
  old_image=true
  compose stop
  backup="$backup_root/$(date -u +%Y%m%dT%H%M%SZ)-$commit.tar.gz"
  tar -czf "$backup.tmp" -C "$app" storage app.env image.env compose.yml app.json
  mv -- "$backup.tmp" "$backup"
  echo "Created a consistent pre-upgrade database/media backup."
fi

install -m 0600 "$payload/staged.env" "$app/app.env"
install -m 0600 "$payload/compose.yml" "$app/compose.yml"
printf 'APP_IMAGE=%s\n' "$image" > "$app/image.env"
compose config --quiet
compose up -d --no-build --wait --wait-timeout 180
if [[ -f "$app/bootstrap.env" ]]; then
  docker run --rm --env-file "$app/app.env" --env-file "$app/bootstrap.env" \
    --volume "$app/storage:/app/storage" "$image" npm run users:bootstrap
fi
curl --fail --silent --show-error --max-time 10 http://127.0.0.1:10002/api/health/ready
test -n "$(compose ps --status running --quiet worker)"
cat > "$payload/wallaby.caddy" <<'CADDY'
wallaby.genisisiq.com {
    encode zstd gzip
    request_body {
        max_size 25MB
    }
    reverse_proxy 127.0.0.1:10002
}
CADDY
install -m 0644 "$payload/wallaby.caddy" "$site"
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
trap - ERR
printf '\nWALLABY_DEPLOY_OK %s\n' "$commit"
