#!/usr/bin/env bash
set -euo pipefail

# Runs on the deployment host. The advisory lock stays held for the complete
# promote/smoke/commit transaction. EOF is a failed deploy and restores the old
# live target before the lock is released.

readonly parent_dir="${1:?deployment parent is required}"
readonly live_path="${2:?live path is required}"
readonly release_dir="${3:?release directory is required}"
readonly lock_path="${parent_dir}/.webai-deploy.lock"
readonly state_path="${parent_dir}/.webai-transaction"
readonly previous_link="${parent_dir}/.webai-previous"
readonly fault_point="${WEBAI_DEPLOY_FAULT:-}"
readonly token="${release_dir##*.webai-release-}"
readonly expected_helper="${parent_dir}/.webai-helper-${token}"

if [[ "${live_path}" != "${parent_dir}/webai" ]] ||
  [[ ! "${release_dir}" =~ ^${parent_dir}/\.webai-release-[A-Za-z0-9]+$ ]] ||
  [[ ! -d "${release_dir}" ]] || [[ ! -f "${release_dir}/index.html" ]]; then
  echo "Refusing remote deploy: paths or staged release were invalid." >&2
  exit 2
fi

# Production helpers are release-unique, so a concurrent staging transfer cannot
# replace the script being executed. Once Bash has opened it, remove the directory
# entry; the process retains its open script descriptor through the transaction.
if [[ "$0" == "${expected_helper}" ]]; then
  rm -f -- "${expected_helper}"
fi

exec 9>"${lock_path}"
if ! flock --nonblock 9; then
  echo "Another WebAI deployment transaction holds ${lock_path}." >&2
  exit 75
fi

atomic_exchange() {
  local left="$1"
  local right="$2"
  python3 - "${left}" "${right}" <<'PY'
import ctypes
import os
import sys

left, right = (os.fsencode(value) for value in sys.argv[1:])
libc = ctypes.CDLL(None, use_errno=True)
renameat2 = libc.renameat2
renameat2.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
renameat2.restype = ctypes.c_int
if renameat2(-100, left, -100, right, 2) != 0:  # AT_FDCWD, RENAME_EXCHANGE
    error = ctypes.get_errno()
    raise OSError(error, os.strerror(error), os.fsdecode(left), os.fsdecode(right))
PY
}

sync_directory() {
  python3 - "${parent_dir}" <<'PY'
import os
import sys

descriptor = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
}

sync_state() {
  python3 - "${state_path}" <<'PY'
import os
import sys

descriptor = os.open(sys.argv[1], os.O_RDONLY)
try:
    os.fsync(descriptor)
finally:
    os.close(descriptor)
PY
  sync_directory
}

remove_state_after_sync() {
  # Persist live-link and pointer operations before making their recovery record
  # disappear, then persist the record removal as the transaction boundary.
  sync_directory
  rm -f -- "${state_path}"
  sync_directory
}

validate_release_path() {
  local candidate="$1"
  [[ "${candidate}" =~ ^${parent_dir}/\.webai-release-[A-Za-z0-9-]+$ ]]
}

replace_link() {
  local target="$1"
  local destination="$2"
  local temporary="${destination}.next"
  rm -f -- "${temporary}"
  ln -s -- "${target}" "${temporary}"
  mv -Tf -- "${temporary}" "${destination}"
}

restore_previous_pointer() {
  local original_target="$1"
  if [[ -n "${original_target}" ]]; then
    replace_link "${original_target}" "${previous_link}"
  else
    rm -f -- "${previous_link}" "${previous_link}.next"
  fi
}

restore_transaction() {
  local transaction_release="$1"
  local previous_release="$2"
  local previous_mode="$3"
  local transaction_swap="$4"
  local original_pointer="$5"

  if [[ -L "${live_path}" ]] &&
    [[ "$(readlink -f -- "${live_path}")" == "${transaction_release}" ]]; then
    case "${previous_mode}" in
      symlink)
        replace_link "${previous_release}" "${live_path}"
        ;;
      legacy)
        local legacy_source="${previous_release}"
        if [[ ! -d "${legacy_source}" ]] && [[ -d "${transaction_swap}" ]]; then
          legacy_source="${transaction_swap}"
        fi
        [[ -d "${legacy_source}" ]]
        atomic_exchange "${live_path}" "${legacy_source}"
        rm -f -- "${legacy_source}"
        ;;
      missing)
        rm -f -- "${live_path}"
        ;;
      *)
        echo "Refusing recovery: unknown previous deployment mode." >&2
        return 1
        ;;
    esac
  elif [[ "${previous_mode}" == "legacy" ]] && [[ ! -e "${live_path}" ]] &&
    [[ -d "${previous_release}" ]]; then
    mv -T -- "${previous_release}" "${live_path}"
  fi

  restore_previous_pointer "${original_pointer}"
  rm -f -- "${transaction_swap}" "${transaction_swap}.next"
}

read_state() {
  mapfile -t transaction_state <"${state_path}"
  [[ "${#transaction_state[@]}" -eq 5 ]]
  [[ "${transaction_state[0]}" =~ ^${parent_dir}/\.webai-release-[A-Za-z0-9]+$ ]]
  [[ -z "${transaction_state[1]}" ]] || validate_release_path "${transaction_state[1]}"
  [[ "${transaction_state[2]}" == "symlink" || "${transaction_state[2]}" == "legacy" || "${transaction_state[2]}" == "missing" ]]
  [[ "${transaction_state[3]}" =~ ^${parent_dir}/\.webai-swap-[A-Za-z0-9]+$ ]]
  [[ -z "${transaction_state[4]}" ]] || validate_release_path "${transaction_state[4]}"
}

recover_stale_transaction() {
  [[ -f "${state_path}" ]] || return 0
  echo "Recovering an interrupted WebAI deployment transaction." >&2
  read_state
  restore_transaction "${transaction_state[@]}"
  remove_state_after_sync
}

recover_stale_transaction

readonly swap_path="${parent_dir}/.webai-swap-${token}"
state_temporary="${state_path}.${token}"
previous_release=""
previous_mode="missing"
original_pointer=""
transaction_finished=false

if [[ -e "${previous_link}" || -L "${previous_link}" ]]; then
  [[ -L "${previous_link}" ]]
  original_pointer="$(readlink -f -- "${previous_link}")"
  validate_release_path "${original_pointer}"
fi

if [[ -L "${live_path}" ]]; then
  previous_mode="symlink"
  previous_release="$(readlink -f -- "${live_path}")"
  validate_release_path "${previous_release}"
  [[ -d "${previous_release}" ]]
elif [[ -d "${live_path}" ]]; then
  previous_mode="legacy"
  previous_release="${parent_dir}/.webai-release-legacy-$(date -u +%Y%m%dT%H%M%SZ)-${token}"
elif [[ -e "${live_path}" ]]; then
  echo "Refusing remote deploy: live path is neither a directory nor a symlink." >&2
  exit 2
fi

rollback_on_exit() {
  local status="$?"
  trap - EXIT HUP INT TERM
  if [[ "${transaction_finished}" != true ]] && [[ -f "${state_path}" ]]; then
    set +e
    read_state && restore_transaction "${transaction_state[@]}"
    recovery_status="$?"
    if [[ "${recovery_status}" -eq 0 ]]; then
      remove_state_after_sync
    else
      echo "Automatic rollback failed; durable state remains at ${state_path}." >&2
    fi
    set -e
  fi
  exit "${status}"
}
trap rollback_on_exit EXIT HUP INT TERM

umask 077
printf '%s\n' "${release_dir}" "${previous_release}" "${previous_mode}" "${swap_path}" \
  "${original_pointer}" >"${state_temporary}"
mv -Tf -- "${state_temporary}" "${state_path}"
sync_state

rm -f -- "${swap_path}"
ln -s -- "${release_dir}" "${swap_path}"
case "${previous_mode}" in
  symlink)
    mv -Tf -- "${swap_path}" "${live_path}"
    ;;
  legacy)
    atomic_exchange "${live_path}" "${swap_path}"
    mv -T -- "${swap_path}" "${previous_release}"
    ;;
  missing)
    mv -T -- "${swap_path}" "${live_path}"
    ;;
esac

if [[ "${fault_point}" == "after-promotion" ]]; then
  false
fi

printf 'READY\t%s\n' "${previous_release}"
if ! IFS= read -r decision; then
  echo "Deployment controller disconnected before commit; rolling back." >&2
  exit 1
fi

case "${decision}" in
  commit)
    if [[ -n "${previous_release}" ]]; then
      replace_link "${previous_release}" "${previous_link}"
    else
      rm -f -- "${previous_link}" "${previous_link}.next"
    fi
    if [[ "${fault_point}" == "after-previous-pointer" ]]; then
      false
    fi
    remove_state_after_sync
    transaction_finished=true
    ;;
  rollback)
    read_state
    restore_transaction "${transaction_state[@]}"
    remove_state_after_sync
    transaction_finished=true
    ;;
  *)
    echo "Unknown deployment decision; rolling back." >&2
    exit 2
    ;;
esac
