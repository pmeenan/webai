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

release_dir="$(
  ssh "${deploy_ssh_options[@]}" "${deploy_host}" \
    "mktemp -d '${deploy_parent}/.webai-release-XXXXXXXX'"
)"
readonly release_dir

if [[ ! "${release_dir}" =~ ^${deploy_parent}/\.webai-release-[A-Za-z0-9]+$ ]]; then
  echo "Refusing to deploy: remote staging path was unexpected: ${release_dir}" >&2
  exit 1
fi
readonly release_token="${release_dir##*.webai-release-}"
readonly remote_helper="${deploy_parent}/.webai-helper-${release_token}"

echo "Staging release in ${release_dir}"
rsync --archive --delete --chmod=D755,F644 \
  --rsh="${deploy_rsh}" \
  "${deploy_source}" "${deploy_host}:${release_dir}/"
rsync --archive --chmod=F700 \
  --rsh="${deploy_rsh}" \
  scripts/deploy-remote.sh \
  "${deploy_host}:${remote_helper}"

remove_remote_helper() {
  ssh "${deploy_ssh_options[@]}" "${deploy_host}" rm -f -- "${remote_helper}" || true
}
early_cleanup() {
  local status="$?"
  trap - EXIT INT TERM
  remove_remote_helper
  exit "${status}"
}
trap early_cleanup EXIT INT TERM

smoke_dir="$(mktemp -d)"
readonly smoke_dir
transaction_active=false

coproc deployment_transaction {
  ssh "${deploy_ssh_options[@]}" "${deploy_host}" \
    "${remote_helper}" "${deploy_parent}" "${deploy_live}" "${release_dir}"
}
readonly transaction_pid="${deployment_transaction_PID}"
exec {transaction_output}<&"${deployment_transaction[0]}"
exec {transaction_input}>&"${deployment_transaction[1]}"
transaction_active=true

finish_transaction() {
  local decision="$1"
  if [[ "${transaction_active}" != true ]]; then
    return 0
  fi
  printf '%s\n' "${decision}" >&"${transaction_input}" || true
  exec {transaction_input}>&-
  if wait "${transaction_pid}"; then
    transaction_active=false
    return 0
  fi
  transaction_active=false
  return 1
}

cleanup() {
  local status="$?"
  trap - EXIT INT TERM
  if [[ "${transaction_active}" == true ]]; then
    finish_transaction rollback || true
  fi
  remove_remote_helper
  rm -rf -- "${smoke_dir}"
  exit "${status}"
}
trap cleanup EXIT INT TERM

if ! IFS=$'\t' read -r transaction_status previous_release <&"${transaction_output}" ||
  [[ "${transaction_status}" != "READY" ]]; then
  exec {transaction_input}>&-
  wait "${transaction_pid}" || true
  transaction_active=false
  echo "Remote deployment transaction failed before smoke checks." >&2
  exit 1
fi
readonly previous_release

if ! check_route "" "home" || ! check_route "capabilities/" "capabilities"; then
  echo "Smoke check failed; requesting rollback to ${previous_release:-no prior release}." >&2
  finish_transaction rollback || true
  exit 1
fi

asset_path="$(rg --only-matching '/_astro/[^" ]+\.js' \
  "${smoke_dir}/home.body" | sed -n '1p')"
if [[ -z "${asset_path}" ]] || ! check_route "${asset_path#/}" "asset"; then
  echo "Asset smoke check failed; requesting rollback to ${previous_release:-no prior release}." >&2
  finish_transaction rollback || true
  exit 1
fi

if ! finish_transaction commit; then
  echo "Remote commit failed; the remote transaction attempted rollback." >&2
  exit 1
fi

echo "Deployed ${release_dir} and verified routes, assets, and isolation headers."
