# agent-fs acceptance

This example starts the real agent-fs API and MinIO through the public agent-env SDK.
It needs Node.js 22.19 or later, Git, npm, Docker, and Docker Compose.
It needs network access for container images and Bun dependencies.
It needs no cloud account or production credentials.

Run the opt-in suite from an agent-env checkout:

```sh
npm ci --ignore-scripts
AGENT_ENV_TEST_AGENT_FS=1 \
AGENT_ENV_AGENT_FS_SOURCE=/path/to/agent-fs \
npm run test:agent-fs
npm run check
git diff --check
```

The entrypoint audits an npm archive of this checkout and installs it in a temporary prefix.
The installed example imports `@desplega.ai/agent-env` through its public export.
Every SDK call invokes that installation's CLI.
Set `AGENT_ENV_SDK_TARBALL=/absolute/path/package.tgz` to test an existing archive that includes this example.
The suite skips unless `AGENT_ENV_TEST_AGENT_FS=1`.
Ordinary CI does not require the agent-fs source checkout.

To run the example from a separately installed package:

```sh
mkdir /tmp/agent-env-agent-fs-consumer
npm install --prefix /tmp/agent-env-agent-fs-consumer --ignore-scripts --no-package-lock \
  /absolute/path/desplega.ai-agent-env-0.6.1.tgz
node /tmp/agent-env-agent-fs-consumer/node_modules/@desplega.ai/agent-env/examples/agent-fs/acceptance.mjs \
  /path/to/agent-fs
rm -r /tmp/agent-env-agent-fs-consumer
```

Use an archive from this implementation until a published package includes the example.

The workflow performs these checks:

1. Export the source checkout's current commit with `git archive`.
2. Exclude environment files and npm configuration files from the export.
3. Generate S3 credentials, a private environment file, an instance name, and a free route port.
4. Start Compose with `client.up({ envFiles: ['fixture.env'], watch: false })`.
5. Check HTTP health and reject anonymous requests and invalid API keys.
6. Register a fixture user and check authenticated HTTP access through the public route.
7. Run `client.run(name, 'test', ['write'])` against the real API and S3 backend.
8. Edit the copied health route and wait for the running server to return the new marker.
9. Check the copied file through `client.exec`.
10. Call `client.down`, verify retained volumes, and call `client.resume`.
11. Run the persistence checks through `client.exec`.
12. Call `client.remove(name, { purge: true })` and verify resource removal.

The named test runs the agent-fs CLI from the copied source.
It writes two versions, reads content through CLI and HTTP, and checks history.
It also reads both object versions directly through authenticated S3 requests.
Anonymous object access must return HTTP 403.
The persistence check repeats these reads with the same API key after resume.
This checks SQLite metadata, authentication, S3 content, and S3 history.

The Compose file uses the same Bun version as the inspected source repository.
It mounts the copied source and uses named Linux volumes for root and workspace dependencies.
The setup service installs the frozen lockfile with lifecycle scripts disabled.
It creates a real S3 bucket and enables versioning before the API starts.
MinIO remains internal to the isolated Compose network.

The upstream `minio/minio` image could not be pulled during verification.
The Quay mirror also rejected the pull.
This fixture uses the [Coollabs MinIO image](https://github.com/coollabsio/minio), pinned to the verified digest:

```text
ghcr.io/coollabsio/minio@sha256:69b55a1c1c5dc285ce04db96689f5b2102317fc77a50680a1874ca6efd1c87f9
```

The acceptance checks verify its S3 authentication, versioning, and byte preservation.
This selection changes only the example fixture.

The workflow never copies ignored files, host dependencies, or uncommitted source edits.
It clears inherited environment values for SDK calls except local execution and Docker connection settings.
It uses only its generated environment file.
Bun also disables automatic environment file discovery.
The API uses real registration and API keys.
The fixture disables telemetry and leaves embedding credentials empty.
Search embeddings, FUSE, the web UI, and the full upstream suite are outside this acceptance scope.

The workflow removes its containers, networks, volumes, source export, environment file, and daemon state.
The E2E wrapper removes its package installation and archive.
Shared container images and shared package caches remain available.
If resource cleanup fails, the workflow retains its private fixture directory for recovery.
Its error reports the directory path.
The workflow reports disk space before and after execution.
