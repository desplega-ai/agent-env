# Provider review resolution

The independent reviews examined the uncommitted changes against `2d1c872`.
That commit has the same tree as the default branch at `6228845`.
Both reviews used the installed CLI for their local reproductions.

## Standards

Both Critical findings are fixed:

- E2B state readers no longer acquire the service launch lock. Process identity checks detect exited supervisors.
- E2B ownership records contain only ownership metadata and the workspace path.

All four Important findings are fixed:

- Compose and Dev Containers share protocol inference. Explicit protocols override port defaults.
- E2B environment and service changes preserve sandbox data and restart changed processes.
- Public configuration rejects embedded E2B credentials.
- Compose retains automatic detection priority when both configurations exist.

Other corrections remove redundant provider stubs and version checks, align Node requirements, and permit idle HTTP streams.
Provider-specific conditions and small name validators remain explicit.
The E2B source writer remains custom because it preserves modification times and rejects symbolic-link destinations.

## Spec

All six Important findings are fixed:

- Native forwarded ports can remain closed until an application starts. Explicit routes retain readiness checks.
- Dev Container Compose supports network namespaces shared between services in the same project.
- Compose settings retain their provider and routes during automatic detection.
- `run` and `exec` execute outside the global lifecycle queue. The CLI imposes no command timeout.
- E2B commands have no separate 60-second execution limit.
- E2B removal and recreation can apply changed service configuration without purging data.

Compose changes now produce an explicit recreation instruction instead of silently using an outdated runtime copy.
Installed CLI coverage includes delayed startup, shared namespaces, shipped examples, concurrency, long E2B commands, and automatic lease expiry.
See [verification evidence](providers-verification.md).

Remaining limits are documented:

- E2B activity does not extend its configured lease. The default is 300 seconds.
- Each E2B sync uploads all eligible files in one buffered payload.
- Commands return buffered output when they finish.
- Retained E2B instances do not support automatic API key rotation.
- Dev Containers require local Docker. E2B has no raw TCP routes.
- These providers do not support agent-env snapshots or forks.
