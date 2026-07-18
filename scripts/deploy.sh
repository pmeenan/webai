#!/usr/bin/env bash
set -euo pipefail

readonly deploy_script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
source "${deploy_script_dir}/deploy-smoke.sh"

readonly deploy_source="dist/"
readonly deploy_host="plex"
readonly deploy_parent="/var/www/meenan.dev"
readonly deploy_live="${deploy_parent}/webai"
readonly deploy_url="https://webai.meenan.dev"
readonly -a deploy_ssh_options=(
  -o BatchMode=yes
  -o ConnectTimeout=10
  -o ServerAliveInterval=10
  -o ServerAliveCountMax=3
)
readonly deploy_rsh="ssh ${deploy_ssh_options[*]}"

if [[ ! -f "${deploy_source}index.html" ]]; then
  echo "Refusing to deploy: dist/index.html is missing. Run pnpm build first." >&2
  exit 1
fi

smoke_dir="$(mktemp -d)"
readonly smoke_dir
lock_active=false

release_deploy_lock() {
  if [[ "${lock_active}" != true ]]; then
    return 0
  fi
  exec {lock_input}>&-
  if wait "${lock_pid}"; then
    lock_active=false
    return 0
  fi
  lock_active=false
  return 1
}

cleanup() {
  local status="$?"
  trap - EXIT INT TERM
  release_deploy_lock || true
  rm -rf -- "${smoke_dir}"
  exit "${status}"
}
trap cleanup EXIT INT TERM

# Serialize the complete direct deployment against both another direct deploy and any
# still-running D-023 transaction. The remote flock is released automatically if the
# SSH controller disappears.
coproc deployment_lock {
  ssh "${deploy_ssh_options[@]}" "${deploy_host}" \
    "exec flock --exclusive --nonblock '${deploy_parent}/.webai-deploy.lock' sh -c 'printf \"READY\\n\"; cat >/dev/null'"
}
readonly lock_pid="${deployment_lock_PID}"
lock_output="${deployment_lock[0]}"
lock_input="${deployment_lock[1]}"
if ! IFS= read -r lock_status <&"${lock_output}" || [[ "${lock_status}" != "READY" ]]; then
  exec {lock_input}>&-
  exec {lock_output}<&-
  wait "${lock_pid}" || true
  echo "Another WebAI deployment holds the remote deploy lock." >&2
  exit 75
fi
exec {lock_output}<&-
lock_active=true

# The first direct deploy converts D-023's live release symlink back into the real
# webai directory without copying the active build. Later deploys only validate it.
ssh "${deploy_ssh_options[@]}" "${deploy_host}" bash -s -- \
  prepare "${deploy_parent}" "${deploy_live}" <"${deploy_script_dir}/deploy-target.sh"

echo "Syncing ${deploy_source} directly to ${deploy_host}:${deploy_live}/"
# Updated files are renamed into place near the end of the transfer and old hashed
# assets are deleted only after new files arrive. This reduces, but does not claim to
# eliminate, the mixed-version window inherent in a direct in-place deployment.
rsync --archive --delay-updates --delete-after --chmod=D755,F644 \
  --rsh="${deploy_rsh}" \
  "${deploy_source}" "${deploy_host}:${deploy_live}/"

if ! check_route "" "home" html ||
  ! check_route "capabilities/" "capabilities" html; then
  echo "Smoke check failed after direct deployment; no automatic rollback is available." >&2
  exit 1
fi

asset_path="$(rg --only-matching '/_astro/[^" ]+\.js' \
  "${deploy_source}index.html" | sed -n '1p')"
if [[ -z "${asset_path}" ]] ||
  ! check_route "${asset_path#/}" "asset" javascript; then
  echo "Asset smoke check failed after direct deployment; no automatic rollback is available." >&2
  exit 1
fi

# Only a verified direct deploy removes D-023's obsolete release directories and
# transaction pointers. This is idempotent on subsequent deployments.
ssh "${deploy_ssh_options[@]}" "${deploy_host}" bash -s -- \
  cleanup "${deploy_parent}" "${deploy_live}" <"${deploy_script_dir}/deploy-target.sh"

if ! release_deploy_lock; then
  echo "Deployment finished, but releasing the remote deploy lock reported an error." >&2
  exit 1
fi

echo "Deployed directly to ${deploy_host}:${deploy_live}/ and verified routes, assets, and isolation headers."
