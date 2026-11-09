---
name: agent-env
description: Run and troubleshoot development environments with agent-env, including Docker, Compose, Dev Containers, E2B, project commands, source sync, dotenv, and persistent data.
license: MIT
---

# agent-env

Use the `agent-env` CLI to run development services behind stable localhost addresses.
Check `agent-env --help` for the installed version's commands and options.
Run `agent-env skill` to read this guide and its reference offline.
Run `agent-env skill install` to install the bundled skill for your coding agent.

## Prepare the project

1. Inspect `agent-env.json`, Compose files, and package scripts before changing configuration.
2. Check `agent-env --version`. If absent, install the CLI with `npm install -g @desplega.ai/agent-env`.
3. Check the provider prerequisites. Docker and Dev Containers require `docker info`. Compose also requires `docker compose version`.
4. Inspect `agent-env --json list` before choosing an instance name or reusing ports.

The CLI requires macOS or Linux and Node.js 22.19 or later.
Installing this skill does not install the CLI or Docker.
Preserve existing project configuration and the user's selected compute target.
Use local Docker when no remote target is requested.

## Start and verify

Existing Compose files work directly with `up`.
Existing Dev Container configurations also work directly. Compose retains priority when both configurations exist.
Use `--provider devcontainer` to select the Dev Container explicitly.
For another project without `agent-env.json`, run `agent-env init` to detect its development command.
Do not overwrite an existing configuration.
If detection fails, supply the actual project command, image, and port. For example:

```sh
agent-env init --image node:22-bookworm-slim --port 3000 -- node server.js
```

Replace `node server.js` with the project's command.
Native services run in `/workspace`, which contains the checkout.
Include dependency installation in the command when needed.
The server must listen on `0.0.0.0` inside its container.

```sh
agent-env up --name app --local
agent-env --json list
agent-env logs app --service web
agent-env exec app --service web -- node --version
agent-env ui
```

Replace `app` and `web` with the chosen instance and service names.
Choose an exec command supported by the service's image.
Use returned addresses instead of assuming port 3000.
Verify a real application response through the returned HTTP URL.
For PostgreSQL or another TCP service, verify a connection with its native client.
Report the instance, target, service URLs, verification result, and any remaining failure.

`app.localhost:PORT` addresses one HTTP instance.
`agent-env use app` selects the instance behind bare `localhost:PORT` and raw TCP ports.
Changing selection closes existing connections through bare localhost.
The local daemon must remain running for routing and SSH tunnels.

## Compose and configuration

```sh
agent-env up --name app --local --compose-file compose.yaml --profile tools
```

Use only files and profiles that the project defines.
Repeat `--compose-file` or `--profile` for multiple entries.
Compose retains builds, health checks, dependencies, named volumes, and internal services.
Keep secrets in declared `environment`, `env_file`, or Compose secret sources.
Use `compose.routes` when one service needs aliases for multiple published ports.
See the [Compose configuration examples](https://github.com/desplega-ai/agent-env/blob/master/examples/compose/README.md).

For a Vite project using native Docker, define `services` in `agent-env.json`:

```json
{
  "services": {
    "web": {
      "image": "node:22-bookworm-slim",
      "port": 3000,
      "containerPort": 3000,
      "command": "npm ci && npm run dev -- --host 0.0.0.0 --port 3000",
      "volumes": { "dependencies": "/workspace/node_modules" }
    }
  }
}
```

Adapt the command to the project. Named volumes retain dependencies and application data.
Use `agent-env add postgres` or `agent-env add redis` to generate a persistent service configuration.
For a named environment, include `--env review` when adding its service.

## Dev Containers, E2B, and project commands

Dev Containers use local Docker and the official Dev Containers CLI bundled as a dependency.
Native lifecycle hooks configure the workspace. Common HTTP ports become HTTP routes. Other forwarded ports become TCP routes.
Use `portsAttributes` or explicit routes for HTTP services on other ports.
Forwarded ports can remain closed during workspace startup. Start the application later with `exec` or a project command.
Explicit `devcontainer.routes` require a listening service during startup.
Use `devcontainer.routes` for explicit ports, protocols, or Compose service targets.
Compose can share a network namespace through `network_mode: service:NAME` within one project.
The default exec service is the workspace. SSH targets and snapshots are not supported for this provider.

E2B needs Node 22.19+ and `E2B_API_KEY`. It does not need local Docker.
Set `provider` to `e2b`, then configure `e2b.template` and service commands in `agent-env.json`.
Do not set Docker images or volumes on E2B services.
The provider maps private HTTP and WebSocket ingress to localhost. Raw TCP is unsupported.
`down` pauses the sandbox. `up NAME` resumes it. `rm NAME --purge` destroys it.
The E2B lease defaults to 300 seconds and does not extend with activity. Set `e2b.timeoutSeconds` for the expected session duration.
Read the [E2B guide](https://github.com/desplega-ai/agent-env/blob/master/docs/e2b.md) before creating billed sandboxes.

Project `commands` define explicit operations such as install, migrate, seed, test, or reset.
Inspect their definitions before execution. Reset commands can delete application data.

```sh
agent-env run app install
agent-env run app migrate
agent-env run app test -- --runInBand
```

Argument arrays receive extra arguments directly. Shell strings receive them through `"$@"`.
Commands use the configured service or the default workspace service. Use `--service` to override it.
After editing command definitions, use `up --name NAME` to refresh the saved commands.
Long commands do not block status, logs, source sync, or other instances. Output arrives when each command finishes.

Local Docker and Dev Containers mount source files. SSH and E2B automatically synchronize source changes.
An application watcher must reload changed code. Source synchronization alone does not restart an application.
Use `--no-watch` for manual synchronization through `sync NAME`.
Environment files and dependency directories do not synchronize.

## Dotenv and private values

Automatic file order is `.env`, `.env.local`, `.env.<name>`, then `.env.<name>.local`.
The last two files apply when `--env NAME` selects a named environment.
Example files do not load automatically.

```sh
agent-env up --name review --local --env review
agent-env up --name app --local --env-file .env.development
agent-env up --name app --local --no-env-file
agent-env env set API_TOKEN --from-env MY_API_TOKEN
agent-env env list
```

Choose one dotenv selection method. `--env-file` replaces automatic selection and conflicts with `--no-env-file`.
Do not print dotenv contents or secret values.
Private values can also enter through stdin: `agent-env env set API_TOKEN < /path/to/private/token-file`.
Use `--env NAME` consistently for the secret store and startup.
Stores belong to the current project and selected environment.

Native Docker treats dotenv values literally. It does not expand shell expressions.
The parent shell enters native containers only through explicit `{ "env": "NAME" }` references.
Compose retains shell interpolation precedence. Its services must declare container variables through `environment` or `env_file`.
`--no-env-file` does not disable Compose service `env_file` declarations.
See [environment precedence and secret references](https://github.com/desplega-ai/agent-env/blob/master/README.md#environments-and-secrets) for detailed configuration.

Saved instances retain resolved values:

- `agent-env up app` resumes saved configuration from any directory.
- `agent-env up --name app` reads the current project's configuration and reloads edited dotenv files.
- Environment-only changes recreate Docker or Compose containers and preserve named volumes.
- Structural changes, such as ports or commands, require `rm app`, then `up --name app` with the intended target.

Do not use `rm --purge` to resolve a configuration mismatch. It deletes managed data.

## Stop and troubleshoot

Use `agent-env down app` to stop services and retain data.
`agent-env rm app` removes containers but retains volumes and built images.
New instances do not attach retained anonymous volumes automatically. Use named volumes for persistent data.
Purge, failed-start cleanup, and interrupted-start recovery remove anonymous volumes with their containers.
`agent-env rm app --purge` also removes managed data and owned Compose image tags.
Delete data only when that deletion is part of the user's request.
`agent-env daemon stop` stops routing and synchronization, but leaves containers running.
Avoid `--all` when working on one project.

| Symptom | Next action |
| --- | --- |
| Startup timeout | Inspect `logs`. Check the bind address, port, and health check. Increase `--timeout` for slow initialization. |
| Docker unavailable | Local mode needs Docker. Native SSH mode can run without it locally. Compose still needs a local Docker CLI and plugin. |
| Old environment values | Run `up --name NAME` from the correct checkout with the intended environment and dotenv options. |
| Configuration changed | Inspect the change. Use `rm NAME`, then recreate without `--purge` to retain data. |
| Port conflict | Inspect `list` and the port owner. Change configuration instead of terminating unrelated processes. |
| Stale remote files | Run `sync NAME`. Check exclusions before expecting credentials or generated directories to transfer. |
| CLI request timed out | Check `list` and `logs` before retrying. The daemon may still be starting services. |
| Recovery required | Use `up NAME` to recover interrupted Docker or Compose startup. Use `rm NAME --purge` only when deletion is intended. |

Keep the private state directory until recovery or purge succeeds.
Wait for an active allocation command before retrying recovery or purge.
If completion is uncertain, preserve the record at the path in the error.
Verify that all local and remote allocation commands have stopped.
Then use `agent-env rm NAME --accept-uncertain` to remove compute and retain volumes.
Add `--purge` only when deletion is intended.
The acknowledgement still refuses active local process groups and foreign resources.
It cannot check whether remote commands stopped. Do not delete recovery records manually.
Do not snapshot or fork an instance that requires recovery.
Do not remove resources that fail ownership verification.

For a slow saved instance, use `agent-env up app --timeout 900`.
Startup timeouts accept 1 to 3600 seconds. Compose image builds precede the readiness timeout.

## Additional workflows

Read [remote services and data operations](references/remote-and-data.md) for SSH, Hetzner, HTTPS, snapshots, and worktree forks.
That reference also covers named storage profiles, credential references, compatibility checks, and `storage://NAME/prefix` locations.
For Agent Swarm itself, follow the [tested example](https://github.com/desplega-ai/agent-env/blob/master/docs/agent-swarm.md).
That example uses an explicit private env file, isolated Linux dependencies, and a 900-second startup timeout.
