# Agent Swarm with agent-env

Run the real API and dashboard from an Agent Swarm checkout.
Copy two configuration files, provide a private test credential, and run `agent-env up`.
The Compose setup job installs Linux dependencies before the API and dashboard start.

## Requirements

- Node.js 22 or newer on the host.
- Docker Engine and Docker Compose with JSON configuration, `config --variables`, and `up --wait`.
- An Agent Swarm checkout with `bun@1.4.4` in `package.json`.
- Docker Hub and package registry access for the first installation.
- Free host ports 4313 and 4574, and approximately 7 GiB for the first installation.

The host needs no Bun or portless installation.
The example uses `oven/bun:1.4.4` without building application images.

## Start from an Agent Swarm checkout

Run these commands from the checkout.
Set `AGENT_ENV_REPO` to your agent-env checkout.
For a global npm installation, use `export AGENT_ENV_REPO="$(npm root -g)/@desplega.ai/agent-env"` instead.
Do not replace existing configuration files.
If either destination exists, select another filename and pass `--config` or `--compose-file` explicitly.

```sh
export AGENT_ENV_REPO=/path/to/agent-env
cp "$AGENT_ENV_REPO/examples/agent-swarm/agent-env.json" ./agent-env.json
cp "$AGENT_ENV_REPO/examples/agent-swarm/compose.agent-env.yaml" ./compose.agent-env.yaml

umask 077
export AGENT_ENV_HOME="$(mktemp -d /tmp/agent-env-swarm-XXXXXX)"
export AGENT_SWARM_INSTANCE=swarm-example
node --input-type=module <<'JS'
import { writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
writeFileSync(`${process.env.AGENT_ENV_HOME}/test.env`,
  `AGENT_SWARM_API_KEY=${randomBytes(32).toString('hex')}\n` +
  `AGENT_SWARM_INSTANCE=${process.env.AGENT_SWARM_INSTANCE}\n`, { mode: 0o600 });
JS

node "$AGENT_ENV_REPO/bin/agent-env.mjs" up --name "$AGENT_SWARM_INSTANCE" \
  --env-file "$AGENT_ENV_HOME/test.env"
```

The installed CLI also accepts `agent-env up` in place of the Node invocation.
`startupTimeoutSeconds: 900` allows the setup job to finish its first installation.
`--timeout 900` provides the equivalent CLI override.

The source bind points directly at the current checkout.
The dashboard sees source edits through Vite.
Restart the API with `down` and `up` after API source edits.
Docker stores Linux dependencies and Bun downloads in separate named volumes for each instance.
The setup job uses the checkout's frozen lockfile and hoisted linker configuration.
It skips lifecycle scripts.

## Verify the real application

Keep the same `AGENT_ENV_HOME` in this shell.

```sh
node "$AGENT_ENV_REPO/bin/agent-env.mjs" use "$AGENT_SWARM_INSTANCE"
node "$AGENT_ENV_REPO/bin/agent-env.mjs" list
node --env-file="$AGENT_ENV_HOME/test.env" \
  "$AGENT_ENV_REPO/examples/agent-swarm/verify.mjs"
node "$AGENT_ENV_REPO/bin/agent-env.mjs" logs "$AGENT_SWARM_INSTANCE" --service api
node "$AGENT_ENV_REPO/bin/agent-env.mjs" logs "$AGENT_SWARM_INSTANCE" --service setup
node "$AGENT_ENV_REPO/bin/agent-env.mjs" exec "$AGENT_SWARM_INSTANCE" --service api -- \
  bun --no-env-file -e "fetch('http://127.0.0.1:3013/health').then(r => r.json()).then(console.log)"

node "$AGENT_ENV_REPO/bin/agent-env.mjs" down "$AGENT_SWARM_INSTANCE"
node "$AGENT_ENV_REPO/bin/agent-env.mjs" up "$AGENT_SWARM_INSTANCE"
node --env-file="$AGENT_ENV_HOME/test.env" \
  "$AGENT_ENV_REPO/examples/agent-swarm/verify.mjs" --read-only
```

The first check writes a value through `PUT /api/kv/_/agent-env-example/persistence`.
It reads the value through the direct API and the dashboard proxy.
The second check only reads the retained value after restart.
Both checks verify authentication, health, dashboard HTML, and the transformed dashboard entry module.
The check uses HTTP and does not prove browser rendering or interaction.

| Service | Default address |
| --- | --- |
| API | `http://swarm-example.localhost:4313` |
| Dashboard | `http://swarm-example.localhost:4574` |
| Selected API | `http://localhost:4313` |
| Selected dashboard | `http://localhost:4574` |

Enter the API address and generated test key in the dashboard's connection form.
The key remains in the private environment file until you use it.
The example does not embed the key in browser assets.
If `.localhost` resolution fails, use `localhost` after `agent-env use`.
For curl, use `--resolve swarm-example.localhost:4313:127.0.0.1`.

## Configuration and isolation

| Setting | Purpose |
| --- | --- |
| `AGENT_SWARM_API_KEY` | Required test credential, generated outside the checkout. |
| `AGENT_SWARM_INSTANCE` | CORS instance name. Must match `--name`. Default: `swarm-example`. |
| `AGENT_ENV_HOME` | Separate daemon, private configuration, and saved instance state. |
| `DATABASE_PATH=/data/agent-swarm.sqlite` | SQLite data in the instance's named volume. |
| `AGENT_FS_LOCAL_DIR=/data/files` | Local storage in the same isolated data volume. |
| `CAPABILITIES=core,task,kv,skills,repo` | Excludes the scheduler capability. |

No inference, Slack, tracker, GitHub, or agent-fs credentials are required.
The API receives only explicit Compose environment values.
All Bun commands use `--no-env-file`.
The dashboard starts the checkout's actual Vite configuration with `envDir: false`.
These settings prevent Bun and Vite from loading existing private `.env` files.
The explicit `--env-file` selects the generated credential for Compose interpolation.

The file disables heartbeat, runtime pools, automatic titles, integrations, OAuth sweeps, and telemetry.
It starts no lead or worker containers and does not execute schedules or create tasks.
Normal API startup seeds schedule definitions, including some marked enabled.
The scheduler remains disabled because the example excludes the `scheduling` capability.
The API still runs its normal internal maintenance services.
Its automatic public model-catalog refresh can contact `models.dev`.
The Compose network permits outbound traffic, so this example is not an internet sandbox.
Docker omitted published ports on an internal-only network during verification.

Agent-env isolates container names, the network, all dependency volumes, and the data volume.
It publishes Docker backend ports only on random loopback ports.
The configured localhost routes use ports 4313 and 4574.
The data volume retains SQLite, encryption material, and the page-session secret after `down` and `up`.
The API mounts source read-only.
Setup and Vite use a writable source bind, with dependency directories covered by Linux volumes.
Docker can create empty `node_modules` mountpoint directories in a fresh checkout.
The setup job does not change the frozen lockfile or package manifests.

## Cleanup

```sh
node "$AGENT_ENV_REPO/bin/agent-env.mjs" rm "$AGENT_SWARM_INSTANCE" --purge
node "$AGENT_ENV_REPO/bin/agent-env.mjs" daemon stop
rm -r "$AGENT_ENV_HOME"
# Remove only the two configuration files copied for this run.
rm ./agent-env.json ./compose.agent-env.yaml
df -h /
```

Purge removes the instance's containers, network, dependency caches, and data volume.
The cleanup does not remove shared caches or other Docker resources.
No custom images need removal.
If this test alone downloaded the Bun image, remove it with `docker image rm oven/bun:1.4.4`.
