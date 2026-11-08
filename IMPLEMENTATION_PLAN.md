# Runtime expansion

This is the historical plan for the `dev-now` prototype.
The project now uses `agent-env` and CLI E2E tests.
See [the README](README.md) and [release instructions](docs/releases.md) for current commands.

Taras authorized autonomous implementation of the roadmap on 2026-11-08.
Exclude the injected browser switcher. Include a small status UI and HTTPS.

Implementation and live validation are complete. Both independent reviews received fixes and regression coverage.
See VERIFICATION.md for evidence and explicit limits.

## Phase 1: Project and provider foundations

- Support existing Compose projects, profiles, builds, dependencies, health checks, isolated project names, and dynamic host ports.
- Add named environment profiles, explicit environment files, secret references, and framework-aware initialization.
- Define provider capabilities and support external sandbox adapters without silently promising unsupported Compose or snapshot features.
- Preserve the existing Docker manifest and commands.

### Verification

`npm test`
`node --test test/compose.test.mjs test/environments.test.mjs`
`npm run test:e2e`

## Phase 2: Machines and persistent environments

- Provision Hetzner hosts on demand, using owned keys and infrastructure records.
- Implement resume, idle shutdown, optional expiry, and owned-resource cleanup.
- Add complete Git worktree and data forks with rollback.
- Export consistent volume snapshots locally and to S3-compatible storage. Verify checksums during restore.

### Verification

`node --test test/cloud.test.mjs test/snapshots.test.mjs test/worktrees.test.mjs`
`npm run test:e2e`
`DEV_NOW_TEST_SSH=<host> DEV_NOW_TEST_SSH_CONFIG=<config> npm run test:e2e`

## Phase 3: Daily operation

- Synchronize changed remote files automatically with exclusions and debounce.
- Recover lost SSH tunnels with bounded retry and visible status.
- Provide HTTPS with a local CA and explicit trust installation. Preserve loopback binding.
- Add a minimal status UI with instances, services, health, URLs, and logs. Do not inject UI into application pages.
- Add useful service templates and refresh documentation and verification evidence.

### Verification

`npm run check`
`npm test`
`npm run test:e2e`
`curl --cacert <state>/tls/ca.pem https://<instance>.localhost:<https-port>`
`curl http://127.0.0.1:<ui-port>/api/status`

## Manual E2E

```sh
cd examples/hello
dev-now up --name local
dev-now up --name remote --cloud hetzner
dev-now list
dev-now ui
curl --resolve local.localhost:3300:127.0.0.1 http://local.localhost:3300/
dev-now exec remote --service db -- psql -U postgres -d app -c 'select 1'
dev-now down remote
dev-now snapshot remote /tmp/dev-now-checkpoint
dev-now down local
dev-now fork local feature-check --worktree /tmp/dev-now-feature-check
dev-now rm feature-check --purge --remove-worktree --discard-worktree
dev-now rm remote --purge
dev-now rm local --purge
dev-now daemon stop
```

For S3, replace the local snapshot directory with `s3://<bucket>/<new-prefix>` and supply `--endpoint <url>` when needed.
Use a temporary S3-compatible server for storage E2E when no dedicated cloud bucket is configured.
Delete owned test machines, keys, containers, volumes, worktrees, and temporary files afterward.
