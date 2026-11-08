# Snapshot and Git worktree helpers

These modules provide storage and source helpers for the parent lifecycle code.
The daemon integrates them with snapshot, restore, and fork commands.
S3 stores backup archives. It does not store live database files.

## Snapshot API

```js
import { snapshotInstance, restoreSnapshot } from '../src/snapshots.mjs';

const exported = await snapshotInstance(handle, location, provider, options);
// { location, manifest }

const restored = await restoreSnapshot(destinationSpec, location, provider, options);
// { location, manifest, volumes, volumeNames }
```

`location` is a new local directory or `s3://bucket/nonempty-prefix`.
The local parent directory must exist.
An existing local directory or nonempty S3 prefix causes export to fail.
Restore refuses every existing destination volume, including empty volumes.

The provider must implement `docker(spec, argv, options)` with the Docker provider's command contract.
It must forward `options.stdio` to the child process for archive commands.
The helper redirects archive bytes through file descriptors.
It never converts archive bytes to strings.
The provider handles local execution, SSH arguments, and command quoting.

Each entry in `handle.services` must identify `container` or a `containers` array of container names or IDs.
The helper inspects those containers to discover actual volume names and mount targets.
It does not reconstruct source names from provider naming conventions.
This supports ordinary Docker handles and Compose handles with multiple containers per service.

All source containers must be stopped or newly created.
The helper checks their state before and after export.
Callers must serialize lifecycle operations for the full export or restore operation.
External Docker operations must also leave these containers and volumes unchanged.
The helper cannot prevent another Docker client from starting a container during an archive operation.

**Cloud integration:** the parent must wake the host without starting its containers.
Do not call a cloud resume operation that also starts services before snapshot export.
Pass the reachable Docker host through the provider's existing command helpers.
The helpers do not provision, wake, or shut down cloud hosts.

The helper accepts these options:

| Option | Operation | Meaning |
| --- | --- | --- |
| `image` | Both | Archive helper image. Default: `busybox:1.37`. |
| `endpointUrl` | S3 operations | AWS CLI endpoint URL for compatible services. |
| `awsCommand` | S3 operations | AWS executable path. Default: installed `aws`. Tests use a fake executable. |
| `omitUnsupportedMounts` | Export | Explicitly omit unsupported or shared mounts. Default: reject them. |
| `volumeNames` | Restore | Map manifest volume IDs, such as `v0`, to fresh Docker volume names. |
| `destinationHandle` | Restore | Identify existing destination service containers for a stopped-state check. |
| `composeProject` | Restore | Identify an existing destination Compose project for a stopped-state check. |

The Docker naming fallback checks existing destination containers through `provider.prefix(spec)` when available.
Compose callers must supply `composeProject` or `destinationHandle` when destination containers already exist.
Restore returns a unique `restoreId` for safe failure cleanup through `disposeRestoredVolumes`.
Restore creates volumes only. It does not create containers, copy source files, or start services.
The parent must attach the returned volumes before service creation.

Without `volumeNames`, restore matches each saved service and mount target against `destinationSpec.services[service].volumes`.
It calls `provider.volume(spec, service, key)` to obtain the destination name.
Every saved mount of one source volume must resolve to the same destination name.
The Compose provider resolves destination volume names and labels through its snapshot hooks.
The parent must also preserve shared mounts within the same instance through that map.

```js
const saved = await snapshotInstance(stoppedHandle, '/backups/checkpoint-1', docker);
const destinationSpec = { ...stoppedHandle.spec, name: 'feature-copy' };
const restored = await restoreSnapshot(destinationSpec, '/backups/checkpoint-1', docker);

const composed = await restoreSnapshot(destinationSpec, '/backups/checkpoint-1', compose, {
  composeProject: 'feature-copy',
  volumeNames: { v0: 'feature-copy_database' },
});
```

## Ownership and archive rules

Managed volumes need a matching `agent-env.owner` label or the container's matching `com.docker.compose.project` label.
Only local Docker volumes without driver options qualify for automated export.
Volumes attached to any container outside the handle are shared, even when that container is stopped.
The helper rejects those volumes.
Providers must not assign managed ownership labels to external volumes.

Bind mounts inside `handle.workspace` or `spec.cwd` are omitted as source files.
Source files need a separate Git fork or synchronization operation.
Other bind mounts, tmpfs mounts, external volumes, and shared volumes require separate backup procedures.
`omitUnsupportedMounts: true` records each omission with its service, target, type, and reason.
The parent must display these omissions to the caller.

`manifest.json` has format `agent-env-snapshot`, version `1`.
Each volume record includes its ID, actual source name, service mounts, archive name, SHA-256, and archive byte count.
One source volume produces one archive, even when several source services mount it.
The manifest includes only source name, owner, and provider identifiers.
It does not serialize the specification, container inspection, environment values, or image commands.
Volume contents can contain application secrets. The manifest exclusion does not redact those files.

Archives use uncompressed tar files.
Validation streams file bodies and checks tar headers before extraction.
It supports regular files, directories, internal symbolic links, hard links to earlier files, and GNU long paths.
It rejects traversal paths, absolute paths, duplicate paths, link traversal, external symbolic links, special files, and unsupported tar extensions.
Symbolic link cycles and chains longer than 64 links are also unsupported.
PAX metadata, sparse files, extended attributes, and ACL preservation are outside this format.
Tar numbers must use octal fields. Base-256 numeric fields are unsupported.
The default BusyBox image supplies the tested archive behavior.

Restore copies all archives to a private temporary directory.
It checks every SHA-256, size, and extraction path before creating any volume.
Staging requires additional local free space for the entire snapshot.
Restore labels its newly created volumes with a unique claim token.
Failure cleanup removes only volumes with that token and helper containers with their matching token.
If Docker prevents cleanup, the error includes `cleanupErrors` for the parent to report.
Restore never removes a preexisting volume or destination container.

## S3 behavior

The helper uses installed AWS CLI configuration, credentials, region selection, and environment variables.
It does not accept or store AWS access keys in the manifest.
An optional `endpointUrl` selects an S3-compatible service.

Export checks the prefix with `s3api list-objects-v2`.
It uploads each archive with `s3api put-object --if-none-match '*'`.
It publishes `manifest.json` last with the same condition.
The storage service must support conditional creation.
Download uses `s3api get-object` with a local output file.

A failed S3 export can leave partial objects under its new prefix.
The helper retains them because another writer could own later object versions.
Choose a new prefix for a retry.
Inspect and remove partial objects through a separate storage operation.
The required permissions are object listing, object creation, and object reads.
This module does not list saved snapshots or delete cloud backups.

## Git API

```js
import { createWorktree, removeOwnedWorktree } from '../src/worktrees.mjs';

const fork = await createWorktree(sourceSpec, 'feature-copy', {
  path: '/existing/parent/feature-copy',
  branch: 'feature/database-copy',
  ref: 'HEAD',
  copyChanges: true,
});
// { cwd, ownership, omittedPaths }

await removeOwnedWorktree(fork);
// { removed, branchRetained }

// Explicitly discard files in this owned worktree:
await removeOwnedWorktree(fork, { dirty: 'discard' });
```

`sourceSpec` can be a specification with `cwd` or a directory string.
Git identifies the repository root, common directory, refs, tracked changes, and untracked files.
The default path is a sibling of the source repository named `destinationName`.
The default branch is `destinationName`, and the default ref is `HEAD`.
The helper refuses existing branches, existing paths, and destinations within the source repository.
The destination parent directory must already exist.
For a source subdirectory, returned `cwd` preserves that relative location inside the new worktree.

The default fork applies the source's staged and unstaged changes as one working-tree patch.
It preserves binary bytes, additions, deletions, and executable modes.
It leaves the source index and source files unchanged.
A different base ref can cause patch conflicts. The helper then removes its new worktree and branch.
Set `copyChanges: false` for a clean checkout of the selected ref.

Untracked files come from `git ls-files --others --exclude-standard`.
Only regular files qualify for copying.
Credential names, private keys, dependency directories, and common build directories are excluded.
The same exclusions apply to tracked changes.
The helper reports excluded candidates in `omittedPaths`.
Git already excludes ignored files from the untracked candidates.
The helper does not report those ignored files individually.
Untracked symbolic links and special files are omitted.
The selected ref must not track recognized credential files.
Credential detection uses conservative filename rules. It cannot detect credentials embedded in arbitrary source files.
Committed build files remain part of the selected ref.
Submodule working directories and changes within submodules are not copied.

Ownership records reside in `<git-common-dir>/agent-env-worktrees/<token>.json`.
Persist the returned `ownership` object with the instance record.
Removal checks that record and Git's current repository, path, and branch.
It refuses dirty worktrees, including ignored files, unless the caller explicitly selects `dirty: 'discard'`.
Commit or preserve valuable files before removal.
Removal retains branches with new commits.
Failure cleanup reports a `cleanupError` if Git cannot remove the owned resources.
Callers must serialize Git operations while helpers create or remove a worktree.

The parent coordinates source and volume forks.
Create the worktree first, set the destination specification's `cwd`, and then create the destination volumes and services.
If the data fork fails, remove the returned worktree with the explicit discard option.
That new worktree normally contains the copied source changes and therefore counts as dirty.

## Verification

```sh
node --check src/snapshots.mjs
node --check src/worktrees.mjs
npm run check
node test/run.mjs features
AGENT_ENV_TEST_SSH=my-test-host node test/run.mjs ssh
AGENT_ENV_TEST_S3=s3://test-bucket/prefix node test/run.mjs s3
```

Set `AGENT_ENV_CLI` to the absolute path of an installed package executable.
Docker tests require a running Docker host and can download public images.
Tests use owned temporary containers, volumes, directories, and Git repositories.
They check restoration, source isolation, Compose volumes, archive checksums, cleanup, conflicts, and credential exclusions through the public CLI.
S3 tests use a real S3 service. CI provides a disposable SeaweedFS fixture.
SSH tests use a real server. CI provides a disposable local SSH fixture.

Live integration passed against a temporary SeaweedFS S3 server. Verify each production storage service separately.
Test export and restore against a temporary bucket or a local S3-compatible server.
Check the service's conditional write behavior and remove the test objects afterward.
Live SSH snapshot and restore integration passed on a temporary Hetzner Docker host.
These checks require actual endpoint credentials or an SSH host that the parent supplies.
