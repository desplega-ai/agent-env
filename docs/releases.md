# CI and releases

The repository is `desplega-ai/agent-env`. Its default branch is `master`.
The npm package is `@desplega.ai/agent-env`.

## Ordinary CI

`.github/workflows/ci.yml` runs for every pull request and every push to `master`.
Public forks need no secrets. Ordinary CI never creates paid cloud resources.
CI uses public CLI and SDK E2E tests. It does not run unit tests.

The package job creates one tarball with `npm pack --ignore-scripts`.
`scripts/pack.mjs` audits its file list, package identity, version, and executable entry.
The audit rejects files outside the published directories, credential filenames, and unexpected artifacts.
Every test job downloads that same tarball and installs it into a temporary prefix.
No job installs the package globally.

The `CI` job requires all these jobs to succeed:

| Job | Runtime | Real dependencies |
| --- | --- | --- |
| Core | Linux and macOS, Node 22 and latest LTS | Git, npm, public skills installer, public CLI |
| Docker | Linux, latest Node LTS | Docker, HTTP, TCP, TLS, startup recovery, anonymous-volume cleanup, sandbox bridge, public SDK and TypeScript consumer |
| Compose | Linux, latest Node LTS | Docker Compose |
| Dev Containers | Linux, latest Node LTS | Docker, bundled Dev Containers CLI |
| SSH | Linux, latest Node LTS | Dedicated localhost sshd, Docker, Compose, rsync, build recovery and workspace cleanup |
| S3 | Linux, latest Node LTS | Docker Compose, AWS CLI, disposable SeaweedFS |

Core tests install the bundled skill with the real skills installer into a temporary project.
They verify Codex and Claude Code files and remove the isolated npm cache afterward.

The SSH fixture generates new client and host keys for every job.
The client pins the generated host key and requires strict host verification.
The fixture starts its own sshd with password authentication disabled.
PAM handles account checks, which permits key authentication for the runner's password-locked account.
Its command wrapper isolates the remote workspace.
The SSH process keeps the real CI user's home.
It does not change the system SSH configuration or authorized keys.

SeaweedFS uses version `4.52` and a pinned image digest.
Its S3 port binds only to localhost.
Each job generates credentials and creates a disposable bucket.
The tests remove their snapshot prefixes. Cleanup removes the container and its storage.

## Runner contract

The test owner maintains `test/run.mjs` and its suites.
`npm test` runs core, Docker, Compose, and Dev Container E2E.
`npm run test:core` runs the subset that requires no Docker.
Without `AGENT_ENV_CLI`, the runner audits and installs the checkout into a temporary prefix before testing.
Run `npm ci --ignore-scripts` first to install development dependencies.
CI calls the following commands through `scripts/ci-e2e.sh`:

```sh
AGENT_ENV_CLI=/absolute/prefix/node_modules/.bin/agent-env node test/run.mjs core
AGENT_ENV_CLI=/absolute/prefix/node_modules/.bin/agent-env AGENT_ENV_SDK_TARBALL=/absolute/package.tgz node test/run.mjs docker
AGENT_ENV_CLI=/absolute/prefix/node_modules/.bin/agent-env node test/run.mjs compose
AGENT_ENV_CLI=/absolute/prefix/node_modules/.bin/agent-env node test/run.mjs devcontainer
AGENT_ENV_CLI=/absolute/prefix/node_modules/.bin/agent-env node test/run.mjs ssh
AGENT_ENV_CLI=/absolute/prefix/node_modules/.bin/agent-env node test/run.mjs s3
AGENT_ENV_CLI=/absolute/prefix/node_modules/.bin/agent-env node test/run.mjs cloud
```

All CLI invocations must use `AGENT_ENV_CLI` when CI supplies it.
Tests must not import implementation modules or substitute Docker or SSH mocks.
The SDK suite imports the installed public package export and invokes its bundled CLI.
It compiles a consumer with the pinned TypeScript development dependency.
The Docker job runs `npm ci --ignore-scripts` to install that compiler.
`AGENT_ENV_SDK_TARBALL` selects the same audited archive for the SDK installation.
It is required when the Docker group uses an externally installed CLI.
Tests must create their directories beneath `TMPDIR` and remove their own resources.
The cloud suite must preserve state if resource cleanup fails.

The wrapper supplies these variables:

| Suite | Variables |
| --- | --- |
| All | `AGENT_ENV_CLI`, `AGENT_ENV_HOME`, `TMPDIR`, isolated npm and XDG directories |
| Docker | `AGENT_ENV_TEST_SANDBOX=1`, `AGENT_ENV_SDK_TARBALL` |
| SSH | `AGENT_ENV_TEST_SSH=agent-env-ci`, `AGENT_ENV_TEST_SSH_CONFIG`, `AGENT_ENV_TEST_RECOVERY_SSH`, `AGENT_ENV_TEST_RECOVERY_SSH_CONFIG` |
| S3 | `AGENT_ENV_TEST_S3=s3://agent-env-ci/snapshots`, `AGENT_ENV_TEST_S3_ENDPOINT`, temporary AWS credentials |
| Cloud | `AGENT_ENV_TEST_CLOUD=1`, `HCLOUD_TOKEN` from the protected environment |

The wrapper removes unrelated SSH and S3 settings from the inherited environment.
Each suite must remove instances, stop daemons, and remove its temporary files.
The wrapper also attempts cleanup after failure or termination.
An `always()` workflow step provides another cleanup attempt.
Cleanup retains recovery files when resource removal fails.
Cleanup requires the test directory's ownership marker and checks recorded fixture ownership.
It refuses resources with a different owner and reports failure.

## Automatic release

Merge an increasing version change in `package.json` to `master`.
The workflow compares the version against `github.event.before`, covering the entire push.
It does not compare only the final commit's parent.
Pull request CI also checks version increases against `pull_request.base.sha`.
A downgrade fails before merge.

The release job requires successful CI from the same workflow and exact commit.
It publishes the same archive that every E2E job tested.
It checks these conditions before publishing:

1. The package version contains valid SemVer and increases from the version before the push.
2. The archive name and version match `package.json` exactly.
3. A new version exceeds every version already published to npm.
4. Any existing version contains the exact same archive integrity.
5. Any existing Git tag points to the tested commit.
6. Any existing GitHub asset contains the exact same bytes.

npm releases cannot include SemVer build metadata because npm does not preserve it.

After npm confirms the exact version and integrity, the job creates `v<VERSION>` and the GitHub release.
The version check bypasses registry caches and retries propagation for up to twelve attempts, ten seconds apart.
If publication fails after npm accepted the archive, the retry verifies its integrity before continuing.
The GitHub release attaches only the tested `.tgz` file.
Prereleases use npm's `next` tag and GitHub's prerelease flag.
Stable releases use npm's `latest` tag.
Retries preserve existing tags and assets. They never overwrite conflicting releases.
An already published version must match the archive before the workflow resumes.
Registry failures stop the release instead of treating the version as absent.

Concurrency queues master runs so a later push cannot discard an earlier version bump.
GitHub permits up to 100 queued runs per group.
GitHub documents `queue: max` in its [concurrency reference](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).
Actionlint 1.7.12 does not recognize this field yet.
Run its other checks with `actionlint -ignore 'unexpected key "queue" for "concurrency" section'` until actionlint supports it.

## One-time npm setup

The repository already has access to the organization secret `NPM_TOKEN`.
No local npm authentication or publication forms part of CI implementation.

OIDC is the default publishing method.
The release job grants `id-token: write` and requires npm 11.5.1 or later.
Use npm's [trusted publishing instructions](https://docs.npmjs.com/trusted-publishers/) to configure:

| Setting | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization | `desplega-ai` |
| Repository | `agent-env` |
| Workflow filename | `ci.yml` |
| Environment | Leave empty |
| Allowed action | Publish |

The initial package may need token authentication before npm exposes its publisher settings.
To publish an initial version without another version bump, dispatch `CI and release` on `master` with both inputs enabled:

```sh
gh workflow run ci.yml --repo desplega-ai/agent-env --ref master \
  -f release=true -f use_npm_token=true
```

This dispatch still runs every ordinary CI job before it publishes.
It passes `secrets.NPM_TOKEN` as `NODE_AUTH_TOKEN` only to the release step.
The release script uses that token only when token publishing is explicitly selected.
After bootstrap, configure the trusted publisher and dispatch with `use_npm_token` disabled to test OIDC.
For manual dispatch, this input overrides the repository variable, including an explicit disabled value.
Remove the token fallback when npm OIDC succeeds.
If token publishing remains necessary, repository variable `NPM_USE_TOKEN=true` enables it for automatic bumps.
This repository currently sets that variable for its initial token-based publication.
The token must permit public publishing under `@desplega.ai`.

To test a version bump before merging:

```sh
npm version patch --no-git-tag-version
# Or: npm version minor --no-git-tag-version
# Or: npm version 0.3.0 --no-git-tag-version
npm run check
npm test
git diff -- package.json
```

Commit the version change through the normal pull request process.
Do not create or push a version tag manually.
The workflow creates the tag after tests and npm verification succeed.
For a retry without another bump, dispatch `ci.yml` with `release=true` on the same commit.
Use GitHub's rerun action when `master` has advanced beyond that commit.

## Manual Hetzner E2E

`.github/workflows/hetzner-e2e.yml` runs only through manual dispatch on `master`.
It creates billed infrastructure only after approval for environment `hetzner-e2e`.
An administrator must create that protected environment before use.
Configure required reviewers, prevent approval by the requester, and restrict deployments to `master`.
Store `HCLOUD_TOKEN` as an environment secret with access to a dedicated test project.
This implementation does not change GitHub settings.

The job installs a pinned Hetzner CLI archive and checks its SHA-256 digest.
It tests an audited package through its installed executable with `AGENT_ENV_TEST_CLOUD=1`.
The suite must remove its server, primary IP, SSH key, volumes, and local state.
The wrapper and `always()` step attempt recovery with the recorded CLI state.
Inspect the dedicated Hetzner project after a runner loss or forced cancellation.
An unavailable runner cannot execute cleanup.

```sh
gh workflow run hetzner-e2e.yml --repo desplega-ai/agent-env --ref master
```

## Local package verification

Docker and Compose must work for integration groups.
The SSH fixture requires Linux, OpenSSH server, rsync, and passwordless sudo.
The S3 fixture requires AWS CLI v2.

```sh
work=$(mktemp -d /tmp/agent-env-package-check-XXXXXX)
npm ci --ignore-scripts
node scripts/pack.mjs "$work"
tarball=$(find "$work" -name '*.tgz' -type f)
bash scripts/ci-e2e.sh "$tarball" core
# Run these integration groups on Linux with Docker available:
bash scripts/ci-e2e.sh "$tarball" docker
bash scripts/ci-e2e.sh "$tarball" compose
bash scripts/ci-e2e.sh "$tarball" ssh
bash scripts/ci-e2e.sh "$tarball" s3
rm -r "$work"
```
