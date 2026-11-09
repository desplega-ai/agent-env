# Provider and project command verification

Verified on 2026-11-09 with installed candidate archives from this checkout.
The verification used Node 26.0.0, Docker 29.8.2, and real E2B sandboxes.
No unit tests or mock providers were used.
Runtime checks used installed candidate archives while the version remained `0.4.1`.
The installed core suite also passed after the version bump to `0.5.0`.

## Local provider checks

The Dev Container suite passed with the official CLI version 0.90.0.
It exercised image, Dockerfile, and Compose definitions through the installed agent-env executable.
Checks included JSONC, native lifecycle hooks, workspace users, HTTP routing, independent instances, and persistent named volumes.
After review fixes, the suite also verified raw TCP routes and Compose priority when both configuration types exist.
It verified startup before an application listens, then started that application through a project command.
Two Node/Postgres instances shared their respective Compose network namespaces without sharing containers or data volumes.
Forwarded `service:port` entries reached Postgres through localhost.
Changed Compose configuration required recreation and retained named-volume data.
All three shipped Dev Container examples ran from the installed package.
The suite also checked daemon reconnection, failed-start cleanup, purge, source preservation, and explicit unsupported-operation errors.
An edited Node server restarted through `node --watch` and returned its changed response without restarting agent-env.

Project command suites passed against Docker and Compose.
Those suites covered explicit service selection, argument arrays, shell arguments, secret redaction, exit codes, and both output streams.
Dev Container checks confirmed that a project command uses the workspace user.
Its separate exec checks covered literal arguments, failure exit codes, and both output streams.
Command-only configuration edits preserved the existing Docker container.
Saved commands survived daemon restart.
Gated `run` and `exec` commands allowed concurrent status, logs, other commands, and another instance's lifecycle operations.
The test identified its container through the installation owner and exact container name.
An earlier test used a label absent from native Docker containers. That lookup is corrected and rejects empty results.

## Live E2B checks

The paid suite used the official SDK version 2.63.0 and an existing authenticated account.
All application operations invoked the installed CLI.
SDK queries independently verified resource ownership, private ingress, pause state, and deletion.

Node and Python services shared one sandbox.
HTTP and WebSockets worked through localhost, while unauthenticated public ingress failed.
Local edits, additions, and deletions synchronized automatically.
The watcher resumed after daemon restart.
An HTTP event stream survived more than 30 seconds without traffic.
With `--no-watch`, source files changed only after `sync`.
Credential files and dependency directories did not reach the sandbox.

Pause and resume preserved the service process ID, an in-memory counter, and a data file.
Project commands, logs, successful exec, and failed exec preserved their expected output and exit codes.
Mismatched local ownership and remote metadata both blocked purge.
Failed startup removed the failed sandbox.
Final purge removed the test sandboxes and their private ownership records.
After review fixes, repeated `up` calls preserved the running process.
Environment changes restarted the affected service without deleting sandbox files.
Removal followed by changed service configuration reused the same sandbox and retained its data.
The suite confirmed that ownership records contain no API key or resolved service environment.
It also verified that retained logs did not expose secrets from the previous service configuration.
A command ran for 65 seconds while status and automatic source synchronization remained responsive.
A separate short lease paused automatically. Explicit resume reused the sandbox, and purge confirmed its deletion.

An initial fixture used invalid dotenv syntax and failed before allocation.
Another run exposed login-profile noise in shell commands.
Project commands now use `sh -c` without loading login profiles.
The final paid suite passed after those corrections.

## Agent Swarm application check

The initial check used source revision `b7eccd1795091ea4d431c7ff9c029c3d879af853` in an isolated local clone.
The repeat after review fixes passed at revision `fedaa415d432fb4b705377c2d7a6c1e95fff9f84`.
Another repeat passed after command execution moved outside the daemon's global queue.
The original checkout remained unchanged.
The shipped Compose example started the real API and Vite dashboard.
Checks verified authenticated KV write/read, persistence after restart, named localhost routing, and dashboard proxy responses.
A named project command verified API health.
Two UI file edits appeared through Vite without an environment restart.
The check used HTTP and did not verify browser rendering.

## Reproduction

Pack and install a candidate into an isolated prefix.
Set `AGENT_ENV_CLI` to its absolute executable path.

```sh
npm ci --ignore-scripts
npm run check
node scripts/pack.mjs /path/to/artifacts
npm install --prefix /path/to/prefix --ignore-scripts /path/to/artifacts/desplega.ai-agent-env-VERSION.tgz
export AGENT_ENV_CLI=/path/to/prefix/node_modules/.bin/agent-env
node test/run.mjs core docker compose devcontainer
AGENT_ENV_TEST_E2B=1 node test/run.mjs e2b
```

The paid command also requires `E2B_API_KEY` through a private environment source.
It creates billed sandboxes and removes only its own resources.
Follow [the Agent Swarm guide](agent-swarm.md) for the application check.
