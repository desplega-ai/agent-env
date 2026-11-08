<img src="assets/icon.svg" width="64" height="64" alt="">

# dev-now

Run development stacks locally or on an SSH host. Open either at a stable localhost address.

A dependency-free Node CLI inspired by [Tesser](https://tesser.sh/docs/reference/localhost).
Docker supplies isolated containers, networks, persistent volumes, and image caching.
A local daemon routes HTTP, WebSockets, and TCP through loopback addresses.

Requires Node 22+. Local stacks require Docker. SSH operation requires local `ssh` and `rsync`. Remote hosts need Docker, SSH, rsync, Bash, and `timeout`.
macOS and Linux are supported. The remote user must have permission to use Docker.

## Try it

From this checkout:

```sh
npm link --ignore-scripts --no-audit --no-fund
cd examples/hello
dev-now up --name demo
```

Open `http://demo.localhost:3300` or `http://localhost:3300`.
The example also starts Postgres at `localhost:55432`, with database `app`, user `postgres`, and password `dev-only`.
These credentials are for the example only.

Run the same stack remotely:

```sh
dev-now up --name remote --ssh user@server
dev-now use remote
```

Open `http://remote.localhost:3300`. `localhost:3300` now selects the remote instance.
The local instance remains accessible at `http://demo.localhost:3300`.

An SSH alias can supply the user, key, and port. The CLI reuses SSH connections within its own state directory.
Use `--ssh-config /path/to/config` for a separate SSH configuration.
Complete SSH host verification before the first command. The CLI does not request passwords.

## Your project

```sh
cd /path/to/project
dev-now init
# Edit dev-now.json to select your image and command.
dev-now up
```

Without an explicit name, the CLI derives a name from the checkout path.
Separate Git worktrees therefore receive separate instances.
Each instance has its own network, database volumes, and dependency caches.

For one command without a configuration file:

```sh
dev-now up --name api --port 3000 --image node:22-bookworm-slim -- node server.js
```

The process must listen on `0.0.0.0`, not container loopback.
The CLI sets `HOST=0.0.0.0` and `PORT` to the container port.
Your program must honor these values or configure its listener directly.

```json
{
  "services": {
    "web": {
      "image": "node:22-bookworm-slim",
      "port": 3000,
      "command": "npm install && npm run dev",
      "env": { "DATABASE_URL": "postgres://postgres:dev-only@db:5432/app" },
      "volumes": {
        "dependencies": "/workspace/node_modules",
        "cache": "/root/.npm"
      }
    },
    "db": {
      "image": "postgres:16-alpine",
      "port": 5432,
      "protocol": "tcp",
      "health": "pg_isready -U postgres",
      "env": { "POSTGRES_PASSWORD": "dev-only", "POSTGRES_DB": "app" },
      "volumes": { "data": "/var/lib/postgresql/data" }
    }
  }
}
```

`containerPort` defaults to `port`. Use it when the public and container ports differ.
Services reach each other by service name, such as `db:5432`, on the instance network.
Services start before readiness checks. Applications should retry connections while dependencies start.
`health` adds an optional command inside the container. HTTP services must also return an HTTP response.
TCP services receive a connection check unless you supply `health`.

Images provide their own runtimes. For Bun, select a Bun image and its cache path.
Named volumes preserve installed dependencies and package caches across restarts.
Images remain in Docker's image cache. The CLI never prunes shared caches.

## Commands

```sh
dev-now list
dev-now use demo
dev-now logs demo --service web
dev-now exec demo --service db -- psql -U postgres -d app -c 'select 1'
dev-now sync remote
dev-now down demo
dev-now fork demo experiment
dev-now rm experiment --purge
dev-now down --all
dev-now daemon stop
```

`up` starts or resumes a stack and waits for readiness.
The first instance on a port becomes its default. Use `use NAME` to change that selection.
A repeated `up` preserves the selection and restores SSH connections.
A configuration change requires `rm NAME`, then `up`. The default `rm` retains volumes.

`down` stops containers and retains their data. `rm` removes containers and networks.
`rm --purge` also deletes that instance's volumes.
After a plain `rm`, recreate the instance with `up` before using `rm --purge` to delete its retained volumes. `--all` applies to all registered instances in this CLI's state directory.
`daemon stop` stops local routing and SSH tunnels. It leaves containers running.
The next command starts routing again and restores saved selections.

`fork` requires a stopped source. It copies volumes and starts an independent instance on the same Docker host.
It refuses destination volumes that already exist. Database writes in the fork do not affect the source.
Forks copy data, not Git branches. Local forks share the source checkout unless you create a separate worktree.
Remote forks synchronize the current local checkout into a separate directory.
Forking copies all volume contents. It is not an instant snapshot.

Local source files use a bind mount. Remote files use explicit `rsync` synchronization before `up`, or through `sync NAME`.
Remote sync excludes `.git`, `node_modules`, `.dev-now`, `.env`, and `.env.*` at every depth.
Other files, including other ignored files, can synchronize. Do not keep credentials in the source directory.
There is no continuous file watcher yet. Run `sync` after edits to remote code.

## Routing and limits

HTTP instances share the same public port through `NAME.localhost` hostnames.
Requests to bare localhost select the active instance.
Requests from a named instance to bare localhost use the page's `Origin` or `Referer` when that instance serves the port.
WebSocket upgrades, request bodies, cookies, and streaming responses pass through the proxy.
The backend receives `Host: localhost:<public-port>` and the original host in `X-Forwarded-Host`.
Prefer host-only cookies. Applications with fixed callback URLs or cookie domains may need configuration.

TCP has no HTTP hostname. Postgres and Redis connections use the instance selected by `use`.
Changing the selection closes connections that used bare localhost. Named HTTP connections remain independent.
Reload existing pages after a switch. There is no injected browser panel.

All published ports bind loopback on both machines. SSH carries remote traffic.
The proxy rejects unrelated HTTP hostnames. The control API uses a private Unix socket.
No root permissions, DNS changes, or `/etc/hosts` entries are required.
Browsers normally resolve `*.localhost` to loopback. A CLI client without that behavior can use:

```sh
curl --resolve demo.localhost:3300:127.0.0.1 http://demo.localhost:3300
```

The state directory defaults to `~/.local/state/dev-now`. Set `DEV_NOW_HOME` to isolate another daemon.
State can contain configured environment values. The directory and state file use private permissions.
Remote removal also deletes its synchronized source directory.
A lost SSH tunnel appears as disconnected. Run the original `up` command to reconnect.
Automatic tunnel reconnection, HTTPS, cloud provisioning, and multi-user sharing are outside this version.

## Providers, Firecracker, and S3

The CLI and routing daemon call a [provider interface](src/providers/README.md).
The Docker provider supports local execution and SSH execution through the same lifecycle.
Adding a provider does not require replacing HTTP routing or CLI commands.

A Firecracker provider is a suitable later addition for stronger isolation and VM snapshots.
It requires a Linux host with access to `/dev/kvm`, a guest kernel, a root filesystem, and network configuration.
It cannot run natively on this Mac. A normal VPS must expose nested virtualization to support it.
See the [Firecracker requirements](https://github.com/firecracker-microvm/firecracker/blob/main/docs/getting-started.md).

Persistence currently uses [Docker volumes](https://docs.docker.com/engine/storage/volumes/) on the selected host.
Deleting that host loses those volumes. S3 backups and restores are not implemented.
A future storage adapter should export consistent stopped-volume archives or database-native backups to S3.
It should restore those backups onto local block storage before a service starts.
S3 should not act as the live filesystem for Postgres.

## Verification

```sh
npm run check
npm test
npm run test:e2e
DEV_NOW_TEST_SSH=user@server npm run test:e2e
# Optional: DEV_NOW_TEST_SSH_CONFIG=/path/to/ssh-config
```

The end-to-end test creates real web and Postgres containers.
It checks HTTP routing, TCP forwarding, isolated data, persistence, sync, daemon recovery, and safe forks.
It removes its containers, volumes, daemon, and local temporary files afterward.
It does not provision or delete the SSH host.
