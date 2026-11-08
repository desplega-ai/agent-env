# Remote services and data operations

Read only the section needed for the requested operation.
Keep existing authorization for the selected host and data operation.
This skill does not authorize paid infrastructure, trust changes, or data deletion by itself.

## Existing SSH hosts

The local machine needs SSH and rsync.
The remote host needs Docker, rsync, Bash, and `timeout`. Compose projects also need Docker Compose.
Use an SSH alias or `--ssh-config FILE` for credentials and ports.
Establish and verify the host key through the normal SSH workflow. Do not disable host verification.

```sh
agent-env up --name remote --ssh dev-host
agent-env --json list
agent-env sync remote
agent-env logs remote --service web
agent-env down remote
agent-env up remote
```

Replace `dev-host` with the authorized SSH alias or `user@host`.
Remote source synchronization follows local edits unless startup includes `--no-watch`.
The daemon reconnects failed SSH tunnels automatically.
Verify the returned localhost address after startup and after a representative source edit.

Sync excludes `.git`, `node_modules`, `.agent-env`, `.env*`, and common generated directories.
Root `build` and `dist` directories are excluded. Nested source paths such as `src/build` still transfer.
Keep other credentials outside the checkout.
Remote Compose bind mounts, build contexts, and Dockerfiles must remain inside the checkout and pass the sync exclusions.
Compose secret files use a separate private transfer.

## Owned Hetzner machines

Use this workflow only when the user requests paid infrastructure.
Check the authenticated `hcloud` context before provisioning.

```sh
agent-env up --name cloud --cloud hetzner --location hel1
agent-env down cloud
agent-env up cloud
```

`down` powers off the owned machine when no other running instance needs it.
Powered-off machines still incur charges.
`agent-env rm cloud --purge` deletes the last instance's owned machine, IP, key, and data.
Forks share the source machine. Removing one instance preserves its peers.
Keep the original hcloud context and credential for lifecycle operations.
If either changes, the CLI refuses access and preserves recovery records.
Do not delete those records to bypass an error.

The default idle timeout is 30 minutes. `--idle-minutes 0` disables it.
`--ttl-hours N` sets a destructive expiry for the shared machine and all its instances, including sleeping forks.
Idle shutdown and expiry require the local daemon to remain running and connected.
These are not cloud-side schedules. Do not promise cost control after the daemon stops.

## HTTPS and the dashboard

```sh
agent-env up --name app --local --https --https-port 8443
agent-env ui --port 4780
```

Read the actual HTTPS URLs from `agent-env list`.
The primary HTTP service uses `https://app.localhost:8443`.
Other HTTP services use `https://app--SERVICE.localhost:8443`.
The dashboard shows status and recent redacted logs. It accepts local read-only requests.

`agent-env trust` installs the local certificate authority into the OS trust store.
Run it only when trust installation is authorized. Linux installation requires sudo.
Certificate creation during `up --https` does not install OS trust.
For verification without a trust change, use the generated CA:

```sh
curl --cacert ~/.local/state/agent-env/tls/ca.pem \
  --resolve app.localhost:8443:127.0.0.1 https://app.localhost:8443/
```

Use `$AGENT_ENV_HOME/tls/ca.pem` instead when the state directory was overridden.
Some browsers and runtimes use separate certificate stores.

## Forks

Stop the source before copying database volumes:

```sh
agent-env down app
agent-env fork app experiment --worktree ../experiment --branch experiment
agent-env --json list
```

This creates a Git worktree, copies source changes and volumes, and starts an independent fork.
Credentials and generated files are excluded from copied source changes.
Without worktree options, `fork app experiment` copies data and reuses the source checkout.
Forks require a new destination name and use the source Docker host.
Verify that a database write in the fork does not change the source data.
Resume a saved fork with `agent-env up experiment`, even from another directory.

Instance removal retains worktrees by default.
`rm NAME --remove-worktree` removes an owned clean worktree.
`--discard-worktree` also permits removal of changed and ignored files. Use it only for an authorized discard.

## Snapshots and restore

```sh
agent-env down app
agent-env snapshot app /existing/backups/checkpoint
agent-env restore /existing/backups/checkpoint --name restored
```

Run restore from the intended project checkout with the intended environment options.
Restore uses current project configuration and creates fresh volumes before startup.
It verifies archive checksums and refuses existing destination volumes.
Snapshots contain volume data, not source files or a complete deployable project.
Unsupported or shared mounts cause an error. Do not add `--omit-mounts` unless the user accepts the missing data.

S3 uses the installed AWS CLI and its configured credentials:

```sh
agent-env snapshot app s3://my-bucket/checkpoint
agent-env restore s3://my-bucket/checkpoint --name restored --ssh dev-host
```

Use a new snapshot prefix. `--endpoint URL` selects compatible object storage.
S3 stores backups. Running databases still use Docker volumes.
Snapshots need temporary local disk space. AWS S3 exports are limited to 5 GB per volume.
For format and ownership details, read the [snapshot documentation](https://github.com/desplega-ai/agent-env/blob/master/docs/snapshots-and-worktrees.md).

## Provider and state boundaries

State defaults to `~/.local/state/agent-env`. `AGENT_ENV_HOME` selects another private directory.
State can contain environment values and cloud ownership credentials. Do not publish it or treat it as disposable cache.
For isolated tests, set `AGENT_ENV_HOME` before the first CLI command.
Remove only the test's resources, then stop its daemon before deleting its state.

The sandbox bridge is available through `--provider sandbox --adapter docker`.
Custom sandbox adapters are trusted local ESM modules.
Firecracker and hosted sandbox vendor integrations are not bundled.
See the [adapter contract](https://github.com/desplega-ai/agent-env/blob/master/src/providers/CLOUD_SANDBOX.md) before proposing a new provider.
