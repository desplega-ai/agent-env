# Verification

Verified on 2026-11-08 (BCN), on macOS with Node 26.0.0 and Docker.
The installed `/opt/homebrew/bin/dev-now` links to this checkout. No build step or npm dependencies are required.
Node 22 is the declared minimum. This session did not test Node 22 directly.

## Automated checks

- `npm run check` and `git diff --check` passed.
- The initial `npm test` run passed 75 tests. Independent review reproduced a race during snapshot inspection on subsequent runs.
- The fix tolerates unrelated container removal while preserving other inspection failures.
- Three consecutive isolated `npm test` runs then passed all 87 tests, with no skips.
- After the standards fixes, the final `npm test` run passed all 95 tests at default concurrency, with no skips.
- Regression tests cover explicit cloud selection, idle shutdown, expiry, active peers, reconnect backoff, and secret redaction.
- Native Docker E2E passed locally and through SSH.
- Compose provider E2E passed builds, profiles, dependencies, completed jobs, aliases, health, isolation, external resources, and cleanup.
- Integrated Compose CLI E2E passed locally and through SSH.
- Runtime E2E passed HTTPS, dashboard requests, redaction, and daemon restart.
- Remote runtime E2E killed an owned SSH tunnel and confirmed automatic recovery.
- Remote runtime E2E confirmed automatic source synchronization.
- The registered sandbox Docker bridge passed the runtime E2E.
- Generated Postgres and Redis templates passed with native Docker and Compose. Redis retained writes across restart.

The integrated Compose test exercised environment secrets, source preservation, Git worktree creation, copied changes, omitted credentials, snapshots, restore, and independent Postgres writes.
After review fixes, the local test also resumed a secret-bearing fork from both directories and retained redacted output from failed commands.
Local runtime and both service template E2E variants passed again after these fixes.
The real Compose E2E also passed delayed volume purge after removal of its runtime file.
The native Docker test also checked occupied ports, failed startup cleanup, retained-volume protection, command exit codes, and paths containing spaces.

The cached local example started in approximately 4.2 seconds and resumed in 0.65 seconds.
The remote native stack started in approximately 10 seconds and resumed in 4.1 seconds during this run.
These measurements depend on image caches, machine load, and network latency.

## S3

A temporary SeaweedFS server supplied a real S3-compatible endpoint.
The test used this official Docker image digest:

`chrislusf/seaweedfs@sha256:c2658820e763294a9e9de7b36c81e59b879e3459148351aee4e31a126ca64860`

The CLI exported stopped Postgres volumes, restored fresh volumes from S3, and verified independent database contents.
A second conditional write to the existing manifest failed with a precondition error.
AWS-hosted S3 was not tested. Unit tests also cover AWS CLI arguments and interrupted transfers.
The [SeaweedFS quick start](https://github.com/seaweedfs/seaweedfs#quick-start) documents the temporary server configuration.

## Hetzner

The new cloud module provisioned a CX23 in hel1 with Ubuntu 24.04, Docker, Compose, rsync, dedicated SSH credentials, and a pinned host key.
Live CLI checks confirmed:

- Startup and local HTTP access.
- Container shutdown followed by machine shutdown.
- Resume with durable volume contents.
- Container removal with visible retained cloud data.
- Recreating containers from retained volumes.
- Automatic idle shutdown after an explicit short test timeout.
- Resume after idle shutdown.
- Forking onto the same owned machine with independent volume contents.
- Expiry of both instances, followed by deletion of the owned server, IPv4 address, and SSH key.

A transient power-on failure occurred during testing. A retry succeeded without replacing the machine.
The module now reconciles state and retries bounded power-on failures. Regression tests cover failures before and after the API side effect.
The final server inventory was empty. Checks also confirmed deletion of the owned IP and key.
Unrelated SSH keys remained untouched.

After the standards review, a second temporary CX23 in hel1 passed the committed `test:cloud` script.
It rejected a changed credential before any API request and retained its local recovery keys.
It synchronized `src/build`, recreated a retained fork without losing worktree ownership, and preserved its volume contents.
Both instances then slept. Expiry deleted their shared machine without waking it.
Explicit inventory checks found no server, IP, or key with that test record's label.

## HTTPS and UI

Protocol tests validated the private CA, exact hostnames, HTTP/1.1, HTTP/2, secure upgrade forwarding, and same-origin header translation.
They also checked conflicting HTTPS aliases and dashboard access restrictions.
Four concurrent processes generated certificates against one CA. Tests confirmed matching keys and rejected a certificate for an external domain.
The session did not install the CA into the user's trust store. HTTPS clients used the generated CA explicitly.

Agent-browser verified the dashboard at 1440×900 and 390×844.
The mobile document width and scroll width were both 390 pixels.
Logs opened and closed correctly. The refresh preference survived reload.
Axe reported zero violations, zero incomplete checks, and 34 passes.

- [Desktop screenshot](docs/screenshots/dashboard-desktop.png)
- [Mobile screenshot](docs/screenshots/dashboard-mobile.png)

These checks used automated Chromium. They do not establish physical Safari behavior.

## Cleanup and boundaries

The owned cloud machine, IP, and key were deleted.
The temporary S3 container, its data, its test image, and failed-test build image tags were removed.
Temporary UI services and the browser session were stopped.
Implementation worktrees were integrated and removed. All 18 task-prefixed temporary artifacts were removed.
Final Docker inventories contained no dev-now test containers or volumes.
Shared Docker caches were preserved. No global prune command ran.

Disk availability changed from 9.8 GiB before the initial cleanup to 11 GiB afterward.
The first review pass removed its resources and temporary files. Available space remained 11 GiB at displayed precision.
The second pass removed its resources and a verified older fixture containing 29,387 bytes.
Disk availability was 11 GiB before that pass and 10 GiB afterward. Shared caches remained untouched.
The daemon must remain running and connected for idle shutdown and expiry.
Snapshots contain volume data, not a complete deployable source bundle.
Firecracker execution and specific hosted sandbox vendors remain separate adapter work.

## Independent review

The specification review found one critical issue and four important issues. All five received fixes and regression coverage.
The fixes prevent implicit cloud provisioning, preserve ordinary output, resume saved forks, tolerate concurrent container removal, and test maintenance decisions.
Minor fixes scope service templates to their environment, support delayed Compose volume purge, complete CLI help, and preserve failed command output.
Dashboard timestamps remain in BCN to follow the explicit project instructions.
Automatic initialization supports Compose and Node projects. Other runtimes require an explicit command.
Cloud timers apply to owned Hetzner machines.

The engineering standards review found one critical issue and four important issues in the earlier revision.
Its snapshot race and redaction findings overlapped the specification review.
The remaining fixes bind cloud records to credentials, expire sleeping peers together, and unify source exclusions.
Snapshot discovery now filters containers by volume or instance before inspection.
Minor fixes add lifecycle backoff, share cloud defaults, clarify purge recovery, serialize TLS generation, and recover stale locks.
The unused sandbox snapshot capability was removed.
Anonymous Compose volumes now fail before export unless explicitly omitted.
The live cloud test confirmed that container recreation retains worktree ownership.
No critical or important finding remains unresolved.
