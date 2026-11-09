#!/usr/bin/env bash
set -euo pipefail
tarball=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")
group=${2:?Specify core, docker, compose, devcontainer, ssh, s3, or cloud.}
case "$group" in core|docker|compose|devcontainer|ssh|s3|cloud) ;; *) echo 'Unknown E2E group.' >&2; exit 1;; esac
if [[ "$group" == cloud && "${AGENT_ENV_TEST_CLOUD:-}" != 1 ]]; then
  echo 'Set AGENT_ENV_TEST_CLOUD=1 to authorize billed cloud tests.' >&2
  exit 1
fi
scripts=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
work=${CI_E2E_ROOT:-$(mktemp -d "/tmp/agent-env-ci-$group-XXXXXX")}
mkdir -p "$work"
work=$(cd "$work" && pwd)
if [[ -n "$(ls -A "$work")" ]]; then
  echo "The E2E directory must be empty: $work." >&2
  exit 1
fi
chmod 700 "$work"
printf 'agent-env-ci\n' > "$work/.agent-env-ci-owned"
cleanup() {
  status=$?
  trap - EXIT
  bash "$scripts/ci-cleanup.sh" "$work" || status=1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# Preserve the selected Docker context while isolating all CLI and npm state.
export DOCKER_CONFIG="${DOCKER_CONFIG:-$HOME/.docker}"
export TMPDIR="$work/tmp" AGENT_ENV_HOME="$work/state"
export XDG_CONFIG_HOME="$work/config" XDG_CACHE_HOME="$work/cache" npm_config_cache="$work/npm-cache"
export npm_config_userconfig="$work/npmrc" npm_config_globalconfig="$work/npmrc-global"
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
unset AGENT_ENV_TEST_SSH AGENT_ENV_TEST_SSH_CONFIG AGENT_ENV_TEST_S3 AGENT_ENV_TEST_S3_ENDPOINT AGENT_ENV_TEST_SANDBOX
mkdir -p "$TMPDIR" "$AGENT_ENV_HOME" "$XDG_CONFIG_HOME" "$XDG_CACHE_HOME"
npm install --prefix "$work/prefix" --ignore-scripts --no-save --no-package-lock --no-audit --no-fund "$tarball"
export AGENT_ENV_CLI="$work/prefix/node_modules/.bin/agent-env"
"$AGENT_ENV_CLI" --help >/dev/null
# shellcheck source=scripts/ci-fixtures.sh
source "$scripts/ci-fixtures.sh" "$group" "$work"
if [[ "$group" == docker ]]; then export AGENT_ENV_TEST_SANDBOX=1; fi
node test/run.mjs "$group"
