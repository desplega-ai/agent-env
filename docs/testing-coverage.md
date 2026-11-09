# Functional test coverage audit

Audit date: 2026-11-09.
Subject: agent-env 0.5.0, commit `1e5f1d4` (master). CI published this commit.
Scope: released code only. See section 9 for the storage profile work in progress.
No test ran for this audit. No paid resource was used. No source, test, or CI file changed.

## Follow-up implementation, not yet released

The original audit below describes release 0.5.0. This section records subsequent work on `feat/storage-profiles`.

- `daemon.e2e.mjs` now covers concurrent daemon startup, one socket owner, human output, standalone HTTPS, and dashboard HTTP behavior.
  It passed through an installed package and is registered in the core group.
- `lifecycle.e2e.mjs` covers concurrent service startup, daemon crashes, route focus, retained data, external stops, and interrupted startup.
  Initial execution reproduced Docker and Compose resource leaks after a daemon crash during startup.
  Both failure assertions remain enabled. The recovery implementation passed all 16 installed-CLI lifecycle scenarios.
  These include partial creation, direct purge, retained data, failed retries, and foreign-resource refusal.
  The Docker group includes the lifecycle suite. Final reviews identified additional failures, which the focused suite now covers.
- `recovery.e2e.mjs` adds seven local cases and seven optional cases through localhost SSH.
  All 14 passed through the installed CLI after the final review fixes.
  They cover anonymous mounts, image-declared volumes, live builds after daemon death, and a worker killed during an existing instance's rebuild.
  They verify explicit acknowledgement, refusal of active process groups and foreign resources, named-data retention, and completed journal cleanup.
  Plain removal and environment changes retain anonymous data. Purge and failed startup remove attached anonymous volumes.
  Real SSH checks cover Docker and Compose cleanup, foreign-resource refusal, and a denied workspace deletion that preserves the recovery record.
  The Docker group includes the local cases. The ordinary SSH fixture enables all 14 against the same Docker engine.
- Lifecycle cleanup checks containers, networks, volumes, and generated images independently of saved instance handles.
  It records anonymous volume IDs from owned container mounts and checks those IDs after container deletion.
- `storage.e2e.mjs` and `storage-s3.e2e.mjs` cover named profiles through the installed CLI.
  Real SeaweedFS checks include credential isolation, conditional writes, a 300 MiB snapshot, restore, and private-file cleanup after SIGINT.
  Checks also cover project-only selection, initialization after rejected configuration creation, and endpoint isolation from AWS environment variables and configuration files.
- `sdk.e2e.mjs` compiles a strict TypeScript consumer against the installed public export.
  Real Docker checks cover lifecycle, commands, CLI interoperability, isolated clients, large output, snapshots, restore, and fork.
  Default errors exclude command output. Optional diagnostic errors retain CLI redaction and expose failed-command output.
  CI uses the same package archive for SDK and CLI checks.

These additions do not establish complete feature coverage.
Paid-provider interruption cases, live storage-vendor compatibility, and the remaining negative cases below still need separate evidence.

### Final local verification, 2026-11-09 BCN

The final pass used a packed, installed CLI whose `src` and `bin` files matched the working tree.
The core group, 14 recovery scenarios, and 16 lifecycle scenarios passed.
Native Docker, Compose, both dotenv suites, local snapshot/fork integration, and the installed SDK suite also passed.
The SDK suite included strict TypeScript compilation and the CI example.
An isolated Agent Swarm checkout passed authentication, HTTP routing, KV writes, and retained reads after restart.
Each fixture removed its owned resources. The original Agent Swarm checkout remained unchanged.

Recovery checks used real localhost SSH and the same Docker engine as the local tests.
They did not simulate a host reboot or verify interruption across different hosts.
Lost receipts require explicit acknowledgement after the operator confirms that local and remote allocation commands have stopped.
The earlier SeaweedFS run remains the evidence for S3 compatibility. This final recovery pass did not use paid providers.

Reproduce the focused checks with an installed archive:

```sh
export AGENT_ENV_CLI=/absolute/install/node_modules/.bin/agent-env
export AGENT_ENV_SDK_TARBALL=/absolute/tested-package.tgz
node test/run.mjs core
node test/lifecycle.e2e.mjs
AGENT_ENV_TEST_RECOVERY_SSH=loopback-alias \
  AGENT_ENV_TEST_RECOVERY_SSH_CONFIG=/absolute/ssh-config \
  node test/recovery.e2e.mjs
node test/e2e.mjs
node test/compose.e2e.mjs
node test/dotenv.e2e.mjs
node test/dotenv-compose.e2e.mjs
node test/features-e2e.mjs
node test/sdk.e2e.mjs
```

The recovery SSH alias must reach the same Docker engine as the local CLI.
Without the two SSH variables, the recovery suite runs its seven local scenarios.

### Release compatibility checks

PR CI exposed two failures on Docker 28.0.4 and Compose 2.38.2.
Compose recreated prepared containers during `up`, which changed anonymous mount handling and left volumes after purge.
Startup now uses `--no-recreate` after `create` reconciles the containers.
The partial-creation test also assumed that daemon termination stops the detached Compose worker.
It now verifies batch completion, removes one owned container, and tests recovery from that known partial state.
Fixture cleanup tracks every owned image tag, including multiple tags for one image ID.
Untagged build results remain outside the runtime cleanup contract, like other Docker build caches.

The updated installed package passed all seven recovery and 16 lifecycle scenarios in an isolated Linux Docker 28.0.4 engine with Compose 2.38.2.
The isolated Agent Swarm example also passed startup, authentication, routing, and persistence after restart with the startup change.

## 1. Short answer for Taras

No. The test suite does not cover the whole functionality.

What the suite proves well (ordinary CI, Linux):

- Happy paths of the native Docker, Compose, Dev Container, SSH, and S3 flows.
- HTTP, WebSocket, TCP, and HTTPS routing on one machine.
- dotenv order, secret store, and output redaction for exec and failed commands.
- Failed-start cleanup for native Docker, Compose, and Dev Containers.
- Snapshot, restore, and fork data isolation with local and S3 storage.

What the suite does not prove:

- Recovery after an interrupted `up`, a crashed daemon, or a lost `state.json`.
- Any concurrency except "`run` or `exec` does not block other commands".
- Any Docker, routing, HTTPS, or UI behavior on macOS. macOS CI runs the core group only.
- Hetzner and E2B. Neither is in the release gate. E2B has no workflow.
- Idle shutdown, power-off after `down`, and interrupted cloud allocation.
- Negative paths of forks, worktrees, snapshots, and Compose isolation rules.
- Human-readable CLI output. Every test uses `--json`.

Seven flags or commands have no assertion at all:
`--omit-mounts`, `--branch`, `--ref`, `--cloud-type`, `trust`, standalone `https`, and a nonzero `--idle-minutes`.
Basis: I searched `test/` for each name and found no use. Details are in section 4.

The top five missing tests are in section 7 (G1 to G5).
G1 and G3 probably expose real product gaps (from code reading, not run).

## 2. How to read the evidence

Labels used in this document:

- **[CI]** I saw the suite run and pass in the GitHub Actions log of run `42540141451` (push to master, commit `1e5f1d4`). All 12 jobs passed, including `Publish tested package`. I read the logs with `gh` (read only).
- **[FILE]** I read the assertion in the test file. I did not see it run.
- **[CODE]** Inferred from source reading. I did not execute it. Treat as a hypothesis.
- **[MANUAL]** Stated in a document as a manual check. CI cannot repeat it.
- **[NONE]** No test asserts it.

A test file that exists is not proof. Only [CI] shows execution.

## 3. Where each suite runs

Source: `test/run.mjs:5-16`, `.github/workflows/ci.yml:65-155`, `scripts/ci-e2e.sh:35-43`.

| Group | Files | Ordinary CI | Evidence |
| --- | --- | --- | --- |
| core | core, skill, prerequisites | Yes. ubuntu-24.04 and macos-15, Node 22 and lts (4 jobs) | [CI] 3 PASS lines in each of 4 jobs |
| docker | e2e, runtime-e2e, proxy, dotenv, commands. Then e2e and dotenv again with the sandbox bridge | Yes. Linux, Node lts | [CI] 7 runs, all PASS |
| compose | compose, features, goodies, dotenv-compose, goodies with Compose templates | Yes. Linux, Node lts | [CI] 5 runs, all PASS |
| devcontainer | devcontainer | Yes. Linux, Node lts | [CI] PASS |
| ssh | e2e, runtime-e2e, features, compose (loopback sshd) | Yes. Linux, Node lts | [CI] 4 runs, all PASS |
| s3 | features (SeaweedFS) | Yes. Linux, Node lts | [CI] PASS ("S3 snapshots") |
| cloud | cloud | No. Manual dispatch, `master` only, protected environment `hetzner-e2e` (`hetzner-e2e.yml:3-4,20-21`) | [NONE] in this audit. Taras says a run is in progress |
| e2b | e2b | No workflow. Local only, `AGENT_ENV_TEST_E2B=1` (`run.mjs:46`) | [NONE] in this audit. Taras says a run is in progress |

The release job needs `package` and `ci` only (`ci.yml:157-163`).
A release can ship with failing or never-run cloud and E2B suites.

Two earlier PR runs failed on real defects and were fixed afterwards:
run `42538341432` (Dev Container `up` failed) and run `42523436710` (unavailable-engine message).
This shows the suite can detect failures. It is not a coverage measure.

Suites that support SSH but do not run in the SSH group (`run.mjs:13`):
`proxy.e2e.mjs` (uses `targetOptions`), `dotenv.e2e.mjs`, `dotenv-compose.e2e.mjs`, `goodies-e2e.mjs`.
`commands.e2e.mjs` has no SSH option at all.
So dotenv, project commands, WebSocket routing, and service templates never run through SSH in CI.

## 4. Feature to evidence map

Line references use `file:line`.

### 4.1 CLI surface, init, skill

- [CI] Help, version, JSON output, and 16 misuse cases: `core.e2e.mjs:21-44`. Each case checks exit code and message, and checks that no secret leaks (`:12`).
- [CI] Startup timeout validation from flag and config: `core.e2e.mjs:46-54`.
- [CI] `init` for explicit command, npm, pnpm, bun, yarn, Compose, Dev Container, and conflicts: `core.e2e.mjs:55-90`.
- [CI] Bundled skill output and real Codex and Claude Code install: `skill.e2e.mjs:20-43`. This needs the public skills installer and the network.
- [CI] Missing Docker gives an actionable error and no state: `prerequisites.e2e.mjs:13-24`.
- [NONE] Human-readable output of `up`, `list`, `down`. `helpers.mjs:61` always adds `--json`.
- [NONE] Generated `init` commands for Node projects never run. Tests only match strings (`core.e2e.mjs:66-79`).

### 4.2 Native Docker lifecycle and routing

- [CI] `up`, `exec`, `use`, `list`, `down`, `up`, volume persistence: `e2e.mjs:63-100`.
- [CI] Named instances are isolated (own database): `e2e.mjs:73-76`.
- [CI] Host routing: named, bare `localhost`, 404 for unknown name, 403 for foreign host: `e2e.mjs:67-68,77-81`.
- [CI] Postgres TCP route through SSLRequest probe: `e2e.mjs:113-125`.
- [CI] Failed start removes partial data. Failed start with an earlier data volume keeps it: `e2e.mjs:134-148`.
- [CI] Startup timeout and retry: `e2e.mjs:149-157`. Occupied port is rejected and the owner keeps it: `e2e.mjs:158-168`.
- [CI] Exit code and both output streams: `e2e.mjs:126,169-171`.
- [CI] HTTP bodies, cookies, streaming, WebSocket, focus change closes focused sockets: `proxy.e2e.mjs:66-94`. Docker job only.
- [CI] Engine unavailable error and no state: `e2e.mjs:49-58`. Local run only.
- [NONE] Change of image, port, or service on a running instance. The code throws "Configuration changed" (`daemon.mjs:203-205`). Only the Dev Container variant is tested (`devcontainer.e2e.mjs:240-242`).
- [NONE] Two homes on one Docker engine with the same instance name.
- [NONE] Same port with two protocols (`daemon.mjs:61`).

### 4.3 Daemon, recovery, concurrency

- [CI] Graceful `daemon stop`, automatic restart, selected route restored, data intact: `e2e.mjs:90-94`, `runtime-e2e.mjs:54-57`, `commands.e2e.mjs:67-68`.
- [CI] SSH tunnel killed, then recovered by the daemon: `runtime-e2e.mjs:44-53`. SSH group only.
- [CI] A long `run` or `exec` does not block `list`, `logs`, another `run`, or `up` and `rm` of another instance: `commands.e2e.mjs:29-47`.
- [NONE in release 0.5.0] Daemon killed with SIGKILL. The unreleased lifecycle suite now verifies daemon crashes during Docker and Compose startup.
  The original 16 scenarios passed independently. Review then reproduced leaks from anonymous volumes and a build that survived the daemon.
  The focused recovery suite now reproduces those cases and verifies their fixes. Stale startup-lock recovery remains a separate gap.
  Localhost SSH checks also verify workspace removal after failed Docker and Compose startup.
  Ownership failures and denied workspace deletion preserve the recovery record.
- [NONE] Corrupt `state.json` (`daemon.mjs:22`).
- [NONE] Container stopped or killed outside agent-env, then `list` and `up NAME`.
- [NONE] Parallel CLI starts racing to launch the daemon (`bin/agent-env.mjs:77-108`).
- [NONE] Two parallel `up` commands. `list` during a slow `up`. `down` during `exec`.
- [CODE] `daemon.mjs:454` queues every message except `run`, `exec`, `ping`, and `shutdown`. `list` and `logs` wait behind a running `up`. The `list` client times out after 600 s (`bin/agent-env.mjs:61`). Agent Swarm `up` may take 900 s (`examples/agent-swarm/VERIFICATION.md:65`).
- [CODE] Local instances get no reconnect or health check (`maintenance.mjs:60`).
- [CODE] State is saved only after `connect` (`daemon.mjs:237-244`). See G1.

### 4.4 Compose provider

- [CI] Build, profiles, health dependencies, completed jobs, route aliases, loopback-only ports, isolated data, secrets and configs, persistence: `compose.e2e.mjs:74-135`.
- [CI] Failed new stack leaves no container, network, or volume. Failed restart keeps the old volume: `compose.e2e.mjs:137-176`.
- [CI] External volume and network survive `rm --purge`. Purge removes the built image: `compose.e2e.mjs:178-214`.
- [CI] Leak checks at the end: `compose.e2e.mjs:227-235`.
- [CI] The same suite also passes through the SSH fixture (ssh job).
- [NONE] Unsupported-feature rejection (`compose.mjs:66-90`): Docker socket mount, `network_mode`, replicas, UDP, host namespaces, external secrets.
- [NONE] Remote path escape and symlink rejection (`compose.mjs:176-186`).
- [NONE] Changed Compose file on a running native Compose instance.

### 4.5 Dev Containers

- [CI] Image, Dockerfile, and Compose definitions. JSONC kept. All lifecycle hooks. Workspace user. Hot reload. Named volume persistence. Purge: `devcontainer.e2e.mjs:60-126,163-202`.
- [CI] HTTP and TCP routes, lazy start with 502 until a command starts the app: `devcontainer.e2e.mjs:128-152`.
- [CI] Shared network namespace, stale Compose change error, recreate keeps data: `devcontainer.e2e.mjs:204-249`.
- [CI] Shipped examples run from the installed package: `devcontainer.e2e.mjs:271-283`.
- [CI] Failed hooks leave no container, volume, or network. SSH and cloud targets are refused: `devcontainer.e2e.mjs:285-305`.
- [FILE, weak] `fork` and `snapshot` refusal asserts only a nonzero exit (`devcontainer.e2e.mjs:258,261`).
- [NONE] Rejected settings: `appPort`, `runArgs`, unsafe build options, external volumes, static addresses (`devcontainer.mjs:117-120,153,214-222`).

### 4.6 Project commands

- [CI] Shell and array forms, `--service`, literal arguments (`$(id)` stays literal), exit code 23, redaction, edit without recreate, daemon restart, Compose environment overlay: `commands.e2e.mjs:29-82`.
- [FILE, weak] Missing command, missing name, and bad service assert only a nonzero exit (`commands.e2e.mjs:58-60`).

### 4.7 dotenv, secrets, redaction

- [CI] Secret store from stdin and from a variable. Modes 0700 and 0600. Separation by environment and by project folder. Idempotent `unset`: `core.e2e.mjs:108-124`.
- [CI] Full precedence order for native Docker: `dotenv.e2e.mjs:36-117`. For Compose: `dotenv-compose.e2e.mjs:56-97`. Values are compared by SHA-256 so the test does not print them.
- [CI] Parser never runs shell syntax: `dotenv.e2e.mjs:99`, `dotenv-compose.e2e.mjs:96`.
- [CI] `exec` and failed `exec` redact stored values, credential-named values, and token formats: `dotenv.e2e.mjs:49-57,118-120`, `runtime-e2e.mjs:40-41`.
- [CI] Failed startup output is redacted: `e2e.mjs:134-140`.
- [NONE] `logs` redaction for native and Compose. Only E2B asserts it (`e2b.e2e.mjs:256-258`).
- [NONE] UI `/api/logs` redaction.
- [NONE] Redaction after a daemon restart.
- [NONE] Modes of `state.json`, `daemon.log`, `control.sock`, and the state folder. Only the secret store and Compose runtime folders are checked.
- [CODE] Native Docker passes values as `docker run -e KEY=value` (`docker.mjs:74`). They appear in the process list during startup and in `docker inspect`. No test or document addresses this.
- [CODE] Redaction is exact substring match (`environments.mjs:201-208`). Plain values with ordinary names stay readable (`environments.mjs:185-191`). README documents the second point (`README.md:238-239`).

### 4.8 Snapshots and restore

- [CI] Running source refused: `features-e2e.mjs:76-79`.
- [CI] Save, one omitted bind mount, duplicate target refused: `features-e2e.mjs:80-84`.
- [CI] Corrupted archive refused, no volume created: `features-e2e.mjs:85-99`. Local storage only (`if (!s3)`).
- [CI] Restore gives independent data. Existing name refused: `features-e2e.mjs:124-133`.
- [CI] Same flow through S3 on SeaweedFS (s3 job) and through SSH (ssh job).
- [NONE] Snapshot of a native Docker instance. Only Compose instances are snapshotted.
- [NONE] `--omit-mounts`. Anonymous, external, and shared volume rejection.
- [NONE] Crafted tar with a valid checksum (path traversal, link escape). The validator is `snapshots.mjs:136-243`. Its only tests were unit tests deleted in commit `2dd3e4d`.
- [NONE] Failure during restore. Concurrent snapshot to one S3 prefix. Snapshot of a sleeping cloud instance (`daemon.mjs:343`).
- [NONE] AWS-hosted S3. `VERIFICATION.md:48` says so.

### 4.9 Forks and worktrees

- [CI] Native data fork, source must be stopped, destination must be new: `e2e.mjs:101-111,129-133`.
- [CI] Compose fork with worktree. Dirty edits, binary file, nested path copied. Deleted file, `.env.local`, ignored file, `secret.key`, and outside symlink not copied. Source status unchanged: `features-e2e.mjs:100-106`.
- [CI] Dirty worktree removal refused: `features-e2e.mjs:107-109`.
- [CI] Fork resumes from both directories: `features-e2e.mjs:112-117`.
- [NONE] `--branch`, `--ref`.
- [NONE] Existing branch, existing path, path inside the repository (`worktrees.mjs:74-90`).
- [NONE] Tracked credential file in the ref (`worktrees.mjs:85`).
- [NONE] Rollback after a failed fork (`daemon.mjs:380-394`, `worktrees.mjs:116-126`).
- [NONE] Clean removal: no assertion that the folder and branch are gone, or that a branch with new commits is kept (`worktrees.mjs:131-153`). The suites only require exit code 0 in cleanup (`helpers.mjs:96`).
- [NONE] Native Docker fork with `--worktree`.

### 4.10 Source updates and SSH

- [CI, SSH job only] `sync` after edit. Same size and mtime edit is detected. `.env` is not copied: `e2e.mjs:69,82-89`.
- [CI, SSH job only] Automatic sync and tunnel recovery: `runtime-e2e.mjs:42-53`.
- [CI] Compose bind mounts and secret files through SSH: `compose.e2e.mjs:83-85`.
- [NONE] File deletion and rename through rsync.
- [NONE] Watcher error or rsync failure shown in `list` (`daemon.mjs:43`).
- [CODE] rsync excludes only `sourceExclusions` (`docker.mjs:52`, `source-paths.mjs:2`). E2B also drops `.ssh`, `.npmrc`, `credentials.json`, `*.pem`, and `--env-file` files (`e2b.mjs:17-18,539`). SSH and cloud transfer those files. README limits the extra filter to E2B (`README.md:193`). No test covers this difference.
- Local `sync` and auto-sync assertions pass trivially. A bind mount shows edits at once (`docker.mjs:49`, `e2e.mjs:82-88`, `runtime-e2e.mjs:42-43`).
- The SSH fixture is loopback sshd on the same host. Remote and local share one filesystem and one Docker engine (`scripts/ci-fixtures.sh:11-79`).

### 4.11 HTTPS, trust, UI

- [CI, docker and ssh jobs] `up --https`, certificate checked with the generated CA, HTTPS URL kept after daemon restart: `runtime-e2e.mjs:25-31,54-57`.
- [CI] Dashboard `/api/status`, foreign origin 403, POST 405, foreign host 403, CSP and nosniff headers, survives restart: `runtime-e2e.mjs:32-39,57`.
- [NONE] `agent-env https` as its own command. `agent-env trust` (`tls.mjs:48-57`).
- [NONE] Instance started after HTTPS was enabled (`runtime.mjs:51-55`). HTTP/2. WebSocket over TLS. Alias collision (`runtime.mjs:35`). Occupied HTTPS port (`runtime.mjs:47`).
- [NONE] Dashboard `/ui.js`, `/icon.svg`, `/api/logs`, and page behavior.
- [MANUAL] Browser check at two sizes and an accessibility scan: `VERIFICATION.md:84-92`. Dated 2026-11-08, before 0.5.0.
- [NONE] Real name resolution of `*.localhost` and the `::1` listener. Tests connect to `127.0.0.1` with a `Host` header (`e2e.mjs:39`, `proxy.e2e.mjs:15`).
- macOS never runs `ensureTls` (OpenSSL 3 versus LibreSSL, `tls.mjs:16-47`) or the dashboard.

### 4.12 Service templates and sandbox bridge

- [CI] `add postgres` and `add redis` for native Docker and Compose. Generated password, persistence across `down` and `rm`: `goodies-e2e.mjs:11-23`.
- [NONE] Collision errors (`goodies.mjs`), `--env` option.
- [CI] Docker bridge: `e2e.mjs` and `dotenv.e2e.mjs` run again with `--provider sandbox --adapter docker` (`run.mjs:55-57`).
- [NONE] Custom local ESM adapters (`sandbox.mjs:44-110`). README advertises them (`README.md:430`). Their unit tests were deleted.

### 4.13 Hetzner cloud

- [FILE, manual workflow] Provision, nested source sync, changed credential refused before any API call and the server stays, fork on a shared machine, recreate keeps worktree and data, TTL expiry of two sleeping instances, independent `hcloud` check that server, IP, and key are gone: `cloud.e2e.mjs:36-69`.
- [NONE] Machine really powers off after `down`. The test reads `sleeping` from `state.json` (`cloud.e2e.mjs:64-66`), not the server status.
- [NONE] Idle shutdown. The test passes `--idle-minutes 0`, which disables it (`cloud.e2e.mjs:35`, `maintenance.mjs:53`).
- [NONE] Interrupted allocation. Uncertain create, lost response (`cloud.mjs:150-163`). Their unit tests were deleted.
- [NONE] `--cloud-type`, other locations, Debian image.
- [MANUAL] Idle shutdown and resume were checked by hand on 2026-11-08 (`VERIFICATION.md:61-62`).
- The final leak check runs only if `up` succeeded, because `cloud` is set after `up` (`cloud.e2e.mjs:19-20,37`).

### 4.14 E2B

- [FILE, local only] Validation rejects, private ingress 403, HTTP, WebSocket, 32 s idle stream, exec and run exit codes, exclusions, auto and manual sync, deletion, 65 s command, pause and resume keep process memory, ownership tamper refused twice, failed start leaves no sandbox, lease expiry, purge: `e2b.e2e.mjs:132-360`.
- [FILE, weak] Seven rejected configurations assert only a nonzero exit and "no record" (`e2b.e2e.mjs:141-144`). The reason is not matched.
- [FILE] Direct run without the switch exits 0 with "SKIP" (`e2b.e2e.mjs:8-11`).
- [NONE] Interrupted allocation. The provider has recovery code (`e2b.mjs:360-372`). No test kills the daemon.

### 4.15 Agent Swarm example

- [MANUAL] `examples/agent-swarm/verify.mjs` and `docs/agent-swarm.md`. Needs an external checkout. Results dated 2026-11-08 and 2026-11-09 (`examples/agent-swarm/VERIFICATION.md`, `docs/providers-verification.md:65-75`).
- AGENTS.md asks for this check when startup, env files, routing, or persistence change. CI does not enforce it.

## 5. Actual limits of what CI proves

1. macOS runs the core group only. It proves help, init, secret store, skill install, the missing-Docker error, and daemon start and stop. Docker, TLS, and UI never run on macOS, though `package.json:27-30` lists darwin.
2. Node 22 runs the core group only. Integration jobs use Node lts (`ci.yml:113`).
3. "Daemon recovery" means graceful stop and restart. The PASS strings at `e2e.mjs:172` and `runtime-e2e.mjs:58` can read as crash recovery.
4. SSH is loopback on the CI host (see 4.10). S3 is SeaweedFS (`scripts/ci-fixtures.sh:81-105`). AWS is untested.
5. The harness removes only what `state.json` lists (`helpers.mjs:96`, `scripts/ci-cleanup.sh:12-16`). Resources of an `up` that never reached `state.json` stay. Native Docker suites assert no leak. Only Compose and Dev Container suites do (`compose.e2e.mjs:227-235`, `devcontainer.e2e.mjs:303-305`).
6. Hosted CI runners are disposable, so leaks stay invisible there. They matter on a developer machine.
7. Many negative tests check only a nonzero exit: `e2e.mjs:146`, `commands.e2e.mjs:58-60`, `devcontainer.e2e.mjs:258,261`, `e2b.e2e.mjs:141`. They pass for the wrong reason.
8. Tests read `state.json` directly in several suites. This ties them to a private file format.

## 6. Misleading or stale claims

I did not edit these files.

| Claim | Location | Problem |
| --- | --- | --- |
| "See verification evidence for completed local, remote, S3, cloud, and UI checks" | `README.md:451` | Points to `VERIFICATION.md`. That file is labelled historical (`VERIFICATION.md:1-6`) but lists unit-test evidence as verified. |
| "Regression tests cover ... idle shutdown, expiry, active peers, reconnect backoff" | `VERIFICATION.md:19` | Those tests were deleted in commit `2dd3e4d` (`maintenance.test.mjs`). No E2E test replaces them. |
| "Unit tests also cover AWS CLI arguments and interrupted transfers" | `VERIFICATION.md:48` | Deleted (`snapshots.test.mjs`). |
| "Regression tests cover failures before and after the API side effect" | `VERIFICATION.md:67` | Deleted (`cloud.test.mjs`). No current test reproduces a lost response. |
| "Protocol tests validated ... HTTP/2 ... Four concurrent processes generated certificates" | `VERIFICATION.md:79-82` | Deleted (`tls-ui-watch.test.mjs`). |
| "Anonymous Compose volumes now fail before export unless explicitly omitted" | `VERIFICATION.md:126` | The covering unit test is deleted. `--omit-mounts` is never run now. |
| "The registered sandbox Docker bridge passed the runtime E2E" | `VERIFICATION.md:26` | `run.mjs:55-57` runs only `e2e.mjs` and `dotenv.e2e.mjs` with the bridge. |
| Verification commands `node --test test/compose.test.mjs ...` | `IMPLEMENTATION_PLAN.md:23,35` | These files no longer exist. The file says it is historical. |
| CI table lists Core, Docker, Compose, SSH, S3 | `docs/releases.md:20-26` | Omits the Dev Containers job (`ci.yml:104`). |
| "`npm test` runs core, Docker, and Compose E2E" | `docs/releases.md:47` | `run.mjs:40` also runs `devcontainer`. The command list at `:52-57` omits it too. |
| "Installed CLI coverage includes ... concurrency, long E2B commands, and automatic lease expiry" | `docs/providers-review.md:37` | The E2B items run only by hand with a paid key. Concurrency covers `run` and `exec` only. |
| Runtime and command evidence "while the version remained 0.4.1" | `docs/providers-verification.md:6-7` | Honest, but it means the E2B and command evidence is for the candidate archive. At 0.5.0 only the core suite ran locally. CI at 0.5.0 covers commands, not E2B. |
| Archive rules and "tested archive behavior" | `docs/snapshots-and-worktrees.md:105-109` | No current test sends a rejected archive. |
| Suite "covers ... unsupported operations" | `docs/devcontainers.md:142` | It checks only a nonzero exit. |
| `PASS: ... daemon recovery` | `e2e.mjs:172` | Graceful restart only. |

## 7. Prioritized missing installed-CLI E2E tests

Rules for all items: real Docker, SSH, HTTP, or provider. No mock. Use isolated names and state. Remove only what the test created.

### P0

**G1. Interrupted `up` (native Docker and Compose).**
Two cases. First, send SIGINT to the CLI one second into `up`. Second, SIGKILL the daemon during `up`. Find the daemon PID with `lsof -t` on `control.sock`.
Assert: `list` is consistent. `rm --purge` ends with no container, network, volume, or image that carries the owner label. A later `up` of the same name works or fails with a message that names the fix.
Expected today [CODE, not run]: state is saved after `connect` (`daemon.mjs:237-244`). After a SIGKILL, `up` fails on the leftover network (`docker.mjs:62`) or containers (`compose.mjs:340-341`), and `rm NAME` says the instance does not exist (`daemon.mjs:117-120`). Decide the intended behavior first (adopt or purge by label). Cost: no paid resource, about 1 minute.

**G2. Leak and ownership checks in the harness.**
In `fixture().cleanup()`, after `rm --all --purge`, list containers, volumes, networks, and images with the owner label from `state.json`. Assert none remain. Add one test with two state homes and the same instance name on one Docker engine. Purge one. Assert the other still serves.
Why: AGENTS.md says to remove only what the test created. Native suites prove neither half. Cost: low.

**G3. Crash recovery of running instances.**
SIGKILL the daemon with two running instances. Run `list`. Assert the stale socket is replaced, both routes return, and the focus is kept. Then stop one container with `docker stop` outside agent-env. Restart the daemon. Assert `list` shows an error for that instance (no crash) and `up NAME` recovers it with data intact.
Cost: about 1 minute, Docker only.

**G4. Concurrency.**
(a) Start 8 `list` commands at once on an empty home. Assert one daemon and 8 identical results. This needs no Docker, so it also runs in the macOS core job.
(b) Two parallel `up` for the same name, then for two names. Assert one instance and no duplicate resources.
(c) `list` and `logs` while a slow `up` runs. Assert the documented behavior (today they wait, see 4.3). Decide whether that is acceptable for a 900 s Agent Swarm start.
(d) `down` while a gated `exec` runs.

**G5. Cloud additions (paid, manual workflow only).**
Extend the existing machine, do not add a second one. Assert `hcloud server describe` shows `off` after `down`. Run idle shutdown with a small fractional `--idle-minutes` (0.1 gives 6000 ms, a valid integer) and resume. SIGKILL the daemon during provisioning, rerun `up`, and assert exactly one server, IP, and key per record label. Move the final leak check so it also runs when `up` fails. Cost: about 3 extra minutes on one machine.

### P1

**G6. Fork and worktree negatives.** No paid resource.
Existing branch, existing path, path inside the repo, tracked credential in the ref, `--branch new --ref <commit>`, forced failure with rollback. Then clean `rm --remove-worktree`: assert the folder and branch are gone and that a branch with a new commit stays.

**G7. Snapshot negatives.**
Native Docker snapshot and restore. Anonymous and shared volume rejected, `--omit-mounts` accepted and reported. Crafted tar with matching checksum (path traversal, escaping symlink) rejected and no volume created. Build the archive and edit the manifest checksum in the test.

**G8. Config change and Compose isolation rules.**
Change image or port on a running instance. Assert the "Configuration changed" error and that the old instance still serves. Then reject a Docker socket mount, `network_mode: host`, replicas, and UDP. Assert no Docker resource is created. These fail before any pull.

**G9. Secret surfaces.**
A service that prints a secret at boot. Assert `logs` and the UI `/api/logs` mask it, also after a daemon restart. Assert modes of `state.json`, `daemon.log`, `control.sock`, and the state folder. Decide and document the `docker run -e` exposure (`docker.mjs:74`).

**G10. No-Docker tests for the macOS core job.**
`agent-env https` then an HTTPS request to the router with the generated CA (expect 404 with a valid chain). `agent-env ui --port 0` with `/api/status` returning no instances, and the static routes. One human-output check of `list`. This is the only way to cover macOS TLS and UI without a Docker runner.

**G11. SSH group coverage.**
Run `dotenv`, `dotenv-compose`, `proxy`, and `goodies` in the SSH group. Add deletion and rename through rsync. Decide whether rsync should drop credential files as E2B does (`docker.mjs:52` versus `e2b.mjs:17,539`), then assert that decision.

**G12. E2B (paid, opt-in).**
SIGKILL the daemon during `up`, rerun, and assert one sandbox through the SDK and none after purge. Match the error text in the seven rejected configurations.

### P2 (only on demand)

Custom ESM adapter, if adapters stay a public feature. Dev Container forbidden settings. Running a generated Node `init` config. Node 22 in one integration job.

## 8. Objections to over-testing

- **`trust`.** It changes the OS trust store. macOS asks for approval, Linux needs sudo. Do not automate it. Check once per release by hand. Test `https` with `--cacert` instead.
- **AWS-hosted S3.** It needs private credentials and costs money. AGENTS.md keeps ordinary CI independent of both. SeaweedFS already proves the conditional write.
- **More Hetzner variants.** One location and one type are enough. Add idle and power checks to the same machine.
- **Exhaustive unsupported-key tests** for Compose and Dev Containers. Test the four isolation boundaries in G8 only.
- **Browser rendering in CI.** It adds a Chromium download for a read-only dashboard. Keep the HTTP checks and one manual check per release.
- **Everything again under SSH and the sandbox bridge.** Each rerun adds minutes. Add only the suites in G11.
- **Docker daemon restart and host reboot.** Hard to isolate. G3 covers the part agent-env controls.

## 9. Released code versus unverified changes

Everything above describes commit `1e5f1d4`. Its CI run passed.

At audit time the working tree held uncommitted storage profile changes from another agent.
Modified: `README.md`, `bin/agent-env.mjs`, `docs/snapshots-and-worktrees.md`, `scripts/ci-fixtures.sh`, `skills/agent-env/*`, `src/config.mjs`, `src/daemon.mjs`, `src/snapshots.mjs`, `test/run.mjs`.
Untracked: `docs/storage.md`, `src/storage.mjs`, `test/storage.e2e.mjs`, `test/storage-s3.e2e.mjs`.
`test/run.mjs` adds these suites to the `core` and `s3` groups.

I did not review or run these changes. Line references here come from the `HEAD` version of each file.
Re-audit snapshot, S3, and `--endpoint` coverage after that work merges. Some G7 items may overlap with it.

## 10. Method and limits of this audit

- Read: `bin/agent-env.mjs`, all `src/` files and providers, all 17 files in `test/`, `scripts/ci-*.sh`, both workflows, README, `VERIFICATION.md`, `docs/`, `examples/agent-swarm/`.
- Read the deleted unit test titles from `git show 2dd3e4d^:test/*.test.mjs` to see which behavior lost coverage.
- Read GitHub Actions logs for run `42540141451` with `gh` (read only). I did not query the Desplega Swarm tasks.
- I searched `test/` with `grep` to confirm that a flag has no assertion. A flag used through a variable name could escape that search. I read every test file, so I judge this unlikely.
- This is not exhaustive. I did not measure code coverage. Items marked [CODE] need a run to confirm.
