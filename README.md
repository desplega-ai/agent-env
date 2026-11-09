<img src="assets/icon.svg" width="64" height="64" alt="agent-env Workspace logo">

# agent-env

Run a development stack locally, over SSH, or on an on-demand Hetzner machine. Open each instance through localhost.

Part of [Desplega Labs](https://desplega.sh), alongside [Agent Swarm](https://github.com/desplega-ai/agent-swarm) and [agent-fs](https://github.com/desplega-ai/agent-fs).
Released under the [MIT license](LICENSE).

The CLI runs on macOS or Linux with Node 22.19+ and a local routing daemon.
Docker and Dev Container providers need Docker. The E2B provider needs an E2B account and API key.
[Tesser](https://tesser.sh/) inspired the workflow. [Portless](https://github.com/vercel-labs/portless) informed the shared HTTPS proxy and local certificate authority.

## Start

Install the published package:

```sh
npm install -g @desplega.ai/agent-env
```

For a source checkout, run `npm link --ignore-scripts --no-audit --no-fund` in this repository instead.

Read the bundled [agent skill](https://github.com/desplega-ai/agent-env/blob/master/skills/agent-env/SKILL.md) or install it into a project:

```sh
agent-env skill
agent-env skill install
agent-env skill install --agent codex --yes
```

`skill` prints the complete guide offline. Add `--json` for structured output.
`skill install` runs the skills installer with files bundled in your CLI version.
To install the latest guide directly from GitHub instead:

```sh
npx skills add desplega-ai/agent-env --skill agent-env
```

The skills installer requires Node.js 22.20 or later and lets you choose your coding agents.
Add `--agent codex` or `--agent claude-code` to select one explicitly.
Add `-g` for installation across projects. The skill teaches CLI usage and does not install the CLI or Docker.
It covers local services, Compose, dotenv, SSH, HTTPS, persistent data, and troubleshooting.

```sh
cd /path/to/project
agent-env init
agent-env up --name app --https
agent-env ui
```

`init` detects Dev Containers, Compose files, package scripts, package managers, and common framework ports.
It never replaces an existing configuration or edits package scripts.
For a first dependency installation, use `agent-env up --timeout 900` or set `startupTimeoutSeconds` in `agent-env.json`.
Compose builds and image downloads finish before its shared readiness timeout begins.
For an unknown project, supply a command:

```sh
agent-env init --port 3000 --image node:22-bookworm-slim -- node server.js
```

For the included example:

```sh
cd examples/hello
agent-env up --name demo
```

Open `http://demo.localhost:3300`. The example also provides Postgres on `localhost:55432` with development-only credentials.

For a full application, use the [Agent Swarm development example](docs/agent-swarm.md).

## Local and remote

```sh
agent-env up --name local --local
agent-env up --name remote --ssh user@server
agent-env use remote
```

Both instances retain named addresses, such as `local.localhost:3000` and `remote.localhost:3000`.
`use` selects the instance behind bare `localhost:3000` and raw TCP ports.
A selection change closes existing connections that used bare localhost. Named HTTP connections remain separate.

SSH targets need Docker, rsync, Bash, and `timeout`. The local machine needs SSH and rsync.
Native SSH mode can run inside a Swarm worker without local Docker.
Compose mode also needs the Docker CLI and Compose plugin on the worker to resolve configuration, even with an SSH target.
Local mode needs access to a running Docker engine. New local starts check these prerequisites before creating a routing daemon.
Localhost addresses belong to the machine or worker running `agent-env`, not automatically to your laptop.
Use an SSH alias or `--ssh-config FILE` for keys and ports. Existing SSH hosts require verified host keys.

Remote source synchronization starts automatically and follows file edits. Use `--no-watch` for manual synchronization.
`agent-env sync remote` synchronizes immediately. The daemon reconnects failed SSH tunnels with bounded retry intervals.
Synchronization excludes Git metadata, dependencies, common build directories, `.agent-env`, and `.env*` files.
Generated directories such as `build` and `dist` are excluded at the checkout root. Nested source paths such as `src/build` remain available.
Remote Compose validates bind mounts, build contexts, and Dockerfiles against the same rules.
Keep other credentials outside the source tree. Explicit Compose secret files use a separate private transfer.

## Compose

Existing `compose.yaml`, `compose.yml`, and `docker-compose.*` files work directly, without `init`.

```sh
agent-env up --name app --profile tools
agent-env up --name remote --compose-file compose.yaml --compose-file compose.dev.yaml --ssh my-host
```

The provider preserves builds, dependencies, health checks, profiles, networks, and named volumes.
Each instance receives isolated names and loopback backend ports. Original Compose files remain unchanged.
Internal services remain internal. External volumes and networks survive removal and purge.

Multiple published ports on one service require explicit aliases in `compose.routes`.
UDP, replicas, host namespaces, custom network allocation, and some deployment features return explicit unsupported-feature errors.
Remote bind and build paths must remain inside the checkout.
See the [Compose example and contract](examples/compose/README.md).

## E2B and Dev Containers

The built-in `e2b` provider runs service commands inside one managed sandbox.
It requires Node 22.19+ and an `E2B_API_KEY` from your shell, env file, or private store.
Provider credentials stay outside service environments.

```json
{
  "provider": "e2b",
  "e2b": { "template": "base", "timeoutSeconds": 600 },
  "services": {
    "web": { "port": 3000, "command": "node --watch server.js" }
  }
}
```

Run `agent-env up --name review` with this configuration.
The provider creates private ingress and maps HTTP and WebSockets to localhost.
`down` pauses the sandbox. `up review` resumes it. `rm review --purge` destroys it.
See [E2B configuration and limitations](docs/e2b.md).

Existing `.devcontainer/devcontainer.json` and `.devcontainer.json` files work directly with `up`.
Automatic detection preserves Compose priority when both configurations exist.
Select `--provider devcontainer` to use the Dev Container explicitly.
Use `--provider compose` to select Compose explicitly.
Dev Containers support images, Dockerfiles, Compose, native lifecycle hooks, and `forwardPorts` through the official CLI.
This provider currently requires local Docker.
See [Dev Container routes, isolation, and examples](docs/devcontainers.md).

## Project commands

Declare repeatable operations in `agent-env.json`:

```json
{
  "commands": {
    "install": ["npm", "ci"],
    "migrate": { "service": "api", "command": ["npm", "run", "migrate"] },
    "seed": "npm run seed -- \"$@\"",
    "test": ["npm", "test"],
    "reset": ["npm", "run", "db:reset"]
  }
}
```

These entries extend your existing provider and service configuration.
Commands run only when requested, inside a running service:

```sh
agent-env run app install
agent-env run app migrate
agent-env run app seed -- demo
agent-env run app test -- --runInBand
```

Argument arrays execute directly. Extra CLI arguments append to the array.
Shell strings run through `sh -c`. Extra arguments are available through `"$@"`.
The E2B SDK adds an outer Bash login shell.
Commands use their configured service, the Dev Container workspace, or the first service.
Use `--service NAME` to select another service explicitly.
Failures preserve the command's exit code and redact private values.
`list --json` includes command names without command contents.
Environment overlays can override individual commands.
After editing commands, run `up --name NAME` to update the saved definitions without replacing containers.
`run` and `exec` do not block status, logs, synchronization, or operations on other instances.
The CLI waits without a command timeout. Output arrives when the command finishes.
Stopping or removing an instance can interrupt commands that use it.
E2B's configured sandbox lease still limits runtime, independently of command execution.

## Source updates

Local Docker and image/Dockerfile Dev Containers mount the checkout directly.
Compose, including Dev Container Compose configurations, exposes source through the bind mounts declared in its files.
SSH and E2B automatically synchronize source changes while the daemon runs.
Use `--no-watch` to disable automatic synchronization, or `sync NAME` to synchronize explicitly.
Synchronization excludes environment files, dependency directories, and configured build outputs.
E2B also excludes common credential files and files containing known secret values.
An application watcher, such as Vite or `node --watch`, must reload the changed source.
Services without a watcher require `down NAME`, then `up NAME`.
Source synchronization does not reload environment variables.

## Environments and secrets

`agent-env up` reads `.env` and `.env.local` automatically when those files exist.
`agent-env up --env review` also reads `.env.review` and `.env.review.local`, in that order.
A named dotenv file can define an environment without a JSON overlay.
Files with names such as `.env.example` never load automatically.

```sh
agent-env up                         # Uses the project's dotenv files
agent-env up --env review            # Adds the review dotenv files
agent-env up --env-file .env.custom  # Replaces automatic file selection
agent-env up --no-env-file           # Disables global dotenv files
```

For native Docker services, later files override earlier files.
Private stored values override files, configuration values override the private store, and service values override the project configuration.
Native Docker treats file values literally. It never executes shell commands or expands `${VARIABLE}` expressions.
The parent shell enters native containers only through explicit `{ "env": "NAME" }` references.

Compose keeps its own interpolation rules and shell precedence.
Private stored values and explicit project configuration override the Compose interpolation environment.
Each Compose service still declares its container variables with `environment` or `env_file`.
`--no-env-file` disables global dotenv files. It does not disable service `env_file` declarations.

Environment files stay outside remote source synchronization.
The CLI resolves values locally and sends the required container configuration over SSH.
Saved instances retain their resolved values. Use `up --name NAME` to load edited files, or `up NAME` to resume saved values.
For Docker and Compose, environment-only changes recreate containers and retain their named volumes.
Use `up NAME --timeout 900` to increase the startup timeout of a saved instance.

```sh
agent-env env set POSTGRES_PASSWORD --from-env MY_DATABASE_PASSWORD
# Or: agent-env env set POSTGRES_PASSWORD < /path/to/private/password-file
agent-env env list
agent-env env unset POSTGRES_PASSWORD
```

Secret commands accept `--env NAME`. Values stay in a private store outside the checkout.
The CLI prints secret names only.
Logs and execution output redact private store values, secret references, and explicit environment references.
Credential names such as `PASSWORD`, `TOKEN`, and `API_KEY` also trigger redaction, including values loaded from dotenv files.
Credential URLs and common token formats also trigger redaction. Ordinary ports, hosts, modes, and database names remain readable.
Store secrets with unusual variable names in the private store, or use an explicit secret reference.

```json
{
  "provider": "compose",
  "compose": { "files": ["compose.yaml"] },
  "environments": {
    "review": {
      "envFiles": [".env.review"],
      "env": { "POSTGRES_PASSWORD": { "secret": "POSTGRES_PASSWORD" } },
      "compose": { "profiles": ["tools"] }
    }
  }
}
```

```sh
agent-env env set POSTGRES_PASSWORD --env review --from-env MY_DATABASE_PASSWORD
agent-env up --env review --name review
```

Values can be strings, `{ "secret": "KEY" }`, or `{ "env": "SHELL_VARIABLE" }`.
Repeated `--env-file FILE` options select explicit environment files.
Set `envFiles: []` in `agent-env.json` to disable automatic dotenv files for that configuration.

## Services and caching

```sh
agent-env add postgres
agent-env add redis
agent-env up
```

Postgres defaults to public port 55432. Redis defaults to 56379. Use `--port` to select another port.
Both services retain data in named volumes. Postgres receives a generated password in the private environment store.
Compose projects receive a separate `agent-env.addons.json` override.
Use `add postgres --env review` to add the service and its secret only to the `review` environment.
Compose uses a separate override file for each selected environment.

Native Docker projects use this format:

```json
{
  "services": {
    "web": {
      "image": "node:22-bookworm-slim",
      "port": 3000,
      "command": "npm ci && npm run dev -- --host 0.0.0.0",
      "volumes": { "dependencies": "/workspace/node_modules", "cache": "/root/.npm" }
    }
  }
}
```

The checkout appears at `/workspace`. `containerPort` defaults to `port`.
Processes must listen on `0.0.0.0`. The runtime sets `HOST` and `PORT` for native Docker services.
Services reach each other by service name on the instance network.
Named volumes retain dependencies and package caches. Docker retains build and image caches.

## Hetzner

Authenticate the installed `hcloud` CLI, then run:

```sh
agent-env up --name cloud --cloud hetzner --location hel1
agent-env down cloud
agent-env up cloud
agent-env rm cloud --purge
```

The CLI provisions Docker and Compose, generates dedicated SSH credentials, and pins the host identity before connecting.
Ownership records and labels protect unrelated machines, keys, and IP addresses.
Each record also binds to the active hcloud context, API endpoint, and a fingerprint of its credential.
Changed settings stop cloud operations before resource access. Local keys and ownership records remain available for recovery.
Older records without this binding require manual recovery in Hetzner. The CLI preserves their local keys.
`down` stops containers and powers off an otherwise unused owned machine. Its disk remains available for resume.
Powered-off Hetzner machines still incur charges. `rm --purge` deletes the last instance's owned machine, IP, key, and data.
A plain `rm` retains the cloud record so `list`, resume, and later purge remain available.
Forks share their source machine. Removing one fork preserves other instances on that machine.

The default idle timeout is 30 minutes. Use `--idle-minutes 0` to disable it.
Machine and lifecycle flags require `--cloud hetzner` or a configured cloud provider.
An explicit `--ssh` or `--local` target overrides a configured cloud target.
HTTP requests, WebSocket traffic, TCP traffic, source synchronization, and explicit service commands record activity.
Use `--ttl-hours N` for an explicit destructive expiry.
Expiry deletes the shared machine and every instance on it, including sleeping forks. It does not wake the machine.
Failed idle and expiry actions use bounded retry delays.
**Idle shutdown and expiry require the local daemon to remain running and connected.** They are not cloud-side schedules.
Keep the same `hcloud` context and credential for a machine's lifecycle.
The CLI reads effective settings through [hcloud config](https://github.com/hetznercloud/cli/blob/main/docs/reference/manual/hcloud_config_get.md).

## Forks and snapshots

Stop the source before copying database volumes:

```sh
agent-env down app
agent-env fork app experiment --worktree ../experiment --branch experiment
```

This creates a Git worktree, copies current source changes, copies volumes, and starts the fork.
Credentials and generated files are excluded from copied changes. The source remains unchanged.
Without `--worktree`, `--branch`, or `--ref`, `fork` copies data and uses the existing source checkout.
Forks require a new destination name and run on the source Docker host.

Resume a saved fork from any directory:

```sh
agent-env down experiment
agent-env up experiment
```

`up NAME` uses the saved configuration, including resolved secrets and the source path.
`up --name NAME` loads the current project's configuration and checks it against the saved instance.

```sh
agent-env snapshot app /existing/backups/checkpoint
agent-env restore /existing/backups/checkpoint --name restored

agent-env snapshot app s3://my-bucket/checkpoint
agent-env restore s3://my-bucket/checkpoint --name restored --ssh my-host
```

Restore uses the current project's configuration and creates fresh volumes before starting services.
It verifies archive hashes and extraction paths. It refuses existing destination volumes.
Snapshots contain named volume data. Source files require Git or another backup procedure.
Compose anonymous volumes require a separate backup or explicit omission. Snapshot export rejects them before archive creation.
Unsupported or shared mounts cause an error. `--omit-mounts` explicitly excludes them and reports each omission.

S3 uses the installed AWS CLI and its normal credentials. `--endpoint URL` selects compatible storage.
Each snapshot needs a new prefix. Conditional writes prevent overwrites, and the manifest uploads last.
A failed upload can leave partial objects for manual inspection. Export uses single-object uploads, limited to 5 GB per volume on AWS S3.
Archives require temporary local disk space. S3 stores backups, while running databases use Docker volumes.
See [snapshot format and worktree ownership](docs/snapshots-and-worktrees.md).

## HTTPS and status UI

```sh
agent-env https --https-port 8443
agent-env trust
agent-env ui --port 4780
```

HTTPS uses a private local CA and one loopback proxy. HTTP/2, HTTP/1.1, and WebSocket upgrades are supported.
The primary HTTP service uses `https://app.localhost:8443`.
Other HTTP services use `https://app--SERVICE.localhost:8443`.
`up --https` enables the proxy during startup.

`trust` explicitly installs the CA in the macOS user keychain or a Debian-based Linux trust store.
Certificate generation uses a process lock. New certificate authorities restrict signing to localhost names and loopback addresses.
Linux trust installation requires sudo permission. Some browsers and runtimes maintain separate trust stores.
For curl without OS trust installation:

```sh
curl --cacert ~/.local/state/agent-env/tls/ca.pem \
  --resolve app.localhost:8443:127.0.0.1 https://app.localhost:8443/
```

The dashboard displays instances, service health, addresses, synchronization state, and redacted logs.
Automatic refresh is optional and persists in browser storage. The dashboard accepts local read-only requests.
Application pages contain no injected browser controls.

## Lifecycle and provider boundaries

```sh
agent-env list
agent-env logs app --service web
agent-env exec app --service postgres -- psql -U postgres -d app -c 'select 1'
agent-env down app
agent-env rm app --purge
agent-env daemon stop
```

`down` retains containers and data. `rm` removes containers and retains volumes and built images.
`rm --purge` also removes managed volumes and the instance's owned Compose image tags.
Shared base images and Docker build caches remain available.
For a removed local instance, recreate it with `up` before purging its retained volumes.
Changes to ports, images, service startup commands, mounts, or providers require `rm`, then `up`.
Environment-only changes for Docker and Compose use `up --name NAME` and preserve volumes.
`daemon stop` stops routing, synchronization, and lifecycle timers. Containers remain running.
The next command restores saved routing and enabled UI/HTTPS listeners.

Worktrees remain after instance removal by default.
`rm NAME --remove-worktree` removes an owned clean worktree.
Add `--discard-worktree` only when you intend to discard its changed and ignored files.

State defaults to `~/.local/state/agent-env`. `AGENT_ENV_HOME` selects an isolated private state directory.
State can contain environment values. Back up cloud ownership records and credentials before moving it.
All local application ports bind loopback. Remote traffic travels through SSH or E2B's authenticated HTTPS ingress.

The [sandbox adapter contract](src/providers/CLOUD_SANDBOX.md) accepts trusted local ESM adapters with explicit capabilities.
Use `--provider sandbox --adapter docker` for the included bridge.
E2B is bundled as a provider. Other hosted sandbox vendors and Firecracker require separate adapters.
Firecracker requires a Linux host with KVM access, a guest kernel, root filesystem, and guest networking.
See [Firecracker's host requirements](https://github.com/firecracker-microvm/firecracker/blob/main/docs/getting-started.md).

## Verification

```sh
npm run check
npm test
npm run test:e2e
npm run test:runtime
npm run test:features
AGENT_ENV_TEST_SSH=my-host AGENT_ENV_TEST_SSH_CONFIG=/path/to/config npm run test:features
# Creates and deletes one billed Hetzner machine:
AGENT_ENV_TEST_CLOUD=1 npm run test:cloud
```

Tests create isolated resources and remove them afterward. SSH tests use an existing host without provisioning or deleting it.
The explicit cloud test provisions a temporary machine and verifies credential protection, source sync, fork recreation, sleeping expiry, and resource deletion.
See [verification evidence](VERIFICATION.md) for completed local, remote, S3, cloud, and UI checks.
