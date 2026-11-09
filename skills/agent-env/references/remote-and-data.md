# Remote services and data operations

Read only the section needed for the requested operation.
Keep existing authorization for the selected host and data operation.
This skill does not authorize paid infrastructure, trust changes, or data deletion by itself.

## Existing SSH hosts

For interrupted Docker or Compose startup, inspect `agent-env --json list` first.
If it reports `recovery: "required"`, use `agent-env up NAME` to recover the saved instance.
Use `agent-env rm NAME --purge` only when the user intends to delete its owned resources and data.
Keep the private state directory until recovery or purge succeeds.
Wait for active allocation commands before retrying. Missing completion receipts block automatic recovery.
Preserve the records for inspection when completion is uncertain.
Verify that all allocation commands have stopped on both the local and remote host.
Then use `agent-env rm NAME --accept-uncertain` to remove compute and retain volumes.
Add `--purge` only when the user intends to delete retained data.
This option still refuses active local process groups and foreign resources. It cannot prove that a remote command stopped.
Do not delete recovery records manually.
Complete recovery before snapshots or forks. Do not remove resources that fail ownership verification.

The local machine needs SSH and rsync.
Native SSH mode does not require local Docker, so a Swarm worker can use a separate Docker host.
Compose also requires a local Docker CLI and Compose plugin to resolve configuration. It does not require a local Docker engine.
Localhost routes belong to the worker running `agent-env`. They do not appear automatically on the user's laptop.
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

Configure storage once with AWS CLI v2 and its normal credential chain:

```sh
agent-env storage add backup --provider s3 --bucket my-bucket --region eu-west-1 --aws-profile work
agent-env storage check backup
agent-env storage list
agent-env snapshot app storage://backup/checkpoint
agent-env restore storage://backup/checkpoint --name restored
```

Use `--project` with profile additions or removals to modify `storage` in `agent-env.json`.
Otherwise, profiles reside in the private `$AGENT_ENV_HOME/storage.json` file.
A project profile replaces the complete user profile. Credentials and endpoints never merge.
Profile edits do not change runtime identity.
Use `--access-key-env VAR`, `--secret-key-env VAR`, and optional `--session-token-env VAR` for credential references.
These flags accept variable names, never credential values.
`--endpoint`, `--region`, `--prefix`, `--addressing-style auto|path|virtual`, and `--ca-bundle` configure compatible services.
Local profiles use `--provider local --root /existing/backups`.
`storage list` reports the effective source without credential references or values.
`storage remove NAME` removes configuration only. It never deletes archives.

Named S3 exports check bucket access, upload, download, and actual duplicate conditional rejection before volume export.
A backend that ignores conditional writes fails this check.
Keep recovery object paths if probe cleanup fails.
The invoking CLI resolves credentials. The daemon does not reuse its startup AWS environment.
AWS CLI v2 must support `configure export-credentials --format process` and `put-object --if-none-match`.
Live vendor compatibility requires a successful check and restore against that backend.
The bundled CI fixture verifies SeaweedFS, without paid cloud services.
See [backend commands and requirements](https://github.com/desplega-ai/agent-env/blob/master/docs/storage.md).

Legacy locations remain available:

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
