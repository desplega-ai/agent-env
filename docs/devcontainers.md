# Dev Containers

The `devcontainer` provider uses the official Dev Containers CLI with local Docker.
It supports image, Dockerfile, and Docker Compose definitions.
Native lifecycle commands start the application.
You do not need an `agent-env` service image or service command.

The provider reads `.devcontainer/devcontainer.json` first.
It then checks `.devcontainer.json`.
It accepts JSONC comments and trailing commas.
An explicit path takes precedence:

```json
{
  "provider": "devcontainer",
  "devcontainer": {
    "config": ".devcontainer/backend/devcontainer.json"
  }
}
```

The official CLI requires the filename `devcontainer.json` or `.devcontainer.json`.
Relative paths resolve from the source configuration directory.
The provider writes runtime copies under the private agent-env state directory.
It preserves the source configuration and Compose files.
It disables CLI lockfile generation to preserve the checkout.

## Routes and workspace commands

Common HTTP ports, such as 3000, 5173, and 8080, become HTTP routes.
Other forwarded ports become TCP routes, consistent with Compose.
Use `portsAttributes["PORT"].protocol` or `devcontainer.routes` to select the protocol explicitly.
A `"service:port"` entry targets a Compose service.
The public port defaults to the forwarded port.
The backend uses an ephemeral Docker port bound to `127.0.0.1`.
Services must listen on `0.0.0.0` inside their containers.
Routes from `forwardPorts` do not require a listening application during startup.
You can start the application after `up` through `exec` or a named project command.
HTTP requests return a gateway error until the application listens.
Explicit `devcontainer.routes` require listening services before startup succeeds.

Use explicit route definitions for TCP, different public ports, or stable aliases:

```json
{
  "provider": "devcontainer",
  "devcontainer": {
    "routes": {
      "web": { "service": "workspace", "target": 3000, "port": 3000, "protocol": "http" },
      "database": { "service": "db", "target": 5432, "port": 15432, "protocol": "tcp" }
    }
  }
}
```

Explicit routes replace the `forwardPorts` translation.
Each route requires a distinct alias, public port, and target.
The target is a container port.
The `service` defaults to the primary workspace service.
For image and Dockerfile definitions, the primary service is `workspace`.
For Compose definitions, it is the native `service` from `devcontainer.json`.
The primary service remains internal when no route targets it.
Configurations without ports still support workspace commands.

`exec` uses `devcontainer exec` in the configured workspace.
The official CLI applies `remoteUser`, `remoteEnv`, and the user environment probe.
Explicit `agent-env` environment values also apply to lifecycle commands and `exec`.
Arguments do not receive implicit shell interpretation.
Use an explicit shell when a command requires shell syntax.
`exec` accepts the primary workspace service or an alias that targets that service.
Sidecar execution requires a separate integration and currently fails explicitly.
Source synchronization is a no-op because Docker mounts the local workspace.

## Isolation and data

Each installation and instance name receives a private random ownership record.
The record selects its Compose project and labels its resources.
The provider checks ownership before reuse, stop, removal, and purge.
It never adopts an existing container from another project or instance.

The provider replaces Compose `container_name` and managed resource names.
It publishes Compose ports through ephemeral loopback ports.
It preserves exposed ports without adding public routes unless the configuration requests routes.
This prevents a source Compose port from conflicting with a listener on the host.

Named volumes persist across `down`, `up`, and ordinary `rm`.
A later `up` with the same installation and instance name reuses the retained named volumes.
`rm --purge` deletes owned volumes and the ownership record.
It also removes owned build image tags that the provider can verify.
Image downloads and unowned feature caches remain available to other instances.
A failed create removes its containers, networks, and newly allocated owned volumes.
It retains any volumes that existed before that create attempt.

Use native `mounts` with named volume sources for image or Dockerfile data.
Use ordinary named Compose volumes for Compose data.
The provider rejects anonymous Compose volumes, external volumes, external networks, and storage driver options.
The provider also rejects host networking, static network addresses, replicas, and external container links.
It supports `network_mode: service:NAME` when NAME belongs to the same Compose project.
It publishes ports on the container that owns that network namespace.
It rejects other network modes and cycles between shared namespaces.
These options require additional ownership and routing support.
Use `forwardPorts` instead of `appPort`.
Remove `runArgs` that control names, labels, mounts, networks, or published ports.
Use native mount fields instead.
When Compose files change, `up` reports the change instead of using an outdated runtime copy.
Run `rm NAME`, then `up --name NAME` from the checkout to apply those changes with retained named volumes.

SSH targets, cloud targets, and remote Docker endpoints fail explicitly.
Snapshots, restore, and fork are unsupported.
The provider deliberately exposes no `docker` method or snapshot hooks.
Native hooks can run arbitrary development commands, as they do with the official CLI.
Treat source configurations as executable project configuration.

## Manual E2E

Install the candidate package into a private prefix first.
Use a new state directory for each verification session.
Run these commands from the image example in the installed package:

```sh
export AGENT_ENV_HOME=/path/to/private-state
export AGENT_ENV_CLI=/path/to/installed-prefix/node_modules/.bin/agent-env
cd /path/to/installed-prefix/node_modules/@desplega.ai/agent-env/examples/devcontainer/image
"$AGENT_ENV_CLI" up --name dc-image --no-watch
"$AGENT_ENV_CLI" exec dc-image --service workspace -- id -un
curl --fail http://dc-image.localhost:3000
"$AGENT_ENV_CLI" down dc-image
"$AGENT_ENV_CLI" up dc-image
"$AGENT_ENV_CLI" rm dc-image --purge
"$AGENT_ENV_CLI" daemon stop
```

Repeat the commands from the Dockerfile and Compose example directories.
Use a distinct instance name for each example.
Run the complete installed CLI suite from the source checkout:

```sh
AGENT_ENV_CLI=/path/to/installed-prefix/node_modules/.bin/agent-env node test/devcontainer.e2e.mjs
```

The suite covers JSONC, all three definition types, native hooks, HTTP routing, workspace execution, and instance isolation.
It also covers retained data, purge, failed hooks, occupied Compose ports, explicit config paths, and unsupported operations.
It removes only resources associated with its isolated state directory.

References: [official CLI](https://github.com/devcontainers/cli/tree/v0.90.0),
[CLI package](https://www.npmjs.com/package/@devcontainers/cli/v/0.90.0),
and [Dev Container specification](https://containers.dev/implementors/json_reference/).

See [provider verification](providers-verification.md) for the completed installed CLI checks.
