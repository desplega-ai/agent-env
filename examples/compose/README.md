# Compose example

This project builds a Node web service and starts Postgres after its health check succeeds.
The `tools` service requires the `tools` profile.

Use these commands from this directory:

```sh
agent-env init
agent-env env set POSTGRES_PASSWORD < /path/to/private/password-file
agent-env up --name compose-one
agent-env up --name compose-two --profile tools
agent-env exec compose-one --service db -- psql -U postgres -d app -c 'select 1'
agent-env rm compose-one --purge
agent-env rm compose-two --purge
```

The source Compose file stays unchanged. Each instance has its own containers, network, build image, and data volume.
The web service retains public port 3000 in its metadata. Docker assigns a private loopback port.
Postgres has no published port and receives no HTTP route.

`loadSpec` accepts one environment name through `env`, as a string or a one-element array.
The `profile`, `compose-file`, and `env-file` options accept a string or an array of strings.
Arrays preserve order. Later Compose files and environment files override earlier files.

Named environments use this public configuration:

```json
{
  "provider": "compose",
  "compose": { "files": ["compose.yaml"] },
  "environments": {
    "review": {
      "compose": { "profiles": ["tools"] },
      "envFiles": [".env.review"],
      "env": { "POSTGRES_PASSWORD": { "secret": "POSTGRES_PASSWORD" } }
    }
  }
}
```

An environment value can be a literal string, `{ "secret": "PRIVATE_KEY" }`, or `{ "env": "PROCESS_VARIABLE" }`.
Store secret values through stdin or a process variable reference. The private store uses mode 0600 outside the checkout.
Environment files support `export`, comments, quoted values, and multiline quoted values. Their values remain literal, without shell execution or variable expansion.
Global environment values apply to Docker services and Compose interpolation. Service `environment` entries control which variables enter Compose containers.

For multiple published ports, define one alias for each port:

```json
{
  "compose": {
    "files": ["compose.yaml"],
    "routes": {
      "web": { "service": "web", "target": 3000, "port": 3000, "protocol": "http" },
      "admin": { "service": "web", "target": 9090, "port": 9090, "protocol": "http" }
    }
  }
}
```

Services without published ports remain internal, including services with `expose` entries.
Use explicit protocols for ports that do not match common HTTP ports.
UDP, replicas, host namespaces, static addresses, custom network allocation, and volume driver options require separate support.
The provider rejects these features. External networks and volumes remain external and survive purge.
Remote bind and build paths must resolve inside the checkout. Remote binds cannot use files excluded from synchronization.
The daemon implements Compose volume forks through verified snapshots.

## Integration contract

Import `ComposeProvider` from `src/providers/compose.mjs` and register it under `compose`.
Docker Compose must support `config --format json`, `config --variables`, and `up --wait`.
The class implements the Docker provider interface. It uses the Docker helpers for commands, synchronization, SSH, and tunnels.
`create`, `start`, and `wait` retain desired public ports and discover private backend ports.
The daemon coordinates snapshot-based forks. Direct provider `fork` calls remain unsupported.

Each `spec.services` and `handle.services` entry has `composeService`.
Internal entries have `internal: true` and no `port`, `protocol`, or HTTP URL.
The parent must exclude internal entries when it reserves listeners, changes route focus, and formats URLs.
Published entries have `port`, `containerPort`, `protocol`, and `transport`.
Handle entries also have `container` and `hostPort`. Several aliases can refer to one container.

The initialization exports are `createInitialConfig(options)` and `initialize(options)` from `src/init.mjs`.
Both accept `cwd`, `command`, `port`, and `image`.
The first returns public configuration. The second writes a new file and returns `{ filename, config }`.
`initialize` also accepts `config` for the output filename. It never replaces an existing file.

The environment command exports come from `src/environments.mjs`:

- `setEnvironmentSecret({ cwd, environment, key, stdin })` reads a readable stream.
- `setEnvironmentSecret({ cwd, environment, key, fromEnv })` reads a process variable reference.
- `listEnvironmentSecrets({ cwd, environment })` returns sorted variable names.
- `unsetEnvironmentSecret({ cwd, environment, key })` returns whether the variable existed.

These helpers also accept `home` to select the private state directory.
`setEnvironmentSecret` accepts `env` for an explicit source environment. It rejects a literal `value` argument.
`readEnvironmentSecrets` and `loadEnvironment` return private values for runtime integration only.
`parseEnvFile`, `resolveEnvironment`, and `stringList` provide parsing and configuration helpers.

`redactEnvironment(output, values)` accepts an array or an object with private values.
Compose logs and execution output already use this helper.
The daemon applies it to Docker logs, execution output, and errors.
Keep specification values in private daemon state. Never print the full specification or write it into generated public configuration.
`spec.compose.model` captures the resolved source configuration. It can contain private values.
This snapshot preserves shell interpolation when the daemon has a different environment.
It also lets the daemon detect changes to commands, builds, health checks, and other Compose settings.
`spec.compose.environment` contains private values needed for runtime secrets and redaction.

Run `node test/compose.e2e.mjs` for the provider E2E. It creates and removes only its own resources.
Run `npm run test:features` for the integrated Compose CLI, snapshot, and worktree flow.
