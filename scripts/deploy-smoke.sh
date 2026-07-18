#!/usr/bin/env bash

# Uses deploy_url and smoke_dir from the deploy controller.
check_route() {
  local route="$1"
  local name="$2"
  local expected_content="${3:-}"
  local headers="${smoke_dir}/${name}.headers"
  local body="${smoke_dir}/${name}.body"

  curl --fail --silent --show-error --connect-timeout 10 --max-time 30 \
    --dump-header "${headers}" \
    --output "${body}" "${deploy_url}/${route}" || return 1
  rg --quiet '^HTTP/[0-9.]+ 200 ' "${headers}" || return 1
  rg --ignore-case --quiet \
    '^cross-origin-opener-policy: same-origin\r?$' "${headers}" || return 1
  rg --ignore-case --quiet \
    '^cross-origin-embedder-policy: require-corp\r?$' "${headers}" || return 1

  case "${expected_content}" in
    "") ;;
    html)
      rg --ignore-case --quiet \
        '^content-type: text/html(?:;|\r?$)' "${headers}" || return 1
      ;;
    javascript)
      rg --ignore-case --quiet \
        '^content-type: (application|text)/javascript(?:;|\r?$)' "${headers}" || return 1
      ;;
    *) return 2 ;;
  esac
}
