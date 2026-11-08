# Verification evidence

Verified on 2026-11-08 with the real Agent Swarm application.
Source checkout: `/Users/taras/Documents/code/agent-swarm`.
Source revision: `122d2ea1c9e3241968b75be3df7f5c9edd623c87`.
The original checkout remained unchanged.

The final run used a private copy of that source under `/tmp/agent-env-swarm-pc5WoW/workspace`.
It copied `agent-env.json` and `compose.agent-env.yaml` into that directory.
The configuration bound this copy directly into the containers.
No source files were mocked or replaced.

Host prerequisites: Node `v26.0.0`, Docker Engine `29.8.2`, Docker Compose `5.5.0`.
Container: `oven/bun:1.4.4`, Linux arm64.
The host does not need Bun.

## Commands exercised

Run from the private source copy:

```sh
export AGENT_ENV_HOME=/tmp/agent-env-swarm-pc5WoW/state
export CLI=/Users/taras/.t3/projects/dev-now/bin/agent-env.mjs
export EXAMPLE=/Users/taras/.t3/projects/dev-now/examples/agent-swarm
export TEST_ENV=/tmp/agent-env-swarm-pc5WoW/test.env
node "$CLI" up --name swarm-example --env-file "$TEST_ENV"
node "$CLI" use swarm-example
node "$CLI" list
node --env-file="$TEST_ENV" "$EXAMPLE/verify.mjs"
node "$CLI" logs swarm-example --service api
node "$CLI" logs swarm-example --service setup
node "$CLI" exec swarm-example --service api -- bun --no-env-file -e \
  "fetch('http://127.0.0.1:3013/health').then(r=>r.json()).then(console.log)"
node "$CLI" down swarm-example
node "$CLI" up swarm-example
node --env-file="$TEST_ENV" "$EXAMPLE/verify.mjs" --read-only
node "$CLI" rm swarm-example --purge
node "$CLI" daemon stop
```

## Outcomes

- The setup job installed 1,626 packages from the frozen lockfile in 43.71 seconds.
- Setup exited successfully before the API and UI started.
- API `/health` returned HTTP 200 with `status: "ok"` and version `2.9.0`.
- An unauthenticated KV request returned HTTP 401.
- An authenticated KV PUT and GET returned HTTP 200 with the expected value.
- The dashboard's proxy returned the same stored value.
- Dashboard HTML and Vite's transformed `src/main.tsx` returned HTTP 200.
- Named localhost routes and selected bare localhost routes both worked.
- Docker inspection confirmed random backend ports bound to `127.0.0.1`.
- The KV value survived `down` and `up` without another write.
- CLI logs contained the successful health and KV requests.
- CLI exec returned the real health response.
- Two edits to a public file appeared through Vite without restart.
- A deliberately invalid root `.env` did not affect API startup.
- A test value in `apps/ui/.env` did not appear in Vite's transformed environment.
- Package manifests, lockfile, entrypoints, and Vite configuration matched the original source after execution.
- The API reported zero agents and zero tasks.
- The API seeded eleven schedule definitions. The scheduler capability remained disabled.

## Limits and resolved blockers

The first version exceeded the original 60-second startup limit during dependency installation.
The final example uses `startupTimeoutSeconds: 900` and needs no manual preparation command.

Docker omitted published ports on an internal-only network.
The final example uses an ordinary isolated Compose network.
Integrations remain disabled, but the API can perform its public model-catalog refresh.

HTTP verification does not prove browser rendering or dashboard interaction.
API source changes require an instance restart. Vite observes UI source changes directly.
No custom images were built. No workers, schedule executions, or production workloads were started.

## Cleanup and disk

The task removed all its containers, networks, nine named volumes, private source copy, credentials, logs, and daemon state.
It also removed the Bun image downloaded for this task.
The original Agent Swarm checkout still returned an empty `git status --short`.
No commits or pushes were made.

`df -h /` reported 11 GiB available before the task.
It reported 6.7 GiB before final cleanup and 10 GiB after cleanup, approximately 3.3 GiB recovered.
Other work used the shared machine concurrently, so these figures do not isolate all changes in disk usage.
