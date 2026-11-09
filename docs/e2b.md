# E2B process provider

This provider runs every configured service inside one E2B sandbox.
It does not require Docker on the client.
Services share the sandbox filesystem, network, template, and lifecycle.
Each service runs a shell command, rather than a Docker image.

## Dependency and exports

The implementation exports `E2BProvider` and `resolveE2BSpec(spec)` from `src/providers/e2b.mjs`.
The resolver is synchronous and returns a new specification.
It validates supported options and captures credentials before daemon IPC.
The provider implements the lifecycle contract in `src/providers/README.md`.
Its handles contain JSON values only.
Connections and SDK objects remain in memory.

Verified dependency: **`e2b@2.63.0`**.
`npm view e2b version dist.integrity engines --json` reported this version during implementation.
The package requires **Node >=22.19.0**.
The SDK inspection used an isolated temporary installation.
The CLI bundles the SDK as a pinned dependency.

```sh
npm install --save-exact e2b@2.63.0
```

The SDK supplies the default `base` template.
The paid suite checks Node and Python services together.
Custom templates must supply Python 3, Bash, and the `user` account with home `/home/user`.
Install application dependencies in the template or service command.
The provider does not synchronize local `node_modules`.

## Configuration

```json
{
  "provider": "e2b",
  "name": "sandbox-app",
  "e2b": {
    "template": "base",
    "timeoutSeconds": 300
  },
  "services": {
    "web": {
      "command": "npm ci && npm run dev -- --host 0.0.0.0",
      "port": 3000,
      "containerPort": 3000,
      "protocol": "http",
      "env": {
        "NODE_ENV": "development"
      }
    }
  }
}
```

`template` defaults to `base`.
`timeoutSeconds` defaults to 300 and accepts integers from 1 through 86400.
E2B account limits can impose a lower maximum.
The provider requests automatic pause at timeout, without automatic resume from network traffic.
Run `agent-env up` to resume an expired sandbox.
The provider does not maintain an indefinite lease.
Activity does not extend the lease. Configure enough time for the complete work session, such as 3600 seconds for an hour.
`run` and `exec` have no separate execution timeout, but the sandbox lease still applies.

Each service requires a nonempty `command` and a public `port`.
`containerPort` defaults to `port`.
`protocol` defaults to `http`.
Public ports and sandbox ports must each be distinct across services.
Public ports must be at least 1024.
Sandbox ports can range from 1 through 65535, except reserved ports.
The provider rejects E2B control ports 49983, 49999, and 50005.
The provider supplies `HOST=0.0.0.0` and `PORT=containerPort` as defaults.
`E2B_API_KEY` configures the provider. Other `E2B_` variable names are reserved and cause validation errors.
Service environment values can override those defaults.

Unsupported options fail before allocation.
These include service images, volumes, health commands, SSH targets, cloud targets, Compose, and raw TCP.
Forks, snapshots, restores, and external storage are unsupported.
HTTP services can also accept WebSocket upgrades through their configured port.

## Credentials and ingress

Set `E2B_API_KEY` in the process that invokes the CLI.
An E2B key in resolved `spec.env` takes precedence.
The resolver moves the key to `spec.e2b.credentials.apiKey` and `spec.sensitiveValues`.
It removes provider variables from shared and service environments.
It rejects service environment aliases or commands that contain the provider key.
Never print the resolved specification or private ownership records.

Every SDK request receives explicit credentials.
The implementation does not modify SDK defaults or `process.env`.
The sandbox uses `network.allowPublicTraffic=false`.
The provider refuses connections when E2B does not confirm private ingress.
It also requires a traffic token from the SDK.

Each local connection binds an ephemeral port on `127.0.0.1`.
The bridge sends the traffic token in an HTTPS request header.
WebSocket upgrades use the same bridge and authentication.
The daemon exposes its usual localhost addresses.
Tokens never appear in connection URLs or status output.
Control-plane errors omit SDK text that could contain private headers.
Connection disposal closes listeners, pending requests, and both sides of upgraded sockets.

## Ownership and persistence

The provider writes private records under `$AGENT_ENV_HOME/e2b`.
The directory uses mode `0700` and records use mode `0600`.
The record filename derives from the installation owner and instance name.
Each record binds the sandbox ID, owner, name, workspace/template hash, credential hash, and random ownership ID.
Ownership records contain no API key, resolved environment values, or complete specification.
The daemon stores the API key and resolved environment values as plaintext in `$AGENT_ENV_HOME/state.json`, with mode `0600`.
The sandbox metadata stores the provider, owner, name, and ownership ID.
Every connection, pause, purge, and operation checks the local record and remote metadata.
A mismatched credential cannot treat another account's missing sandbox as successful deletion.
Automatic API key rotation is unsupported for retained instances.
Purge instances with the old key before revoking it, or create new instances with the new key.
If the old key is already revoked, inspect and remove the owned sandboxes through the E2B console.
Keep private recovery records until you confirm removal. The CLI provides no command to migrate those records.
If `rm --all` stops at an invalid credential, remove other instances individually.

The provider writes allocation intent before the create request.
It sends the ownership ID as the SDK idempotency key.
If creation has an uncertain outcome, recovery searches both running and paused sandboxes by ownership metadata.
If that search returns no matches, a later `up` retries creation with the original idempotency key.
The provider refuses ambiguous recovery and preserves the private record.
Do not delete recovery records until you verify resource removal.

`stop(handle)` pauses the sandbox with its filesystem and memory.
`start(handle)` resumes the same sandbox and waits for the services.
Existing service processes retain their memory across a full pause.
Exited services restart when the instance starts.
`wait(handle)` checks existing compute and never intentionally resumes a paused sandbox.
`status(handle)` reports `running`, `created`, `exited`, `paused`, or `missing` for each service.
Status does not resume paused compute.

`remove(handle, false)` pauses compute and retains the record and data.
`create(spec)` recovers that record when a later `up` uses the same identity, checkout, and template.
An environment-only edit followed by `up` restarts affected services and retains sandbox files.
For command or service changes, use `rm NAME`, then `up` to reuse the sandbox with the new configuration.
Unchanged services retain their processes and memory.
`remove(handle, true)` verifies ownership, kills the sandbox, confirms absence, and removes the record.
Failed first starts attempt purge.
Failed resumes attempt pause.
Cleanup failures preserve records and report incomplete cleanup.
As checked on 2026-11-09, E2B retains paused sandboxes until explicit deletion.
See [E2B persistence](https://docs.e2b.dev/sandbox/persistence).
Compute billing stops while a sandbox is paused. See [E2B billing](https://docs.e2b.dev/billing) for current account terms.

The service supervisor stores stdout, stderr, and exit codes outside the source directory.
`logs` returns the latest 64 KiB from each stream.
Changing a service configuration clears its previous logs before restart, so old secret values cannot escape the new redaction rules.
`exec` quotes each argument and preserves command exit codes.
Use an explicit `sh -c` when shell interpretation is required.
Application output receives credential redaction before the provider returns it.
Logs and exec require running compute.

## Source synchronization

The checkout resides at `/home/user/.agent-env/<ownership-id>/workspace`.
Runtime files and service logs occupy the adjacent `runtime` directory.
Sync applies the existing `shouldSync` policy.
It excludes `.git`, `node_modules`, `.agent-env`, environment files, and root build/cache directories.
It also excludes common credential files, configured environment files, symbolic links, and special files.
Files that contain known sensitive values do not transfer.
The remote sync manifest tracks only files that this provider transferred.
Sync removes vanished source files, while preserving generated files that the manifest does not own.
Remote destination paths cannot contain symbolic links.

Sync reads regular files and uploads one JSON payload with base64 file data.
Each sync uploads every eligible source file, including files whose content did not change.
The remote writer preserves unchanged content and modification times.
It preserves executable permission bits.
This simple implementation buffers the payload in memory.
Large checkouts can therefore require substantial client and sandbox memory.
Build-directory exclusions apply at the checkout root. Nested generated directories can still transfer.
Concurrent source edits can require another sync.
Generated dependencies remain inside the sandbox between syncs.

The daemon watches E2B checkouts automatically when the instance runs.
Local file additions, edits, and deletions trigger source synchronization.
The application controls code reload behavior inside the sandbox.
Use a development server or application watcher when code changes require a process reload.
`agent-env list` reports `watching` or a synchronization error.

Use `agent-env up --no-watch` when creating an instance that requires manual synchronization.
The flag applies to the specification saved by that invocation.
`agent-env list` then reports `manual`.
Run `agent-env sync NAME` to copy edits and deletions explicitly.
For an existing saved instance, retain its data with `rm`, then recreate its handle with `up --no-watch`.

## Project commands

E2B supports named project commands.
Add a `commands` object to `agent-env.json`:

```json
{
  "commands": {
    "typecheck": "npm run typecheck",
    "node-version": ["node", "--version"],
    "test": { "service": "web", "command": ["npm", "run", "test:e2e", "--"] }
  }
}
```

```sh
agent-env run sandbox-app typecheck
agent-env run sandbox-app node-version
agent-env run sandbox-app test -- --headed
```

Definitions can contain a shell string, an argument array, or an object with `service` and `command`.
An unspecified service defaults to the primary service or first configured service.
The daemon sends the command to `E2BProvider.exec`.
The command uses the synchronized workspace and selected service environment.
Argument arrays preserve literal arguments.
Shell strings must reference `$1` or `"$@"` to consume extra arguments.
Command failures preserve stdout, stderr, and the exit code.

## Paid E2E verification

The test requires an installed CLI, real E2B credentials, and explicit billing authorization.
It does not import the provider or use simulated providers.
All lifecycle, service, sync, log, exec, and project command actions invoke the installed CLI.
SDK reads verify private ingress, ownership metadata, pause state, and resource absence.
The test creates isolated names, ports, source files, and state.
It preserves its recovery directory if cleanup fails.

Install the candidate package into an isolated prefix:

```sh
task_prefix=$(mktemp -d /tmp/agent-env-e2b-install-XXXXXX)
npm pack --pack-destination "$task_prefix"
npm install --prefix "$task_prefix" --no-audit --no-fund "$task_prefix/"*.tgz
if AGENT_ENV_CLI="$task_prefix/node_modules/.bin/agent-env" \
  AGENT_ENV_TEST_E2B=1 node test/e2b.e2e.mjs
then
  rm -rf -- "$task_prefix"
fi
```

Supply `E2B_API_KEY` through the existing shell environment.
Do not place its value in the command, fixture, or test report.
Do not delete the installation prefix if the test reports incomplete cleanup.

The suite covers Node and Python services in one sandbox, private HTTP, WebSockets, automatic source changes, automatic deletion, and credential exclusions.
It also checks `--no-watch` and manual synchronization for edits, additions, and deletions.
Project command coverage includes shell strings, literal argument arrays, explicit service selection, and nonzero exit codes.
The suite checks exec quoting, exec failure codes, stdout/stderr, service logs, pause/resume memory, filesystem persistence, and daemon reconnection.
It also checks ownership rejection, nonpurge recovery, failed-start cleanup, and purge.

Static verification commands:

```sh
node --check src/providers/e2b.mjs
node --check test/e2b.e2e.mjs
npm run check
node test/e2b.e2e.mjs
git diff --check
```

Without `AGENT_ENV_TEST_E2B=1`, the last test command reports a skip and performs no E2B operations.
The Agent Swarm example uses Docker Compose. It is not an E2B configuration.
See [provider verification](providers-verification.md) for the completed live E2B and local application checks.
This task did not change that example or claim E2B coverage for it.

Official references: [SDK package](https://www.npmjs.com/package/e2b/v/2.63.0),
[private ingress](https://docs.e2b.dev/network/restrict-public-access),
[sandbox persistence](https://docs.e2b.dev/sandbox/persistence),
and [HTTP ingress](https://docs.e2b.dev/network/public-url).
