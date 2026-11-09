# TypeScript SDK

Import the package in scripts and CI jobs:

```sh
npm install @desplega.ai/agent-env
```

```ts
import { createClient, AgentEnvError } from '@desplega.ai/agent-env';

const client = createClient({
  cwd: '/workspace/project',
  home: '/workspace/job-state',
  env: { BUILD_TOKEN: undefined },
});

try {
  const instance = await client.up({ name: 'ci-example', envFiles: false });
  console.log(instance.services.web?.url);
  const result = await client.run(instance.name, 'test', ['--verbose']);
  console.log(result.output);
} catch (error) {
  if (error instanceof AgentEnvError) {
    console.error(error.code, error.exitCode);
  }
  throw error;
} finally {
  try {
    const instances = await client.list();
    if (instances.some(instance => instance.name === 'ci-example')) {
      await client.remove('ci-example', { purge: true });
    }
  } finally {
    await client.stopDaemon();
  }
}
```

Use a dedicated `home` for each CI job.
The example stops that home's daemon after cleanup.
`stopDaemon()` disconnects routing for every instance in that home.
It does not stop the services.
Only use it when the job owns that daemon.

The runnable [CI example](../examples/sdk/ci.mjs) creates its own source, port, state, and instance name.
Run it from an installed package or this checkout after `npm ci`:

```sh
node examples/sdk/ci.mjs
```

Local Docker, Compose, and Dev Container execution requires a working Docker engine.
SSH targets retain their Docker, SSH, Bash, and rsync requirements.
Cloud targets retain their provider CLI, credentials, network access, and billing requirements.
E2B retains its API key and sandbox requirements.
The SDK does not provision credentials or replace provider prerequisites.

## Client configuration

`createClient({ cwd, home?, env?, maxOutputBytes?, includeErrorOutput? })` returns an immutable client.
It does not change the process directory or `process.env`.
Separate clients can use different directories and state homes concurrently.
Clients with the same home share a daemon and its saved instances.

The SDK resolves `cwd` when you create the client.
It resolves a relative `home` against that directory.
An explicit `home` overrides `env.AGENT_ENV_HOME`.
Otherwise, the CLI uses `AGENT_ENV_HOME` or its normal default.

Each call inherits the current process environment.
The SDK copies explicit `env` overrides when you create the client.
A string sets an override, including an empty string.
`undefined` removes an inherited variable from the child process.
These variables configure the CLI and its providers.
Use project configuration, environment files, or private secrets to select service variables.
A daemon retains the environment from its startup.
Use separate homes for clients that need different daemon credentials.

The SDK buffers complete JSON results in memory.
`maxOutputBytes` limits the combined CLI stdout and stderr bytes.
The default is 64 MiB, including JSON encoding overhead.
Increase it for commands with larger results.
An exceeded limit produces `AgentEnvError` with code `OUTPUT_LIMIT`.
The SDK terminates its CLI process in that case.
The remote operation may continue.

## Methods and results

All methods return promises.
The package exports the corresponding option and result types.

| Method | Result |
| --- | --- |
| `up(options?)` | `InstanceSummary` |
| `resume(name, options?)` | `InstanceSummary` |
| `list()` | `ListedInstance[]` |
| `down(name)` | `{ message: string }` |
| `remove(name, { purge? }?)` | `{ message: string }` |
| `exec(name, argv, { service? }?)` | `{ output: string }` |
| `run(name, commandName, args?, { service? }?)` | `{ output: string }` |
| `logs(name, { service? }?)` | `{ output: string }` |
| `sync(name)` | `{ message: string }` |
| `snapshot(name, location, options?)` | `SnapshotResult` |
| `restore(location, options)` | `RestoreResult` |
| `fork(source, destination, options?)` | `ForkResult` |
| `stopDaemon()` | `{ message: string }` |

Instance summaries contain the name, provider, host, running state, connection state, commands, and public service routes.
They can also include environment names, cloud status, source worktrees, and redacted errors.
Each listed instance adds a `status` map with the provider's current service states.
Snapshots return the resolved location and omitted mounts.
Restores return an instance summary and omitted mounts.
Forks can return omitted source paths.

Command methods return the provider's current combined output.
The CLI can remove trailing whitespace through provider normalization.
Successful results have no separate stdout, stderr, or exit code.
`logs()` returns recent buffered logs, not a continuous stream.

`down()` stops one named instance and retains its data.
`resume()` starts its saved configuration without reloading configuration from the client's directory.
`remove()` removes one named instance.
`purge: true` explicitly requests deletion of its retained data and compute resources.
`acceptUncertain: true` acknowledges a missing allocation receipt during removal.
Use it only after verifying that all local and remote allocation commands have stopped.
The daemon still checks ownership and refuses active local process groups. It cannot prove that a remote command stopped.
Do not enable this option in automatic retries.
The SDK exposes no all-instances switch.
The CLI retains its provider ownership checks.

## Startup options

`up()` and `restore()` accept these options.
`restore()` requires `name` because it creates a new instance.

| Option | Type and behavior |
| --- | --- |
| `name` | Instance name, 1 to 48 lowercase letters, digits, or hyphens, starting with a letter |
| `provider` | `docker`, `compose`, `devcontainer`, `sandbox`, or `e2b` |
| `adapter` | Sandbox adapter name or module path |
| `ssh`, `sshConfig` | SSH host or alias, and optional SSH configuration file |
| `local` | Boolean that selects the local target when true |
| `cloud` | Explicit cloud target, currently `hetzner` |
| `cloudType`, `location` | Cloud machine type and location |
| `idleMinutes`, `ttlHours` | Nonnegative idle minutes and positive TTL hours |
| `config` | Project configuration path relative to `cwd`, or an absolute path |
| `environment` | Named project environment |
| `envFiles` | Nonempty array of selected files, or `false` to disable automatic discovery |
| `composeFiles`, `profiles` | Nonempty arrays of Compose files and profiles |
| `watch` | `false` disables watching, `true` retains the configured behavior |
| `startupTimeoutSeconds` | Integer from 1 to 3600 |
| `command` | Nonempty startup argument array, subject to CLI provider rules |
| `port`, `image` | Port and image for a startup command override |

Omit `envFiles` to retain normal discovery.
Select only one explicit target: `ssh`, `cloud`, or `local: true`.
Cloud settings can also come from the project configuration.
`resume()` only accepts `startupTimeoutSeconds`.
Startup limits do not impose a deadline on `exec()` or `run()`.

The SDK rejects unknown option keys, invalid booleans, invalid names, and malformed argument arrays before transport.
It does not coerce strings into flags.
Option values outside command arrays cannot start with a hyphen.
Prefix such relative paths with `./`.
The CLI validates project configuration and provider-specific constraints.

## Commands and storage

```ts
await client.exec('ci-example', ['printf', '%s', 'literal $(id); spaces'], { service: 'web' });
await client.run('ci-example', 'test', ['--filter', 'case with spaces']);

await client.down('ci-example');
await client.snapshot('ci-example', 'storage://backups/job-123', { config: 'agent-env.json' });
await client.restore('storage://backups/job-123', {
  name: 'restored-example',
  config: 'agent-env.json',
  envFiles: false,
});
```

The SDK accepts local directories, `s3://bucket/prefix`, and `storage://profile/key`.
The CLI resolves storage profiles, project overrides, endpoints, and credentials.
The SDK does not duplicate that resolution.
See [storage profiles](storage.md) for configuration.

Snapshot options include `config`, `endpoint`, and `omitUnsupportedMounts`.
Restore options add `endpoint` and `omitUnsupportedMounts` to the startup options.
A storage profile URL conflicts with an explicit `endpoint`.
The CLI enforces that constraint.
Profile operations can return a public `storageProfile` reference with its name and source.

Stop the source before a snapshot or fork.
Source containers must still exist so the CLI can identify their volumes.
Restore requires a new destination and compatible project configuration.
The provider determines which snapshot and fork operations it supports.

Fork options include `worktree`, `branch`, `ref`, and `omitUnsupportedMounts`.
The SDK does not remove Git worktrees.
Use the CLI's explicit worktree removal options when cleanup requires them.

## Transport and errors

Each call starts `process.execPath` with this package's own `bin/agent-env.mjs` and `--json`.
The SDK never requires a global executable or starts a shell.
It preserves command argument boundaries after `--`.
Configured shell commands retain the CLI's existing shell behavior inside the provider.

This implementation reuses CLI configuration, credentials, daemon startup, and provider behavior.
Each call incurs Node startup, CLI initialization, and JSON buffering overhead.
The daemon can remain active across calls.
The SDK does not expose internal daemon messages.
It does not implement cancellation or streamed output.
Terminating a caller or CLI process does not necessarily stop a remote operation.

SDK failures use the exported `AgentEnvError` class:

| `code` | Meaning |
| --- | --- |
| `INVALID_ARGUMENT` | The SDK rejected an API argument |
| `CLI_FAILED` | The CLI exited unsuccessfully |
| `TRANSPORT_ERROR` | The SDK could not start the CLI |
| `INVALID_RESPONSE` | The CLI returned invalid JSON after a successful exit |
| `OUTPUT_LIMIT` | The CLI output exceeded the configured buffer limit |

`exitCode` contains the CLI exit status when available.
Command failures preserve the CLI's propagated command exit status.
Signal termination and SDK validation errors have no exit code.
Error messages are generic because invocation details can contain credentials.
Default errors contain no child-process arguments, output, environment values, or underlying error causes.
Successful public output retains the CLI's existing redaction behavior.

Enable `includeErrorOutput: true` to receive CLI stderr in `AgentEnvError.stderr` when an operation fails:

```ts
const client = createClient({ cwd: process.cwd(), includeErrorOutput: true });
try {
  await client.run('app', 'test');
} catch (error) {
  if (error instanceof AgentEnvError) console.error(error.stderr ?? error.message);
  throw error;
}
```

The CLI removes known secrets from this output. Application output can still contain private values that the CLI does not know.
Treat diagnostic output as private. Enable this option only when the destination can receive application logs.
The same `maxOutputBytes` limit applies. Output-limit errors omit captured output.

## Verification

```sh
npm ci --ignore-scripts
npm run check
npm run test:sdk
```

The SDK suite packs and audits an archive, then installs it in a temporary prefix.
It compiles a strict TypeScript consumer against the installed public export.
It then uses real Docker, HTTP, the SDK, and the installed CLI.
The suite tests lifecycle operations, command arguments, failures, redaction, large output, isolated clients, snapshots, restore, and fork.
It removes only its own instances and temporary installation.
It removes its temporary package archive after verification.
Set `AGENT_ENV_SDK_TARBALL` to test an existing package archive instead.
The [agent-fs acceptance workflow](agent-fs.md) verifies a real application through the SDK.
It covers authenticated file operations, live source updates, S3 version history, persistence, and purge.
If `AGENT_ENV_CLI` is set, also supply its package archive through `AGENT_ENV_SDK_TARBALL`.
The SDK suite refuses to substitute a fresh checkout archive for a separately installed CLI.
The suite needs the pinned TypeScript development dependency from this checkout.
It performs no paid cloud tests.

The local `docker` group includes this suite.
Its CI job installs the pinned TypeScript compiler before the tests.
The suite creates its own installation and does not use `AGENT_ENV_CLI`.
The CI wrapper passes its audited archive through `AGENT_ENV_SDK_TARBALL`.
The SDK and CLI tests therefore use the same package archive.
Temporary installations and example state remain beneath `TMPDIR` for cleanup after interruption.
