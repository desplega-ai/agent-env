# Provider interface

Register an implementation in `index.mjs`. A provider receives a validated specification:

```js
{
  provider: 'docker',
  owner: 'installation-hash',
  name: 'instance-name',
  cwd: '/absolute/local/checkout',
  host: 'optional-ssh-alias',
  sshConfig: '/optional/ssh/config',
  services: {
    web: {
      image: 'node:22-bookworm-slim',
      port: 3000,
      containerPort: 3000,
      protocol: 'http',
      command: 'npm run dev',
      env: {},
      volumes: { dependencies: '/workspace/node_modules' }
    }
  }
}
```

The returned handle must be JSON serializable. It contains `spec` and `services`.
Each published service includes its public `port` and `protocol`.
Compose internal services use `internal: true` and omit routing fields.
The provider can add container IDs, workspace paths, published ports, or VM IDs.
Runtime connections stay outside the persisted handle.

Implement these methods:

| Method | Contract |
| --- | --- |
| `create(spec)` | Allocate resources, start services, wait for readiness, and return a handle. Clean partial allocation on failure. |
| `start(handle)` | Resume existing resources and wait for readiness. |
| `wait(handle)` | Check existing resources and refresh their connection information. Do not create new resources. |
| `connect(handle)` | Return `{name, backendPort, close()}` for each service. The port must accept connections on local loopback. |
| `stop(handle)` | Stop compute while retaining persistent data. |
| `remove(handle, purge)` | Remove compute. Remove persistent data only when `purge` is true. |
| `status(handle)` | Return a map from service names to runtime states. |
| `sync(handle)` | Synchronize local source files when the runtime needs a copy. |
| `logs(handle, service)` | Return recent stdout and stderr. |
| `exec(handle, service, argv)` | Execute arguments without implicit shell interpretation. Return output or throw on failure. |
| `fork(handle, destinationSpec)` | Copy stopped data and create a destination. Never overwrite existing destination data. |

`connect` may include a Node child process as `child` for SSH tunnel status.
Each `close()` must release only its own connection.
An optional `dispose()` method closes provider sessions when the daemon stops.
The daemon owns public listeners, hostname selection, private state, and command serialization.
Providers own compute, source synchronization, readiness, and persistent volumes.

The initial Docker implementation combines compute and local/SSH transport in one class.
Split transport implementations only when another provider needs them.
A Firecracker implementation can return the same local connection contract through SSH or a VM network.
Its host must support KVM. Its service image format can differ, but it must retain the public service contract.

The snapshot module exports and restores verified archives locally or through S3.
Compose supplies `snapshotVolumeNames` and `snapshotVolumeLabels` to map restored volumes.
The daemon coordinates Compose forks through these snapshot hooks. An object store is not a substitute for a database's active block storage.
