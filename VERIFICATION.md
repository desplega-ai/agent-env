# Verification

Verified on 2026-11-08 (BCN).

The CLI is installed at `/opt/homebrew/bin/dev-now` through a link to this checkout.
The implementation uses no third-party Node packages and requires no build step.

## Checks

- `npm run check`: passed syntax checks for the CLI and runtime modules.
- `npm test`: passed six tests covering configuration, shell quoting, HTTP routing, request bodies, cookies, WebSocket upgrades, streaming, and connection selection.
- `npm run test:e2e`: passed with local Docker on macOS and Node 26.0.0.
- `DEV_NOW_TEST_SSH=dev-now-test DEV_NOW_TEST_SSH_CONFIG=<temporary-config> npm run test:e2e`: passed against a temporary Hetzner CX23 running Ubuntu 24.04.
- The installed CLI started `examples/hello`, including its Postgres service.
- `curl http://demo.localhost:3300/` returned the example without a DNS override.
- `curl -g 'http://[::1]:3300/'` returned the same example through IPv6 loopback.
- Immediate daemon stop, start, and stop commands passed without an external delay.

The complete local and remote tests checked these behaviors:

- Multiple stacks share public ports and have independent named addresses.
- Hostname selection and bare-localhost selection route requests correctly.
- Postgres responds through the TCP proxy.
- Each stack has separate database and application volumes.
- Data survives container stop and resume.
- Remote source changes synchronize, while `.env` stays local.
- Daemon restart restores routing and the selected instance.
- Forks copy stopped data and preserve independent database writes.
- A running source cannot be forked.
- A fork cannot overwrite retained destination volumes.
- Failed initial starts remove newly allocated volumes.
- Occupied public ports fail without stopping their owner.
- An executed command's exit code reaches the CLI.
- Workspace and state paths containing spaces work locally and through SSH.

HTTP and WebSocket checks used protocol clients. No browser UI test was required or performed.
Node 22 is the declared minimum. The host test run used Node 26.

## Cleanup

The temporary Hetzner server, its IPv4 and IPv6 addresses, and the temporary SSH key were deleted.
The original Hetzner SSH key remains.
No test containers, networks, volumes, daemons, or SSH tunnels remained.
The tests removed their temporary directories. Final cleanup removed another 60 KiB of temporary files, including the private test key.
`df -h /` showed 12 GiB available immediately before and after final cleanup.
Shared Docker images and other shared caches remain.

## Scope

Implemented: Docker locally and over SSH, localhost routing, persistent volumes, cache mounts, service stacks, and stopped-volume forks.
Not implemented: Firecracker execution, S3 backup or restore, automatic VPS provisioning, continuous file synchronization, HTTPS, and a browser switcher.
The README and provider contract describe these extension points.
