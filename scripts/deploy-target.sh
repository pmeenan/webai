#!/usr/bin/env bash
set -euo pipefail

readonly action="${1:?prepare or cleanup is required}"
readonly parent_dir="${2:?deployment parent is required}"
readonly live_path="${3:?live path is required}"
readonly migration_state="${parent_dir}/.webai-direct-migration"
readonly migration_temporary="${migration_state}.next"
readonly fault_point="${WEBAI_DIRECT_DEPLOY_FAULT:-}"
migration_release=""
migration_pending=false

if [[ "${parent_dir}" != /* ]] || [[ "${live_path}" != "${parent_dir}/webai" ]]; then
  echo "Refusing deploy target operation: paths were invalid." >&2
  exit 2
fi

validate_release_path() {
  local candidate="$1"
  local token="${candidate#"${parent_dir}/.webai-release-"}"
  [[ "${candidate}" == "${parent_dir}/.webai-release-${token}" ]] &&
    [[ "${token}" =~ ^[A-Za-z0-9-]+$ ]]
}

prepare_target() {
  recover_interrupted_migration() {
    rm -f -- "${migration_temporary}"
    [[ -f "${migration_state}" ]] || return 0
    IFS= read -r migration_release <"${migration_state}"
    if ! validate_release_path "${migration_release}"; then
      echo "Refusing direct-deploy recovery: migration state was invalid." >&2
      exit 2
    fi

    if [[ -d "${live_path}" && ! -L "${live_path}" ]] &&
      [[ ! -e "${migration_release}" ]]; then
      rm -f -- "${migration_state}"
      sync "${parent_dir}"
    elif [[ ! -e "${live_path}" && ! -L "${live_path}" ]] &&
      [[ -d "${migration_release}" ]]; then
      mv -T -- "${migration_release}" "${live_path}"
      rm -f -- "${migration_state}"
      sync "${parent_dir}"
    elif [[ -L "${live_path}" ]] &&
      [[ "$(readlink -f -- "${live_path}")" == "${migration_release}" ]] &&
      [[ -d "${migration_release}" ]]; then
      rm -f -- "${migration_state}"
      sync "${parent_dir}"
    else
      echo "Refusing direct-deploy recovery: migration state did not match the filesystem." >&2
      exit 2
    fi
  }

  restore_live_link_on_exit() {
    local status="$?"
    trap - EXIT HUP INT TERM
    if [[ "${migration_pending}" == true ]] &&
      [[ ! -e "${live_path}" && ! -L "${live_path}" ]] &&
      [[ -d "${migration_release}" ]]; then
      ln -s -- "${migration_release}" "${live_path}" || true
    fi
    exit "${status}"
  }
  trap restore_live_link_on_exit EXIT HUP INT TERM

  recover_interrupted_migration

  if [[ -L "${live_path}" ]]; then
    local active_release
    active_release="$(readlink -f -- "${live_path}")"
    if ! validate_release_path "${active_release}" || [[ ! -d "${active_release}" ]]; then
      echo "Refusing direct-deploy migration: live symlink target was unexpected." >&2
      exit 2
    fi

    printf '%s\n' "${active_release}" >"${migration_temporary}"
    sync -d "${migration_temporary}"
    mv -Tf -- "${migration_temporary}" "${migration_state}"
    sync -d "${migration_state}"
    sync "${parent_dir}"
    migration_release="${active_release}"
    migration_pending=true
    rm -- "${live_path}"
    if [[ "${fault_point}" == "after-unlink" ]]; then
      false
    fi
    if ! mv -T -- "${active_release}" "${live_path}"; then
      ln -s -- "${active_release}" "${live_path}"
      echo "Direct-deploy migration failed; restored the live symlink." >&2
      exit 1
    fi
    migration_pending=false
    rm -f -- "${migration_state}"
    sync "${parent_dir}"
  elif [[ ! -e "${live_path}" ]]; then
    mkdir -- "${live_path}"
  elif [[ ! -d "${live_path}" ]]; then
    echo "Refusing direct deploy: live path is not a directory." >&2
    exit 2
  fi

  if [[ -L "${live_path}" ]] || [[ ! -d "${live_path}" ]]; then
    echo "Refusing direct deploy: live path did not become a real directory." >&2
    exit 2
  fi

  trap - EXIT HUP INT TERM
}

cleanup_legacy_releases() {
  if [[ -L "${live_path}" ]] || [[ ! -d "${live_path}" ]] ||
    [[ ! -f "${live_path}/index.html" ]]; then
    echo "Refusing legacy cleanup: verified live directory is unavailable." >&2
    exit 2
  fi

  local candidate
  for candidate in "${parent_dir}"/.webai-release-*; do
    [[ -e "${candidate}" || -L "${candidate}" ]] || continue
    if ! validate_release_path "${candidate}" || [[ ! -d "${candidate}" ]] ||
      [[ -L "${candidate}" ]]; then
      echo "Refusing legacy cleanup: unexpected release entry ${candidate}." >&2
      exit 2
    fi
    find "${candidate}" -xdev -depth -delete
  done

  rm -f -- \
    "${parent_dir}/.webai-previous" \
    "${parent_dir}/.webai-previous.next" \
    "${parent_dir}/.webai-transaction"

  for candidate in \
    "${parent_dir}"/.webai-helper-* \
    "${parent_dir}"/.webai-swap-*; do
    [[ -e "${candidate}" || -L "${candidate}" ]] || continue
    local helper_name="${candidate#"${parent_dir}/.webai-"}"
    if [[ "${candidate}" != "${parent_dir}/.webai-${helper_name}" ]] ||
      [[ ! "${helper_name}" =~ ^(helper|swap)-[A-Za-z0-9-]+(\.next)?$ ]] ||
      [[ -d "${candidate}" && ! -L "${candidate}" ]]; then
      echo "Refusing legacy cleanup: unexpected helper entry ${candidate}." >&2
      exit 2
    fi
    rm -f -- "${candidate}"
  done
}

case "${action}" in
  prepare)
    prepare_target
    ;;
  cleanup)
    cleanup_legacy_releases
    ;;
  *)
    echo "Unknown deploy target operation: ${action}" >&2
    exit 2
    ;;
esac
