import { execFileSync } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing deployment setting: ${name}`);
  return value;
}

const commit = required("DEPLOY_COMMIT");
const image = required("DEPLOY_IMAGE");
if (!/^[a-f0-9]{40}$/.test(commit) || !/^ghcr\.io\/vibewatch\/wallaby@sha256:[a-f0-9]{64}$/.test(image)) {
  throw new Error("Deployment requires a full commit SHA and the Wallaby GHCR image digest");
}
const files = {
  "deploy.sh": readFileSync("scripts/deploy-vm.sh"),
  "compose.yml": readFileSync("docker-compose.vm.yml"),
  "export-sqlite.py": readFileSync("scripts/export-sqlite.py"),
  "application.env": Buffer.from(process.env.APPLICATION_ENV || ""),
  "registry-user": Buffer.from(required("REGISTRY_USER")),
  "registry-token": Buffer.from(required("REGISTRY_TOKEN")),
};
const script = [
  "#!/usr/bin/env bash",
  "set -Eeuo pipefail",
  "umask 077",
  'work=$(mktemp -d /tmp/wallaby-deploy.XXXXXXXX)',
  'trap \'rm -f -- "$work/deploy.sh" "$work/compose.yml" "$work/export-sqlite.py" "$work/application.env" "$work/registry-user" "$work/registry-token" "$work/staged.env" "$work/previous.caddy" "$work/wallaby.caddy" "$work/docker/config.json"; if [[ -d "$work/docker" ]]; then rmdir -- "$work/docker"; fi; rmdir -- "$work"\' EXIT',
  ...Object.entries(files).map(([name, bytes]) => `printf '%s' '${bytes.toString("base64")}' | base64 --decode > "$work/${name}"`),
  `bash "$work/deploy.sh" '${image}' '${commit}' "$work"`,
].join("\n");
const filename = join(required("RUNNER_TEMP"), "wallaby-run-command.sh");
writeFileSync(filename, script, { mode: 0o600 });
try {
  const result = execFileSync("az", [
    "vm", "run-command", "invoke",
    "--resource-group", required("AZURE_RESOURCE_GROUP"),
    "--name", required("AZURE_VM_NAME"),
    "--command-id", "RunShellScript",
    "--scripts", `@${filename}`,
    "--only-show-errors", "--output", "json",
  ], { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  const messages = JSON.parse(result).value.map((item) => item.message || "").join("\n");
  console.log(messages);
  if (!messages.split(/\r?\n/).includes(`WALLABY_DEPLOY_OK ${commit}`)) {
    throw new Error("The VM did not confirm a healthy Wallaby deployment");
  }
} finally {
  unlinkSync(filename);
}
