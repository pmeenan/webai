#!/usr/bin/env bash

# Uses deploy_url and smoke_dir from the transactional deploy controller.
check_route() {
  local route="$1"
  local name="$2"
  local headers="${smoke_dir}/${name}.headers"
  local body="${smoke_dir}/${name}.body"

  curl --fail --silent --show-error --connect-timeout 10 --max-time 30 \
    --dump-header "${headers}" \
    --output "${body}" "${deploy_url}/${route}" || return 1
  rg --ignore-case --quiet \
    '^cross-origin-opener-policy: same-origin\r?$' "${headers}" || return 1
  rg --ignore-case --quiet \
    '^cross-origin-embedder-policy: require-corp\r?$' "${headers}" || return 1
}
