<img src="assets/icon.svg" width="64" height="64" alt="">

# dev-now

Run a development stack locally, over SSH, or on an on-demand Hetzner machine. Open each instance through localhost.

The CLI uses Node 22+, Docker, and a local routing daemon. It has no npm dependencies.
[Tesser](https://tesser.sh/) inspired the workflow. [Portless](https://github.com/vercel-labs/portless) informed the shared HTTPS proxy and local certificate authority.

## Start

```sh
npm link --ignore-scripts --no-audit --no-fund
cd /path/to/project
dev-now init
dev-now up --name app --https
dev-now ui
```

`init` detects Compose files, package scripts, package managers, and common framework ports.
It never replaces an existing configuration or edits package scripts.
For an unknown project, supply a command:

```sh
dev-now init --port 3000 --image node:22-bookworm-slim -- node server.js
```

For the included example:

```sh
cd examples/hello
dev-now up --name demo
```

Open `http://demo.localhost:3300`. The example also provides Postgres on `localhost:55432` with development-only credentials.

## Local and remote

```sh
dev-now up --name local --local
dev-now up --name remote --ssh user@server
dev-now use remote
```

Both instances retain named addresses, such as `local.localhost:3000` and `remote.localhost:3000`.
`use` selects the instance behind bare `localhost:3000` and raw TCP ports.
A selection change closes existing connections that used bare localhost. Named HTTP connections remain separate.

SSH targets need Docker, rsync, Bash, and `timeout`. The local machine needs SSH and rsync.
Use an SSH alias or `--ssh-config FILE` for keys and ports. Existing SSH hosts require verified host keys.

Remote source synchronization starts automatically and follows file edits. Use `--no-watch` for manual synchronization.
`dev-now sync remote` synchronizes immediately. The daemon reconnects failed SSH tunnels with bounded retry intervals.
Synchronization excludes Git metadata, dependencies, common build directories, `.dev-now`, and `.env*` files.
Keep other credentials outside the source tree. Explicit Compose secret files use a separate private transfer.

## Compose

Existing `compose.yaml`, `compose.yml`, and `docker-compose.*` files work directly, without `init`.

```sh
dev-now up --name app --profile tools
dev-now up --name remote --compose-file compose.yaml --compose-file compose.dev.yaml --ssh my-host
```

The provider preserves builds, dependencies, health checks, profiles, networks, and named volumes.
Each instance receives isolated names and loopback backend ports. Original Compose files remain unchanged.
Internal services remain internal. External volumes and networks survive removal and purge.

Multiple published ports on one service require explicit aliases in `compose.routes`.
UDP, replicas, host namespaces, custom network allocation, and some deployment features return explicit unsupported-feature errors.
Remote bind and build paths must remain inside the checkout.
See the [Compose example and contract](examples/compose/README.md).

## Environments and secrets

```sh
dev-now env set POSTGRES_PASSWORD --from-env MY_DATABASE_PASSWORD
# Or: dev-now env set POSTGRES_PASSWORD < /path/to/private/password-file
dev-now env list
dev-now env unset POSTGRES_PASSWORD
```

Secret commands accept `--env NAME`. Values stay in a private store outside the checkout.
The CLI prints secret names only.
Logs and execution output redact private store values, secret references, environment references, and values from environment files.
Credential names such as `PASSWORD`, `TOKEN`, and `API_KEY` also trigger redaction. Ordinary literal ports, hosts, and database names remain readable.

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
dev-now env set POSTGRES_PASSWORD --env review --from-env MY_DATABASE_PASSWORD
dev-now up --env review --name review
```

Values can be strings, `{ "secret": "KEY" }`, or `{ "env": "SHELL_VARIABLE" }`.
Repeated `--env-file FILE` options select explicit environment files.
Native Docker environment files contain literal values. Compose retains its own interpolation rules.
Compose container variables still follow each service's `environment` configuration.

## Services and caching

```sh
dev-now add postgres
dev-now add redis
dev-now up
```

Postgres defaults to public port 55432. Redis defaults to 56379. Use `--port` to select another port.
Both services retain data in named volumes. Postgres receives a generated password in the private environment store.
Compose projects receive a separate `dev-now.addons.json` override.
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
dev-now up --name cloud --cloud hetzner --location hel1
dev-now down cloud
dev-now up cloud
dev-now rm cloud --purge
```

The CLI provisions Docker and Compose, generates dedicated SSH credentials, and pins the host identity before connecting.
Ownership records and labels protect unrelated machines, keys, and IP addresses.
`down` stops containers and powers off an otherwise unused owned machine. Its disk remains available for resume.
Powered-off Hetzner machines still incur charges. `rm --purge` deletes the last instance's owned machine, IP, key, and data.
A plain `rm` retains the cloud record so `list`, resume, and later purge remain available.
Forks share their source machine. Removing one fork preserves other instances on that machine.

The default idle timeout is 30 minutes. Use `--idle-minutes 0` to disable it.
Machine and lifecycle flags require `--cloud hetzner` or a configured cloud provider.
An explicit `--ssh` or `--local` target overrides a configured cloud target.
HTTP requests, WebSocket traffic, TCP traffic, source synchronization, and explicit service commands record activity.
Use `--ttl-hours N` for an explicit destructive expiry.
**Idle shutdown and expiry require the local daemon to remain running and connected.** They are not cloud-side schedules.
Keep the same `hcloud` context for a machine's lifecycle.

## Forks and snapshots

Stop the source before copying database volumes:

```sh
dev-now down app
dev-now fork app experiment --worktree ../experiment --branch experiment
```

This creates a Git worktree, copies current source changes, copies volumes, and starts the fork.
Credentials and generated files are excluded from copied changes. The source remains unchanged.
Without `--worktree`, `--branch`, or `--ref`, `fork` copies data and uses the existing source checkout.
Forks require a new destination name and run on the source Docker host.

Resume a saved fork from any directory:

```sh
dev-now down experiment
dev-now up experiment
```

`up NAME` uses the saved configuration, including resolved secrets and the source path.
`up --name NAME` loads the current project's configuration and checks it against the saved instance.

```sh
dev-now snapshot app /existing/backups/checkpoint
dev-now restore /existing/backups/checkpoint --name restored

dev-now snapshot app s3://my-bucket/checkpoint
dev-now restore s3://my-bucket/checkpoint --name restored --ssh my-host
```

Restore uses the current project's configuration and creates fresh volumes before starting services.
It verifies archive hashes and extraction paths. It refuses existing destination volumes.
Snapshots contain named volume data. Source files require Git or another backup procedure.
Unsupported or shared mounts cause an error. `--omit-mounts` explicitly excludes them and reports each omission.

S3 uses the installed AWS CLI and its normal credentials. `--endpoint URL` selects compatible storage.
Each snapshot needs a new prefix. Conditional writes prevent overwrites, and the manifest uploads last.
A failed upload can leave partial objects for manual inspection. Export uses single-object uploads, limited to 5 GB per volume on AWS S3.
Archives require temporary local disk space. S3 stores backups, while running databases use Docker volumes.
See [snapshot format and worktree ownership](docs/snapshots-and-worktrees.md).

## HTTPS and status UI

```sh
dev-now https --https-port 8443
dev-now trust
dev-now ui --port 4780
```

HTTPS uses a private local CA and one loopback proxy. HTTP/2, HTTP/1.1, and WebSocket upgrades are supported.
The primary HTTP service uses `https://app.localhost:8443`.
Other HTTP services use `https://app--SERVICE.localhost:8443`.
`up --https` enables the proxy during startup.

`trust` explicitly installs the CA in the macOS user keychain or a Debian-based Linux trust store.
Linux trust installation requires sudo permission. Some browsers and runtimes maintain separate trust stores.
For curl without OS trust installation:

```sh
curl --cacert ~/.local/state/dev-now/tls/ca.pem \
  --resolve app.localhost:8443:127.0.0.1 https://app.localhost:8443/
```

The dashboard displays instances, service health, addresses, synchronization state, and redacted logs.
Automatic refresh is optional and persists in browser storage. The dashboard accepts local read-only requests.
Application pages contain no injected browser controls.

## Lifecycle and provider boundaries

```sh
dev-now list
dev-now logs app --service web
dev-now exec app --service postgres -- psql -U postgres -d app -c 'select 1'
dev-now down app
dev-now rm app --purge
dev-now daemon stop
```

`down` retains containers and data. `rm` removes containers and retains volumes. `rm --purge` also removes managed volumes.
For a removed local instance, recreate it with `up` before purging its retained volumes.
Configuration changes require `rm`, then `up`.
`daemon stop` stops routing, synchronization, and lifecycle timers. Containers remain running.
The next command restores saved routing and enabled UI/HTTPS listeners.

Worktrees remain after instance removal by default.
`rm NAME --remove-worktree` removes an owned clean worktree.
Add `--discard-worktree` only when you intend to discard its changed and ignored files.

State defaults to `~/.local/state/dev-now`. `DEV_NOW_HOME` selects an isolated private state directory.
State can contain environment values. Back up cloud ownership records and credentials before moving it.
All application ports bind loopback. Remote traffic travels through SSH.

The [sandbox adapter contract](src/providers/CLOUD_SANDBOX.md) accepts trusted local ESM adapters with explicit capabilities.
Use `--provider sandbox --adapter docker` for the included bridge.
No hosted sandbox vendor or Firecracker runtime is bundled. Those require separate adapters.
Firecracker requires a Linux host with KVM access, a guest kernel, root filesystem, and guest networking.
See [Firecracker's host requirements](https://github.com/firecracker-microvm/firecracker/blob/main/docs/getting-started.md).

## Verification

```sh
npm run check
npm test
npm run test:e2e
npm run test:runtime
npm run test:features
DEV_NOW_TEST_SSH=my-host DEV_NOW_TEST_SSH_CONFIG=/path/to/config npm run test:features
```

Tests create isolated resources and remove them afterward. SSH tests use an existing host without provisioning or deleting it.
See [verification evidence](VERIFICATION.md) for completed local, remote, S3, cloud, and UI checks.
