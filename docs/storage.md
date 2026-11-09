# Storage profiles

Configure a backend once, then use `storage://NAME/nonempty-prefix` for snapshots and restores.
S3 stores archives. Running services continue to use their existing Docker volumes.
The transport uses the installed AWS CLI. It adds no storage SDK.

## Requirements

Install AWS CLI v2 with these commands and options:

```sh
aws --version
aws configure export-credentials --help
aws s3api put-object --help
```

The CLI must support `configure export-credentials --format process` and `s3api put-object --if-none-match`.
Validation used AWS CLI 2.34.21. AWS CLI v1 is unsupported.
See the AWS references for [credential export](https://docs.aws.amazon.com/cli/latest/reference/configure/export-credentials.html)
and [conditional object creation](https://docs.aws.amazon.com/cli/latest/reference/s3api/put-object.html).

The backend must reject duplicate `If-None-Match: *` creates with `PreconditionFailed` or HTTP 412.
An accepted duplicate causes compatibility checks to fail.
The bucket must permit prefix listing, uploads, downloads, object metadata reads, and probe deletion.
The compatibility check does not require `HeadBucket` access.
Set the profile's `prefix` within the path that your credentials permit.
Use a private bucket. Keep TLS verification enabled.

## Profile commands

```sh
agent-env storage add backup --provider s3 --bucket my-backups \
  --region eu-west-1 --prefix agent-env --aws-profile work
agent-env storage list
agent-env storage check backup
agent-env down app
agent-env snapshot app storage://backup/checkpoint-001
agent-env restore storage://backup/checkpoint-001 --name restored
agent-env storage remove backup
```

Restore uses the current project configuration. Run it from the intended checkout.
Select a new snapshot prefix and a new restore instance name.
There is no overwrite option.

User profiles reside in `$AGENT_ENV_HOME/storage.json`.
The default path is `~/.local/state/agent-env/storage.json`.
The CLI creates the directory with mode `0700` and the file with mode `0600`.
The file contains a map of names to profiles:

```json
{
  "backup": {
    "provider": "s3",
    "bucket": "my-backups",
    "region": "eu-west-1",
    "prefix": "agent-env",
    "addressingStyle": "auto",
    "awsProfile": "work"
  }
}
```

Use `--project` with `storage add` or `storage remove` to modify `storage` in `agent-env.json`.
Run `agent-env init` first if that file does not exist.
The CLI preserves unrelated configuration fields.
`--config FILE` selects another project configuration file.
`storage list` and `storage check` resolve the effective profile and report its source.
Add `--project` to list or check project definitions only.
With that flag, a missing project definition cannot select a user definition.
Listing excludes credential references and credential values.
Removal affects only the selected source. It never deletes snapshot objects.
Adding an existing name fails. Remove that definition before replacement.

A project definition replaces the complete user definition with the same name.
The CLI never combines their endpoints, buckets, or credential references.
An explicit `awsProfile` overrides static AWS credentials from the shell.
It also ignores shell web-identity role and token settings.
Explicit credential references within that profile override its AWS credential source.
Named storage profiles ignore endpoint URLs from the shell and AWS configuration files.
Set `endpoint` in the storage profile to use a custom server.
Named profiles also ignore AWS CA bundle settings from the shell and AWS configuration during S3 transfers.
Use `caBundle` in the storage profile for a custom CA. Otherwise, AWS CLI uses its standard trust store.
Legacy `s3://` locations retain the standard AWS endpoint settings.
Storage configuration stays outside runtime specifications and runtime identity.
Profile edits do not require container recreation.

Names contain 1 to 48 lowercase letters, digits, or hyphens, starting with a letter.
Location prefixes must contain at least one path segment.
The CLI rejects traversal, encoded paths, empty path segments, unknown profile fields, and endpoints with embedded credentials.
An endpoint cannot contain query parameters or fragments.
An explicit `--endpoint` must exactly match a named S3 profile's endpoint.
Use the profile command to change the endpoint.

## Credentials and AWS configuration

Credentials can use the normal AWS chain, including environment variables, named profiles, SSO, roles, and credential processes.
Complete any required AWS login before the storage command.
The invoking CLI resolves credentials through AWS CLI v2.
It sends the resolved context privately to its daemon for that request.
The request does not inherit AWS credentials or configuration from the daemon's startup environment.
Each AWS subprocess owns its temporary configuration file and removes it after the command.
Daemon uploads do not depend on files owned by the invoking CLI.
The CLI never saves resolved credentials in profiles, runtime specifications, manifests, or logs.
It removes resolved credential values from subprocess errors.

Alternatively, reference environment variable names:

```sh
agent-env storage add backup --provider s3 --bucket my-backups \
  --region eu-west-1 --access-key-env BACKUP_ACCESS_KEY \
  --secret-key-env BACKUP_SECRET_KEY --session-token-env BACKUP_SESSION_TOKEN
```

Supply those variables through the invoking shell's secret mechanism.
Never pass their values as command arguments or put their values in `agent-env.json`.
The access and secret references must appear together.
The session token reference is optional and requires both key references.
Missing or empty references cause an error before storage access.
Explicit key references without a token reference do not reuse a shell session token.

S3 profile fields and corresponding flags:

| JSON field | CLI flag | Meaning |
| --- | --- | --- |
| `provider` | `--provider s3` | Required transport |
| `bucket` | `--bucket` | Required existing bucket |
| `endpoint` | `--endpoint` | Optional HTTP or HTTPS service URL |
| `region` | `--region` | Signing region, otherwise the invoking AWS context supplies it |
| `prefix` | `--prefix` | Optional path before the location prefix, without a trailing slash |
| `addressingStyle` | `--addressing-style` | `auto`, `path`, or `virtual` |
| `awsProfile` | `--aws-profile` | Optional AWS named profile |
| `accessKeyEnv` | `--access-key-env` | Access key variable name |
| `secretKeyEnv` | `--secret-key-env` | Secret key variable name |
| `sessionTokenEnv` | `--session-token-env` | Optional session token variable name |
| `caBundle` | `--ca-bundle` | Optional absolute path to a CA bundle |

Addressing overrides use a temporary private AWS configuration.
The CLI preserves the original AWS files and resolves the selected profile's roles and credentials before transport.
Without an override, it preserves the named profile's S3 addressing style.
`auto` lets AWS CLI choose. `path` uses `endpoint/bucket/key`. `virtual` uses `bucket.endpoint/key`.
The profile region overrides AWS environment and configuration regions.
Temporary credentials must remain valid for the complete operation. The daemon does not refresh them during an upload.

## Backend commands

Replace example buckets, account IDs, endpoints, and variable names with your authorized values.
Create the bucket before these commands.
These commands describe protocol configuration. They do not establish live verification for each vendor.
Run `storage check` against your backend before the first restore.

### AWS S3

```sh
agent-env storage add aws-backup --provider s3 --bucket my-backups \
  --region eu-west-1 --aws-profile work --prefix agent-env
agent-env storage check aws-backup
agent-env snapshot app storage://aws-backup/checkpoint-001
agent-env restore storage://aws-backup/checkpoint-001 --name aws-restored
```

### Cloudflare R2

R2 uses an account endpoint and the `auto` region.
See the [R2 CLI guide](https://developers.cloudflare.com/r2/get-started/cli/).

```sh
agent-env storage add r2-backup --provider s3 --bucket my-backups \
  --endpoint https://ACCOUNT_ID.r2.cloudflarestorage.com --region auto \
  --addressing-style path --access-key-env R2_ACCESS_KEY_ID \
  --secret-key-env R2_SECRET_ACCESS_KEY
agent-env storage check r2-backup
agent-env snapshot app storage://r2-backup/checkpoint-001
agent-env restore storage://r2-backup/checkpoint-001 --name r2-restored
```

### MinIO

Use the server's configured region and endpoint.
This example uses a local server with its default signing region.

```sh
agent-env storage add minio-backup --provider s3 --bucket my-backups \
  --endpoint http://127.0.0.1:9000 --region us-east-1 --addressing-style path \
  --access-key-env MINIO_ACCESS_KEY --secret-key-env MINIO_SECRET_KEY
agent-env storage check minio-backup
agent-env snapshot app storage://minio-backup/checkpoint-001
agent-env restore storage://minio-backup/checkpoint-001 --name minio-restored
```

For a private certificate authority, add `--ca-bundle /absolute/path/ca.pem` with an HTTPS endpoint.

### Hetzner Object Storage

Use the bucket's region and corresponding endpoint.
See the [Hetzner API example](https://docs.hetzner.com/storage/object-storage/getting-started/using-curl/).

```sh
agent-env storage add hetzner-backup --provider s3 --bucket my-backups \
  --endpoint https://fsn1.your-objectstorage.com --region fsn1 \
  --addressing-style path --access-key-env HETZNER_S3_ACCESS_KEY \
  --secret-key-env HETZNER_S3_SECRET_KEY
agent-env storage check hetzner-backup
agent-env snapshot app storage://hetzner-backup/checkpoint-001
agent-env restore storage://hetzner-backup/checkpoint-001 --name hetzner-restored
```

### Generic S3 endpoint

```sh
agent-env storage add custom-backup --provider s3 --bucket my-backups \
  --endpoint https://objects.example.com --region us-east-1 --addressing-style path \
  --access-key-env OBJECT_ACCESS_KEY --secret-key-env OBJECT_SECRET_KEY
agent-env storage check custom-backup
agent-env snapshot app storage://custom-backup/checkpoint-001
agent-env restore storage://custom-backup/checkpoint-001 --name custom-restored
```

### Local profile and legacy locations

Local profiles require an absolute root. The root must already exist.

```sh
agent-env storage add disk --provider local --root /existing/backups
agent-env snapshot app storage://disk/checkpoint-001
agent-env restore storage://disk/checkpoint-001 --name disk-restored
agent-env snapshot app /existing/backups/legacy-checkpoint
agent-env snapshot app s3://my-backups/legacy-checkpoint --endpoint https://objects.example.com
agent-env restore s3://my-backups/legacy-checkpoint --name legacy-restored --endpoint https://objects.example.com
```

`storage check` requires an S3 profile. Local snapshot creation checks the destination when it creates the directory.

## Compatibility, publication, and recovery

Each named S3 snapshot checks compatibility before exporting any volume.
The check creates a unique object under `PROFILE_PREFIX/.agent-env-check/UUID/probe`.
It checks prefix listing, upload, download, duplicate rejection, and preservation of the original content.
Before deletion, it verifies the object's unique ownership metadata.
A cleanup failure reports the exact recovery object. Retain that information for manual inspection.
Checks need permission to delete only their probe objects. They never delete snapshot archives.
Bucket versioning can retain previous probe versions after deletion. Apply an appropriate lifecycle policy if required.

Snapshots stream through private files and retain archive validation and SHA-256 checksums.
Every archive and manifest upload uses conditional creation. The manifest uploads last.
The CLI refuses existing local directories and nonempty S3 snapshot prefixes.
A failed export can leave partial objects. Inspect those objects separately and use a new prefix for a retry.
The transport uses a single PUT per archive, with the backend's single-object size limit.
AWS S3 limits this upload method to 5 GB per volume.
Snapshots and restores require enough local disk space for their archive files.

Installed CLI tests use real SeaweedFS with isolated credentials and state.
They cover a 300 MiB archive, custom endpoints, named profiles, session tokens, conditional writes, and restoration.
AWS, R2, MinIO, and Hetzner are protocol configurations, without live vendor verification in this change.
Backends that ignore conditional writes remain unsupported, even if ordinary uploads succeed.
The automated suite does not yet exercise refusal against a real backend that ignores conditional writes.
Custom HTTPS CA bundles and prefix-restricted IAM policies also need dedicated verification.
