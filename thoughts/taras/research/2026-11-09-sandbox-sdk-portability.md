---
date: 2026-11-09T00:30:00Z
topic: "Sandbox SDK portability assessment for agent-env"
researcher: Claude (research sub-agent)
status: complete
tags: [research, sandbox-sdk, e2b, daytona, vercel, docker, compose]
---

# Sandbox SDK portability assessment for agent-env

Date: 2026-11-09 (about 01:30 BCN)
Subject: https://sandbox-sdk.app/ and `@opencoredev/sandbox-sdk` 1.0.3
Scope: E2B, Daytona, Vercel. Research only. No code, dependency, git, or GitHub changes.

Evidence labels:
- **Verified**: read in source, package files, or official docs.
- **Inference**: my reading of verified facts.
- **Untested**: not run. No paid service was used. The package was downloaded to `/tmp` and never executed or installed in the repo.

## Verdict

Do not replace `src/providers/e2b.mjs` with the SDK. The SDK does not preserve several E2B guarantees that agent-env documents today.

The SDK is useful as an optional, separate adapter for Daytona and Vercel, behind the existing `sandbox.adapter` module path. Even there, it gives no Docker or Compose execution on any of the three providers.

## 1. Package facts (verified)

| Fact | Value | Source |
| --- | --- | --- |
| Latest version | 1.0.3, published 2026-10-30 | `npm view @opencoredev/sandbox-sdk`, `time` |
| First publish | 2026-07-16. 1.0.0 on 2026-10-30. | same |
| License | MIT | `package.json`, GitHub API |
| Node | `>=22`, also `bun >=1.3`. ESM only. | `package.json` `engines` |
| agent-env Node | `>=22.19.0`, so compatible | `/Users/taras/.t3/projects/dev-now/package.json` |
| Runtime dependencies | None | `package.json` has no `dependencies`. README line 13. |
| Peers (all optional) | `@vercel/sandbox ^3.8.0`, `@upstash/box`, `railway`, `@tenkicloud/sandbox`, `@boxd-sh/sdk`, `@rivet-dev/agentos-core`, `ai`, `zod`, others | `package.json` `peerDependencies` |
| E2B and Daytona transport | Direct HTTP. No `e2b` or Daytona package. | CHANGELOG 1.0.0 |
| Vercel transport | Official `@vercel/sandbox` (peer) | https://sandbox-sdk.app/docs/providers/vercel |
| Provenance | npm SLSA attestation present | `npm view` `dist.attestations` |
| Maintainers | One npm maintainer. GitHub: 108 stars, 8 open issues. | `npm view`, GitHub API |
| Repo HEAD | `d4b8d3f` (2026-11-05). Version on main is 1.0.3. | GitHub API |

Inference: the 1.0 line is about ten days old and was rewritten from scratch ("1.0 is a rewrite"). E2B support moved from the official `e2b` package to a new in-house HTTP client for the E2B control API and the in-sandbox `envd` daemon in that same release.

Quote, CHANGELOG 1.0.0: "`e2b()` calls E2B's API and each sandbox's envd daemon over HTTP, so `e2b` is no longer a peer dependency".

Today agent-env pins `e2b` 2.63.0, the vendor SDK. Switching trades the vendor SDK for a ten-day-old reimplementation of its wire protocol.

## 2. What "13 providers" means (verified, with limits)

The home page says "Commands, files, and git on 13 providers". The README lists 14 entries including `memory`.

Production evidence is thin:
- `.github/workflows/live-compatibility.yml` runs a weekly matrix for five providers only: `e2b, daytona, vercel, upstash, tenki`.
- The last two scheduled runs (2026-10-27 and 2026-11-03) show all five jobs as `failure`. I read the first job's steps for each run. It failed at "Set up job". I did not read logs. Cause unknown.
- Inference: there is no recent green live CI evidence for any provider. The failure looks like infrastructure, not provider behavior, but that is untested.
- Live test files exist for the other providers. They skip without credentials. I found no CI evidence that they run.

Do not treat any provider as production verified from SDK claims alone.

## 3. Capability matrix for the three target providers

Source: https://sandbox-sdk.app/docs/reference/capabilities, plus adapter source under `packages/sdk/src/providers/` at `d4b8d3f`.

| Item | E2B | Daytona | Vercel |
| --- | --- | --- | --- |
| Pause and resume | Yes. Memory and files. | No. Idle stop only. | Partial. Files survive. Processes end (exit 137). |
| Snapshot | Yes. No expiry. | Yes. Filesystem only. | Yes. With expiry. |
| Hard lifetime (`timeoutMs`) | Yes. Stored in metadata and re-clamped on connect. | Yes. Whole minutes. | Per session. Each resume starts a new one. |
| Key mode | best-effort (metadata search) | best-effort (label search) | exact (unique name) |
| Labels | Yes | Yes | At most 4 (3 with a key) |
| Network allow list | Yes | Yes | Yes |
| Preview ingress | Public by default. `public: false` gives token header. | Private by default. `X-Daytona-Preview-Token` header. | Public `https://` URL. No token option. |
| Declared ports | Not needed | Not needed | Required at create, max 15 |
| Terminal (PTY) | Yes | No | No |

Verified: `dist/provider.d.ts` defines `Capability = "pause" | "snapshot" | "terminal" | "network-policy" | "size"`. There is no Docker or Compose capability.

### Reconnect, pause, resume
- Verified (E2B): `connectSandbox(provider, id)` and `box.resume()` call `POST /v2/sandboxes/{id}/connect`. `pause` calls `POST /sandboxes/{id}/pause` with an empty body and treats HTTP 409 as success. Source: `e2b/index.ts` lines 420 to 431, 1403 to 1433.
- Verified (E2B): `autoPause` maps to the create body field `autoPause`, and `autoResume` is allowed only with it.
- Verified (Vercel): "`resume()` starts a new one from the saved file system, so files survive but running processes don't."
- Verified (Daytona): "No pause, resume, or terminals."

### Private HTTP and WebSocket ingress
- Verified (E2B): with `public: false` the adapter sends `network.allowPublicTraffic=false`, reads the policy back, and destroys the sandbox on mismatch. `preview()` returns `https://${port}-${id}.${host}` and `{"e2b-traffic-access-token": token}`. Source: `e2b/index.ts` lines 1002 to 1090, 1387 to 1402.
- Verified: the SDK returns a URL and headers. I found no WebSocket proxy or local bridge in the SDK. Inference: agent-env must keep its own loopback bridge (`bridge()` in `e2b.mjs` lines 205 to 281) for browsers and for WebSocket upgrades.
- Verified (Daytona): "A browser can't add headers to an iframe or link." The doc tells users to proxy through their own server. WebSocket through the Daytona preview proxy is **untested** and not documented in the pages I read.
- Verified (Vercel): the adapter returns `{ url: box.domain(port) }` with no headers (`vercel/provider.ts` line 749). The docs table says "Public". Inference: the SDK gives no private ingress on Vercel. Any private route would need Vercel-native features outside this adapter.

### Background processes and command timeouts
- Verified: `box.start(cmd, { name, ready })` gives durable named processes with `logs()`, `stop()`, `restart()`. The SDK keeps process records inside the sandbox (`core/process-records.ts`). Readiness can be port, HTTP, or log match.
- Verified: "Commands time out after 120 seconds unless you pass `timeoutMs`". A timeout resolves with `timedOut: true`. It does not throw.
- Verified (E2B): the adapter launches with `setsid` and `timeoutMs: 0` (`e2b/index.ts` lines 877 to 895).
- Verified (Vercel): timeouts use GNU `timeout` on a new process group.
- Inference: this overlaps with the Python `manager.py` in `e2b.mjs`. The semantics differ (record format, restart-on-config-change fingerprint, log files, flock launch guard, E2B_ env filtering). Replacing it changes behavior that `docs/e2b.md` documents.

### File sync
- Verified: `files.write`, `files.upload(local, remote, { ignore })`, `files.edit`, `files.changes`.
- Not verified: how `upload` handles symlinks, mode bits, secret scanning, or deleting files removed locally.
- Inference: agent-env's rules stay ours. These are the credential path filter, `shouldSync`, `O_NOFOLLOW`, exclusion of `envFiles`, content scan for known secret values, the manifest that removes deleted files, and the symlink check on `cwd` (`e2b.mjs` lines 17 to 19, 532 to 564).

### Credential isolation
- Verified: `secrets` in `createSandbox` are "redacted from all output and errors". `git push` uses a temporary credential helper.
- Verified: `e2b({ apiKey })` accepts an explicit key, so agent-env can keep avoiding `process.env`.
- Verified: E2B commands run as `root` in `/workspace`. agent-env uses the default sandbox user and `/home/user/.agent-env/<recordId>/workspace`.
- Inference: the SDK does not strip `E2B_` variables from service environments. That remains ours.

### Ownership metadata
- Verified: labels become E2B metadata. The SDK reserves `sandbox-sdk`, `sandbox-sdk-key`, and `sandbox-sdk-deadline`, and adds `sandbox-sdk: "1"` to every sandbox.
- Verified: keys are "found by metadata search" and best-effort on E2B and Daytona.
- Inference: agent-env's `agent-env.owner`, `agent-env.name`, `agent-env.record` labels fit as ordinary labels. Whether E2B accepts dotted metadata keys through the SDK's `labels` validation is **untested**. agent-env uses them today through the official SDK.

### Idempotent allocation and cleanup
- Verified: agent-env sends `idempotencyKey: handle.e2b.recordId` on `Sandbox.create` (`e2b.mjs` line 377).
- Verified: the SDK E2B create body (`e2b/index.ts` lines 1012 to 1037) has no idempotency key. The only `idempotencyKey` string in that file is an internal `"replayable"` retry flag for connect, timeout, and pause.
- Verified: "a create whose response is lost is `outcome_unknown`".
- Verified: open upstream issue #35, "createSandbox loses the allocated sandboxId when handle initialization fails". The reporter says the caller can get neither a handle nor the ID when cleanup also fails. Source: https://github.com/opencoredev/sandbox-sdk/issues/35 (title and first lines read).
- Verified: `destroy` returns false when the sandbox is already gone. `listSandboxes` and `reapSandboxes` exist. `reapSandboxes` deletes by age.
- Inference: agent-env's retry-after-empty-recovery logic (`recover(handle, true)`) is safe today because the retry reuses the same idempotency key. Without it, a retry can create a second sandbox if the first create lands late. The SDK's own live tests poll for listing consistency, which suggests listing is eventually consistent.

## 4. Docker and Compose execution

Short answer: the SDK provides neither on any provider. All of it would be our work.

- Verified: no `compose`, `dockerd`, or "docker run" in `providers/e2b`, `providers/daytona`, `providers/vercel`, or in `dist/`. The capability list has no container capability. The SDK's `local` provider drives a Docker Engine on your machine. That is a different thing.
- The existing `SANDBOX_CAPABILITIES` in `src/providers/sandbox.mjs` line 6 includes `compose`. An SDK adapter would declare `compose: false`. `requireSandboxCapabilities` would then reject any spec with `compose`.

Provider-native facts (official docs, not the SDK):

| Provider | Docker inside sandbox | Source |
| --- | --- | --- |
| Vercel | Supported. Install Docker and start the daemon yourself. Changelog (2026-05-29): "now supports installing and running Docker inside a sandbox". Update 2026-08: on the default Ubuntu image use `apt-get`, not `dnf`. | https://vercel.com/changelog/run-docker-containers-inside-vercel-sandbox |
| Daytona | Documented Docker-in-Docker and a Compose example using a `docker-dind` snapshot. "Sandboxes can run Docker containers inside them (Docker-in-Docker)". Suggested minimum: 2 vCPU and 4 GiB. | https://www.daytona.io/docs/en/snapshots/ (section "Run Docker in a sandbox") |
| E2B | **Not verified.** I found no official page that documents a Docker daemon or Compose inside an E2B sandbox. Docs say template builds can "run Docker containers as part of the setup", which is build time only. | search results only. Needs a real test. |

Caveats:
- Daytona's documented path uses the pre-built `docker-dind` snapshot. The SDK `daytona()` has a `snapshot` option, so selecting it is possible. Compose via `box.run("docker compose ...")` would work as a plain command. Untested.
- Vercel needs `sudo` and a daemon started through a detached command. Whether `sudo` is reachable through `box.run` is untested. `box.native` exposes the official `Sandbox` object as an escape hatch.
- Ports published by Compose inside the sandbox must be mapped to the sandbox's own listening ports. On Vercel they must also be declared at create time.

## 5. What shared adapters give, and what stays ours

The SDK gives (verified in README and source):
- One `createSandbox`, `run`, `files`, `start`, `preview`, `pause`, `snapshot`, `destroy` surface.
- Typed errors with `retryable` and `outcome_unknown`.
- Provider quirk handling (Vercel tag limits, Daytona minute rounding, E2B deadline clamping, post-create network policy readback on E2B).
- A conformance suite (`runConformance`) that the adapter authors run live.
- Secret redaction in output and errors.

Still our responsibility:
1. Owner, instance name, and record binding in a private `0600` record, plus credential hash binding.
2. Write-ahead allocation record and recovery by ownership labels. Plus our own idempotency story, because the SDK has no create idempotency key.
3. Source sync policy: filtering, secret scan, symlink safety, deletion manifest.
4. Loopback bridge for HTTP and WebSocket with the traffic header, origin rewrite, and token redaction.
5. Service manager semantics: config fingerprints, restart on change, log reset on config change, `E2B_` filtering, exit-code reporting.
6. Compose or Docker-in-sandbox. No provider here gives it through the SDK.
7. Status mapping to `running, created, exited, paused, missing`.
8. Purge verification: kill, confirm absence, then remove the record.
9. Daemon IPC rule: credentials resolved in the CLI process before IPC. The SDK reads `E2B_API_KEY` from `process.env` when no key is passed, so we must always pass explicit options.

## 6. Does adoption preserve existing E2B guarantees?

Source of guarantees: `docs/e2b.md`, `src/providers/e2b.mjs`.

| Guarantee in agent-env | With SDK | Basis |
| --- | --- | --- |
| Private ingress, refuse when unconfirmed | Preserved if `public: false` is set. The SDK reads the policy back and refuses. | verified |
| `maskRequestHost: 'localhost:${PORT}'` on the sandbox network | **Not supported.** The SDK create body has no such field. `grep maskRequestHost` over the SDK source returns nothing. | verified |
| Same ownership ID as create idempotency key | **Lost.** No idempotency key on create. | verified |
| Full pause with `mode: 'full', strict: true` | Not exposed. SDK sends `{}` and treats 409 as success. We would re-read state ourselves. | verified |
| Resume with `onResume: 'restore'` | Different call path (`/v2/sandboxes/{id}/connect`). Equivalence untested. | verified call, untested effect |
| Default user and `/home/user/.agent-env/<id>/workspace` | **Changed.** SDK uses `root` and `/workspace`. Existing retained sandboxes would fail the workspace check at `e2b.mjs` line 320. | verified |
| Official vendor SDK 2.63.0 for control plane | **Replaced** by a new reimplementation. | verified |
| No SDK defaults or `process.env` mutation | Possible if every call passes `apiKey`. | verified option |
| Command time limits (60 s control, unlimited `exec`) | Default 120 s. Must pass `timeoutMs` per call. Unlimited value untested. | verified default |
| Logs and process state outside the synced checkout | SDK stores records under `/tmp/.sandbox-sdk` in the guest. Different layout. | verified |
| Redaction of the traffic token and API key | Partly. We keep our own redaction. | inference |

Result: not preserved. Four items are lost or changed (`maskRequestHost`, idempotent create, full-pause semantics, user and workspace). Each needs either a native escape hatch or a retained guarantee that we do not have today.

## 7. Blockers

1. No create idempotency key on E2B. This weakens the documented "uncertain creation" recovery.
2. No `maskRequestHost` option. Services that read the Host header may behave differently.
3. Root user and `/workspace` change the security posture and break retained sandboxes.
4. Vercel has no private preview ingress through the adapter.
5. Daytona has no pause. agent-env's `stop` and `start` semantics (memory kept) would differ. Idle stop only.
6. Docker and Compose are absent from the SDK. E2B Docker support is unconfirmed.
7. Maturity: ten-day-old 1.0, one maintainer, all five weekly live CI jobs failing at job setup in the last two runs, and open issue #35 on lost allocation IDs.
8. Vercel needs the `@vercel/sandbox` peer. That adds a dependency to a package that today has three.

## 8. Minimal adoption boundary

Do this, and only this:

1. Keep `e2b.mjs` as is.
2. Add an optional third-party adapter module that agent-env loads through the existing `sandbox.adapter` path (`sandbox.mjs` `adapterLocation`, `createAdapter(options)`). Do not add the SDK to `dependencies`. Ship it as an opt-in install, or as an example adapter.
3. Scope the adapter to **Daytona first**, then Vercel. Both lack an agent-env provider today.
4. The adapter declares only capabilities it can deliver:
   - `create, wait, connect, status` (required), plus `start, stop, remove, sync, logs, exec`.
   - `compose: false`.
   - `fork: false`.
5. The adapter must still enforce, in our code:
   - private record and ownership labels,
   - explicit credentials,
   - source-sync policy,
   - loopback bridge,
   - purge verification.
6. Reject at validation time what the SDK cannot do: Vercel private ingress, Daytona pause semantics, TCP services (SDK previews are HTTP only. `serializableHandle` allows `tcp`, so the adapter must refuse it).
7. For Docker or Compose inside Daytona or Vercel, build a separate explicit feature: a provider-native snapshot or image with Docker, then plain `docker compose` through `exec`. Do not imply the SDK provides it.

Inference: this boundary keeps E2B guarantees intact because E2B stays on the vendor SDK.

## 9. Real installed-CLI E2E requirements

Rules from `AGENTS.md`: all tests are end to end through the installed CLI, no unit tests, no mocks, no private credentials in ordinary CI, isolated names, remove only what the test created.

Required for any adapter work:
- `AGENT_ENV_CLI` set to an absolute installed executable (existing rule in `test/run.mjs`).
- A new opt-in group, for example `AGENT_ENV_TEST_DAYTONA=1 node test/run.mjs daytona`, which refuses to run without its credential, like `test/e2b.e2e.mjs` lines 8 to 14.
- Out-of-band checks use the provider's own client against the real service. Note that `test/e2b.e2e.mjs` line 14 loads `e2b` from the CLI install through `createRequire(realpath(AGENT_ENV_CLI))`. Any change that drops `e2b` from the CLI would break that test.
- Random instance names and labels per run. Cleanup by recorded sandbox ID only. Never use `reapSandboxes` by age on a shared account.
- Cases to cover for each provider:
  1. `up`, HTTP request through the `localhost` address, WebSocket echo, then `down`.
  2. Ingress privacy: a request to the raw preview URL without the token header is rejected. (E2B yes. Daytona yes. Vercel expected to fail. That is the point of the test.)
  3. `stop` then `start`: files kept, processes kept or restarted according to the provider. Assert the documented difference.
  4. Lease expiry and resume where the provider supports it.
  5. Kill the CLI between the allocation record write and the create response. `up` again must not leave two sandboxes.
  6. Service environment change, then `up`: only the affected service restarts.
  7. Source sync: credential files, `.env`, symlinks, and a file containing a known secret value never reach the sandbox. Deleted local files are removed remotely.
  8. `rm --purge`: sandbox absent at the provider, private record removed, credential absent from `status`, logs, and state files except the documented `state.json` rule.
  9. Docker or Compose cases, only after the separate feature exists: image pull, `compose up`, service reachable through a published port, `compose down`.
- Real Docker for the local half, with `AGENT_ENV_TEST_SANDBOX=1` for the Docker sandbox bridge.
- Verify in the Agent Swarm example when a change affects startup, env files, routing, or persistence (`AGENTS.md` rule).
- Ordinary CI stays credential-free. These groups run only with explicit authorization, because they create billed resources.

## 10. Open questions (untested)

- Does E2B accept `agent-env.*` dotted metadata keys through the SDK's `labels`?
- Does Daytona's preview proxy pass WebSocket upgrades with the token header?
- Can `box.run` reach `sudo` and a Docker daemon on Vercel's Ubuntu image?
- Does the E2B template route support a Docker daemon at runtime? No official source found.
- Why do all five weekly live jobs fail at "Set up job"? I did not read logs.
- Does `files.upload` preserve mode bits and handle symlinks safely?

## Sources

Local files (read):
- `/Users/taras/.t3/projects/dev-now/AGENTS.md`
- `/Users/taras/.t3/projects/dev-now/package.json`
- `/Users/taras/.t3/projects/dev-now/src/providers/e2b.mjs` lines 17 to 19, 22 to 70, 72 to 75, 205 to 281, 283 to 581
- `/Users/taras/.t3/projects/dev-now/src/providers/sandbox.mjs` lines 5 to 32, 44 to 80, 82 to 170
- `/Users/taras/.t3/projects/dev-now/src/providers/index.mjs` lines 1 to 15
- `/Users/taras/.t3/projects/dev-now/docs/e2b.md` lines 86 to 135
- `/Users/taras/.t3/projects/dev-now/test/run.mjs` lines 1 to 40
- `/Users/taras/.t3/projects/dev-now/test/e2b.e2e.mjs` lines 8 to 14

Package and site:
- https://www.npmjs.com/package/@opencoredev/sandbox-sdk (via `npm view` and `npm pack` of 1.0.3, extracted to `/tmp/ssdk-research`)
- https://sandbox-sdk.app/
- https://sandbox-sdk.app/docs/reference/capabilities
- https://sandbox-sdk.app/docs/providers/e2b
- https://sandbox-sdk.app/docs/providers/daytona
- https://sandbox-sdk.app/docs/providers/vercel

SDK source (GitHub `opencoredev/sandbox-sdk`, commit `d4b8d3f`, package version 1.0.3):
- https://github.com/opencoredev/sandbox-sdk/blob/main/packages/sdk/src/providers/e2b/index.ts
- https://github.com/opencoredev/sandbox-sdk/blob/main/packages/sdk/src/providers/daytona/index.ts
- https://github.com/opencoredev/sandbox-sdk/blob/main/packages/sdk/src/providers/vercel/provider.ts
- https://github.com/opencoredev/sandbox-sdk/blob/main/packages/sdk/src/core/process-records.ts
- https://github.com/opencoredev/sandbox-sdk/blob/main/.github/workflows/live-compatibility.yml
- https://github.com/opencoredev/sandbox-sdk/issues/35

Official provider docs:
- https://vercel.com/changelog/run-docker-containers-inside-vercel-sandbox
- https://www.daytona.io/docs/en/snapshots/
- https://www.daytona.io/docs/en/sandboxes/
- https://e2b.dev/docs/sandbox/internet-access

## Supporting quotes

- README: "That is the whole install for E2B, Daytona, Freestyle, Superserve, Boat, and Sandboxer, which call the provider's HTTP API directly."
- README: "Optional methods. `pause`/`resume` and `snapshot` exist only on providers that support them."
- CHANGELOG 1.0.0: "a create whose response is lost is `outcome_unknown`".
- E2B page: "Previews are public by default. With `public: false`, E2B rejects requests that lack the sandbox's traffic token".
- Daytona page: "A browser can't add headers to an iframe or link."
- Vercel page: "Pause and resume end running processes."
- Daytona docs: "Sandboxes can run Docker containers inside them (Docker-in-Docker)".
