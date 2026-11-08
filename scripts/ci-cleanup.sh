#!/usr/bin/env bash
set -uo pipefail
work=$1
[[ -d "$work" ]] || exit 0
if [[ ! -f "$work/.agent-env-ci-owned" || "$(cat "$work/.agent-env-ci-owned")" != agent-env-ci ]]; then
  echo "Cleanup refused an unmarked directory: $work." >&2
  exit 1
fi
status=0
cli="$work/prefix/node_modules/.bin/agent-env"
if [[ -x "$cli" ]]; then
  while IFS= read -r -d '' state; do
    state_home=$(dirname "$state")
    AGENT_ENV_HOME="$state_home" "$cli" rm --all --purge --remove-worktree --discard-worktree || status=1
    AGENT_ENV_HOME="$state_home" "$cli" daemon stop || status=1
  done < <(find "$work" -name state.json -type f -print0)
fi
if [[ -f "$work/s3-container" ]]; then
  container=$(cat "$work/s3-container")
  if docker inspect "$container" >/dev/null 2>&1; then
    if [[ "$(docker inspect --format '{{index .Config.Labels "agent-env.ci.fixture"}}' "$container")" == "$work" ]]; then
      docker rm -fv "$container" >/dev/null || status=1
    else
      echo 'Cleanup refused a container with a different fixture owner.' >&2
      status=1
    fi
  elif ! docker info >/dev/null 2>&1; then
    echo 'Cleanup cannot check the recorded container because Docker is unavailable.' >&2
    status=1
  fi
fi
if [[ -f "$work/ssh/sshd.pid" ]]; then
  pid=$(cat "$work/ssh/sshd.pid")
  # Check the private configuration path before terminating a recorded process.
  if ps -p "$pid" >/dev/null 2>&1; then
    if ps -p "$pid" -o args= | grep -F -- "$work/ssh/sshd_config" >/dev/null; then
      sudo kill "$pid" || status=1
    else
      echo 'Cleanup refused an SSH PID with a different configuration.' >&2
      status=1
    fi
  fi
fi
if [[ "$status" == 0 ]]; then
  rm -rf "$work"
else
  echo "Cleanup failed. Recovery files remain at $work." >&2
fi
exit "$status"
