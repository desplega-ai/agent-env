# agent-fs acceptance verification

Verified on 2026-11-09 BCN through audited, installed agent-env archives.
Source commit: `4c630a31f610119554ee79fee927f21ca2f13991` (agent-fs 0.18.16, Bun 1.4.4).
Host: macOS arm64, Node.js 26.0.0, Docker 29.8.2, Compose v5.5.0.
Containers used Linux arm64.

Two fresh implementation runs and the parent runner passed at package version 0.6.0.
The combined 0.6.1 archive then passed with `AGENT_ENV_SDK_TARBALL` selecting that archive.
The published 0.6.0 package does not contain this new example.

```sh
AGENT_ENV_TEST_AGENT_FS=1 \
AGENT_ENV_AGENT_FS_SOURCE=/path/to/agent-fs \
AGENT_ENV_SDK_TARBALL=/absolute/path/desplega.ai-agent-env-0.6.1.tgz \
npm run test:agent-fs
npm run check
git diff --check
```

Verified behavior:

- SDK `up` starts the real Compose API and S3 backend.
- The localhost route rejects anonymous and invalid-key requests, then accepts a generated API key.
- SDK `run` executes CLI write, read, and history checks against the real agent-fs source.
- Authenticated S3 requests return both current and historical file bytes. Anonymous S3 requests fail.
- A copied source edit changes the live HTTP response. SDK `exec` reads the changed source.
- SDK `down` retains ten named volumes. SDK `resume` preserves authentication, metadata, file versions, and the source edit.
- Purge removes the owned containers, volumes, and networks. The original source checkout remains unchanged.
- The direct E2E entrypoint skips without its opt-in variable.

The fixture uses digest-pinned Coollabs MinIO because Docker Hub and Quay rejected the upstream image pulls.
See [the guide](../../docs/agent-fs.md) for the image digest and isolation details.
The npm runner also exposed metadata names that the SDK environment validator rejects.
The standalone example removes those names before constructing its isolated environment.

All test-owned fixtures, generated credentials, daemon state, temporary installations, and volumes were removed.
Shared images and package caches remained.
FUSE, embeddings, browser rendering, cloud execution, and the complete upstream test suite were not tested.
