# Owned cloud hosts and sandbox adapters

The provider registry includes `SandboxProvider` under `sandbox`.
The daemon owns scheduling, instance state, and service startup.

## Cloud integration

Import these functions from `src/cloud.mjs`:

| Export | Contract |
| --- | --- |
| `prepareCloud(spec, existingHandle?)` | Create or resume one owned Hetzner host. Return a new spec with `host`, `sshConfig`, and stable `cloud` metadata. |
| `commitCloud(handle)` | Mark infrastructure as retained after the first successful provider start. Return updated cloud metadata. |
| `sleepCloud(handle)` | Request graceful shutdown and wait for the server to stop. Preserve the server disk, address, and key. |
| `destroyCloud(handle)` | Purge the owned server, primary IPv4 address, remote SSH key, and local cloud record. |
| `cloudStatus(handle)` | Return cloud metadata, server `status`, `committed`, and `destroying`. Never create infrastructure. |
| `disposeFailedCloud(handle)` | Purge an uncommitted first start. Return `{destroyed: false, reason: 'committed'}` for retained infrastructure. |
| `cloudOptions(options)` | Validate cloud options and apply defaults. |
| `cloudInit(privateHostKey, publicHostKey)` | Generate cloud-init for supported Ubuntu and Debian images. The result contains a private key. Never log it. |
| `createCloudManager(options)` | Create an isolated manager with optional `home`, `run`, `delay`, `now`, and `readinessTimeoutMs` dependencies. |

Every lifecycle function accepts returned cloud metadata, a prepared spec, or a provider handle containing `spec.cloud`.
`prepareCloud` also accepts a persisted handle as its second argument.
The spec must contain safe `owner` and `name` values.
The cloud module does not require `provider: 'docker'`.
It only supplies the SSH transport fields that the existing Docker provider understands.

```js
const spec = {
  owner: installationOwner,
  name: 'demo',
  provider: 'docker',
  cwd: '/absolute/checkout',
  services,
  cloud: {
    provider: 'hetzner',
    type: 'cx23',
    location: 'fsn1',
    image: 'ubuntu-24.04',
    idleTimeoutMs: 1800000,
    expiresAt: null,
  },
};

let prepared;
let runtime;
try {
  prepared = await prepareCloud(spec, persistedHandle);
  runtime = persistedHandle
    ? { ...persistedHandle, spec: prepared }
    : await provider.create(prepared);
  if (persistedHandle) await provider.start(runtime);
  // Persist the runtime before commit. Retain it if a later commit attempt fails.
  await persistInstance(runtime);
  runtime.spec.cloud = await commitCloud(prepared);
  await persistInstance(runtime);
} catch (error) {
  // Call this only when no successful runtime needs retention.
  // A failed commit or persistence call needs reconciliation, not automatic purge.
  if (!runtime) {
    const cleanup = prepared ?? error.cloud;
    if (cleanup) await disposeFailedCloud(cleanup);
  }
  throw error;
}
```

The default idle timeout is 30 minutes.
Set `idleTimeoutMs: 0` to disable idle shutdown.
Set `expiresAt` to an ISO date string for explicit expiry.
These fields are metadata for the parent daemon.
The module creates no timer, cron job, or background worker.
The parent decides when to call `sleepCloud` or `destroyCloud`.
`prepareCloud` refuses an elapsed expiry until the parent extends it or destroys the instance.
Changing machine type, image, or location requires purge first.
Changing idle timeout or expiry does not replace the machine.

`cloud` metadata includes `recordId`, `owner`, `name`, `serverId`, `keyId`, `primaryIpIds`, and `createdAt`.
It also includes the cloud options and `createdForStart`.
`createdForStart` remains true until `commitCloud` succeeds.
Always persist `spec.cloud` with the provider handle.
On provisioning failure, the thrown error contains `error.cloud` when a record exists.
Use that metadata for cleanup or retry.

### Ownership and recovery

The module uses the installed authenticated `hcloud` CLI.
It creates one dedicated SSH key and one labeled primary IPv4 address before it creates the server.
The server uses that address and disables automatic IPv6 allocation.
The module creates no volumes, snapshots, or hosted credentials.

Records reside under `$AGENT_ENV_HOME/cloud/<instance-hash>/`.
The default home is `~/.local/state/agent-env`.
Directories use mode `0700`.
Records, private keys, SSH config, and known hosts use mode `0600`.
Public keys remain inside the private directory.
Cloud home paths cannot contain newlines, null bytes, or SSH percent tokens.
Records contain the context, endpoint, and a credential fingerprint. They never contain the API token.
Every API operation checks this binding and passes the checked credential directly through the child environment.
A context, endpoint, or credential change stops the operation before resource access.
Older records without a binding require manual recovery. The module preserves their SSH keys and ownership data.
Locks publish complete owner files atomically. Recovery supports dead owners and stale empty locks from older builds.

Each remote resource has these labels:

- `agent-env.owner`: the installation owner.
- `agent-env.instance`: the instance name.
- `agent-env.record`: a random ownership token from the private record.

The module stores creation intent before each external allocation.
It reconciles remote resources by token, name, labels, and stored ID after restart.
It refuses multiple matches, changed ownership, or conflicting IDs.
A missing recorded resource never causes automatic replacement.
An ambiguous creation with no visible resource also blocks replacement.
Use `agent-env rm NAME --purge` before a new allocation.

Purge checks every resource before its first deletion.
It refuses a foreign IP assignment or an untracked primary IPv6 address.
It retains records and private credentials after partial cleanup failure.
Repeat `destroyCloud` with the same handle to finish cleanup.
The module deletes the local record only after every owned remote resource is absent.
A completed purge removes the record, so another purge call rejects the missing record.

A lock file serializes operations for each instance.
The module recovers a lock when its recorded process no longer exists.
An empty, malformed, or abandoned recovery lock requires operator inspection before removal.
Never remove a live process lock.

Keep the same Hetzner project and authenticated CLI context during the instance lifetime.
Keep the ownership directory until purge completes.
Without that directory, the module refuses handles instead of claiming remote resources.
Manual record deletion can therefore leave billable infrastructure that needs operator cleanup.

### Bootstrap and SSH identity

Cloud-init installs Docker Engine, the current Compose plugin, Buildx, and rsync from Docker's official package repository.
The bootstrap supports Ubuntu and Debian images with cloud-init and systemd.
A custom image must meet those requirements.
Type, location, and image availability depend on the authenticated Hetzner project.
Live provisioning passed with CX23 in hel1. Availability remains specific to the account and location.

The module generates a dedicated host key before provisioning.
Cloud-init installs that key, and a private `known_hosts` file pins its public key.
SSH requires strict host checking and disables agent and password authentication.
The module never uses `ssh-keyscan` or automatic trust on first connection.
Readiness requires successful SSH authentication, completed cloud-init, Docker, Compose, and rsync.
A readiness failure preserves a cleanup handle.
Errors do not include captured CLI output, private keys, or credential values.

Official references:

- [Hetzner CLI server creation](https://github.com/hetznercloud/cli/blob/main/internal/cmd/server/create.go)
- [Hetzner CLI primary IP creation](https://github.com/hetznercloud/cli/blob/main/internal/cmd/primaryip/create.go)
- [Hetzner CLI SSH key creation](https://github.com/hetznercloud/cli/blob/main/internal/cmd/sshkey/create.go)
- [Docker packages for Ubuntu](https://docs.docker.com/engine/install/ubuntu/)

## Sandbox integration

Import `SandboxProvider` from `src/providers/sandbox.mjs`.
The provider receives this configuration:

```js
{
  provider: 'sandbox',
  // Include the normal owner, name, cwd, and services fields.
  sandbox: {
    adapter: 'docker', // Or './my-adapter.mjs', an absolute path, or a local file URL.
    options: {},
    requireCapabilities: ['exec', 'stop'],
  },
}
```

Relative adapter paths resolve against the absolute `spec.cwd`.
Remote URLs and package imports are unsupported.
Local adapter modules execute with the daemon's privileges.
Use only trusted adapter code.
Adapters must export `createAdapter(options)` and return an object implementing the existing provider contract.
The factory can be asynchronous.
Each provider caches adapter objects by module location and options.
A persisted handle contains `spec`, public `services`, the adapter location, and its JSON runtime handle.
Runtime connections remain outside that handle.

Every adapter must declare a boolean for every exported `SANDBOX_CAPABILITIES` entry:

```js
export function createAdapter(options) {
  return {
    capabilities: {
      create: true, start: true, wait: true, connect: true,
      stop: true, remove: true, status: true, sync: true,
      logs: true, exec: true, fork: false,
      compose: false,
    },
    // Implement each operation whose capability is true.
    // Use the signatures in src/providers/README.md.
  };
}
```

`create`, `wait`, `connect`, and `status` must be supported.
Other operations can be false and omit their methods.
The wrapper rejects unsupported operations before it calls the adapter.
It also checks `sandbox.requireCapabilities` and rejects Compose specs when `compose` is false.
`compose` describes configuration support beyond the base lifecycle methods.
Sandbox snapshots have no provider contract yet, so adapters cannot request or advertise that capability.
The adapter must clean partial allocation when its `create` method rejects.
The wrapper attempts purge if an adapter returns an invalid handle and supports `remove`.

The built-in `docker` adapter delegates to the existing Docker provider.
It supports the existing local and SSH lifecycle, named volumes, synchronization, logs, exec, and fork behavior.
It declares `compose: false`. The daemon snapshot commands require the Docker or Compose provider.
It provides container isolation at the Docker host's trust boundary.
It implements neither Firecracker nor a hosted sandbox vendor.
It needs no hosted credentials.

A local bridge module can also reuse it:

```js
import { createDockerSandboxAdapter } from '/absolute/agent-env/src/providers/sandbox.mjs';
export function createAdapter() {
  return createDockerSandboxAdapter();
}
```

## Verification

```sh
node --check src/cloud.mjs
node --check src/providers/sandbox.mjs
node --test test/cloud.test.mjs test/sandbox.test.mjs
npm test
npm run check
```

Cloud tests use an injected stateful CLI runner and real local SSH key generation.
They never call the live Hetzner API.
Sandbox tests import a local ESM module and test the real Docker provider with a simulated Docker CLI runner.
They use a real loopback listener for service readiness.
They allocate no live containers or cloud infrastructure.
Live provisioning and the registered Docker sandbox bridge passed integration tests. See VERIFICATION.md.
