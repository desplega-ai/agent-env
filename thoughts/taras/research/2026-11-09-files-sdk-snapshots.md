---
date: 2026-11-09
topic: files-sdk for agent-env snapshot storage
status: research only, nothing implemented
repo: /Users/taras/.t3/projects/dev-now (branch feat/e2b-devcontainers-lifecycle, agent-env 0.5.0)
---

# files-sdk as a snapshot storage layer for agent-env

## 1. Recommendation

Do not replace the snapshot storage code with files-sdk wholesale.

Adopt it narrowly, behind a tiny storage interface that agent-env owns. Keep the local-directory backend and the AWS CLI backend as they are. Add files-sdk only as an optional backend for providers that the AWS CLI cannot reach (Azure, GCS, and similar).

Three facts drive this.

1. Our no-overwrite rule needs conditional create. The SDK offers it only on S3-family adapters, and only when the body is a fully buffered object. I measured a 200 MiB upload through the common API: memory grew by 201 MB. Our archives are whole-volume tars.
2. The SDK's `fs` adapter buffers the whole body and has no conditional create. A 256 MiB stream pushed peak RSS from 100 MB to 614 MB. It also writes a `.meta.json` sidecar next to every object. Our local format has none. Keep our local code.
3. A native streaming conditional create exists through `files.raw`, outside the common API. On SeaweedFS, memory grew by 52 MB for a 200 MiB file. A second create returned 412. Real AWS S3 and R2 remain untested. This S3-specific path does not cover Azure or GCS.

The user wants interchangeable providers configured through the CLI. That goal is reachable with named storage profiles (section 6). The profile layer is the real value. The SDK is one possible transport under it.

The initial research proposed an unsafe opt-in for providers without conditional create. The parent recommendation below rejects that option.

## Parent assessment

The published 3.1.2 package confirms three findings: conditional uploads reject streams, Blob conversion reads the entire body, and filesystem uploads buffer streams.

Named storage profiles should come first. Preserve the existing local and S3 paths, snapshot format, archive checks, and streaming behavior.

Do not offer an unsafe overwrite mode. Reject backends that cannot preserve atomic create without overwriting existing data.

Keep SDK selection internal. Profiles should name the storage provider, not implementation choices such as `s3-sdk`.

Resolve a complete project or user profile. Do not merge credentials from one profile with an endpoint from another profile.

Add another backend only after real installed-CLI tests verify snapshot, restore, concurrent writes, interruption, and cleanup.

This is a recommendation. No profile commands or SDK integration exist yet.

## 2. Evidence labels

- **Verified (doc)**: read in official docs or in the published package.
- **Verified (source)**: read in the package source, with file and line.
- **Verified (run)**: I ran it. Local only. A throwaway SeaweedFS container, local `fs`, and fake credentials.
- **Inference**: reasoned from the above. Not run.
- **Untested**: claimed by a vendor or doc. Not checked here.

## 3. Package facts

| Item | Value | Label |
| --- | --- | --- |
| Name and version | `files-sdk` 3.1.2 (npm `latest`) | Verified (run: `npm view`) |
| License | The package uses MIT. The recorded dependency categories total 169, against 173 installed packages. Complete transitive license coverage remains unverified. | Package license verified. Dependency audit incomplete. |
| Node | `engines.node >=22`. Ours is `>=22.19.0`. Compatible. | Verified (run: `npm view`; our `package.json:25`) |
| Module type | ESM only, `exports` map per adapter (`files-sdk/s3`, `/r2`, `/fs`, `/azure`, `/gcs`) | Verified (package.json) |
| Hard dependencies | `mime`, `p-map`, `fflate`, `aws4fetch`, `commander`, `picomatch`, `safe-regex2` | Verified (run: `npm view`) |
| Provider SDKs | Optional peer dependencies. Examples: `@aws-sdk/client-s3`, `@aws-sdk/lib-storage`, `@azure/storage-blob`, `@google-cloud/storage`, `ssh2-sftp-client`. | Verified (run: `npm view`) |
| Footprint | `files-sdk` + AWS S3 stack + Azure blob: 133 top-level dirs, 106 MB in `node_modules`. Our repo today: 24 top-level, 24 MB. | Verified (run) |
| Lazy loading | "Adapter SDKs ... are loaded lazily on first use" | Verified (doc: `docs/cli/index.mdx:22`) |
| Bundled CLI | `files` bin. JSON output, `--stdin`/`--stdout`, `--config-json`. We would not use it. | Verified (doc: `docs/cli/index.mdx`, `docs/cli/streaming.mdx`) |

Footprint matters. Two of our current dependencies are `e2b` and `@devcontainers/cli`. Adding a 100 MB tree for an optional feature is a real cost. Peer dependencies keep it out of the default install if we leave them uninstalled.

## 4. Contract findings

### 4.1 Streaming

- Download streams. `download(key, { as: "stream" })` returns a `StoredFile` with a stream body. Verified (doc: `docs/api/(instance-methods)/download.mdx`). Verified (run): 25 MiB and 40 MiB objects streamed back with exact byte counts on SeaweedFS.
- Upload accepts `ReadableStream`. On S3 an unknown-length stream goes through `@aws-sdk/lib-storage` multipart automatically. Verified (doc: `docs/adapters/(vendor-adapters)/s3.mdx:21`). Verified (run): 40 MiB file stream uploaded as 8 parts. Memory delta was +82 MB for a 200 MiB file.
- Local `fs` upload buffers everything. Source: `dist/fs/index.js:603`:
  `const bytes = body instanceof ReadableStream ? await collectStream(body) : await bodyToBytes(body);`
  Verified (run): 256 MiB stream, peak RSS 614 MB.
- A `Blob` body is read fully into memory before upload. Source: `dist/chunk-5x6mtmfh.js:86`:
  `const buf = new Uint8Array(await body.arrayBuffer());`
  This applies even to a file-backed `Blob` from `fs.openAsBlob`. Verified (run): +201 MB for a 200 MiB file.

### 4.2 Conditional create without overwrite

The docs state the scope plainly.

> "The initial implementation supports canonical AWS S3 buckets through the AWS SDK adapter. A custom S3 `endpoint` ... does not inherit the claim" (`docs/(concepts)/conditional-operations.mdx:85`)

> "Cloudflare R2 is not supported." (same paragraph)

> "The local filesystem adapter also reports every conditional capability as `false`." (`:87`)

> "There is no probe-then-mutate fallback." (`docs/(concepts)/capabilities.mdx:89`)

Limits on the conditional path:

- Single key only. No multipart, no resumable, no signed upload, no bulk. Verified (doc: `conditional-operations.mdx:89`).
- Stream bodies rejected. Source: `dist/chunk-ms1xp2b3.js:591-593`: `"s3 adapter: conditional uploads do not accept stream bodies; buffer to a Blob or Uint8Array first"`.
- `capabilities.conditional.multipart` is `{ create: false, replace: false }` on every adapter I probed. Verified (run).
- The S3 adapter has an override: `s3({ conditional: true })` forces the claim on a custom endpoint. Source: `dist/chunk-ms1xp2b3.js:466` (`opts.conditional ?? canonicalAws`). The docs say the option overrides detection "in either direction" (`conditional-operations.mdx:85`).

Capability probe results (Verified (run), `files.capabilities.conditional.create`):

| Adapter config | `conditional.create` |
| --- | --- |
| `s3()` AWS, no endpoint | `true` |
| `s3()` with custom endpoint | `false` |
| `s3()` with custom endpoint and `conditional: true` | `true` |
| `r2()` | `false` |
| `azure()` | `false` |
| `fs()` | `false` |

Run result on SeaweedFS 4.52 with `conditional: true`:

- First create succeeded.
- Second create to the same key failed with `FilesError` code `Conflict` ("At least one of the pre-conditions you specified did not hold").
- A stream body failed with `Invalid` before any I/O.
- With no `conditional: true`, create failed with `Unsupported` before any I/O. This is fail-closed and good.

The `files.raw` S3Client path (outside the common API) does a streaming conditional create. Verified (run): `PutObjectCommand` with `IfNoneMatch: '*'`, a file stream, and `ContentLength`. First call 200. Second call 412 `PreconditionFailed`. Memory delta +52 MB for 200 MiB.

Provider-side facts:

- R2 supports it natively. "The conditional headers on `PutObject` (such as `If-Match` and `If-None-Match`) are evaluated atomically ... at most one write succeeds and the others fail with `412 PreconditionFailed`." Verified (doc: https://developers.cloudflare.com/r2/api/s3/api/). The SDK simply does not advertise it. Using `s3({ endpoint, conditional: true })` against R2 is Untested against real R2.
- AWS S3 allows `If-None-Match` on `PutObject`, `CompleteMultipartUpload`, and `CopyObject`. Verified (doc: https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html). The SDK does not use the multipart form. A streaming multipart plus conditional complete would need `files.raw`. Untested.
- Azure Blob: the conditional-headers page lists only `Put Block`, `List Blobs`, and a few others as unsupported. Put Blob is not on that list. Inference: `If-None-Match: *` works on Put Blob. Untested. The SDK does not expose it (`capabilities.conditional.create` is `false`). Source: https://learn.microsoft.com/en-us/rest/api/storageservices/specifying-conditional-headers-for-blob-service-operations
- GCS has `ifGenerationMatch: 0` for create-only. Inference from general knowledge. Not re-checked this session. Untested.

### 4.3 Checksum handling

- The common API has no checksum feature. "There are deliberately no flags for `raw`-only territory such as object versioning, checksums, or POST policies" (`capabilities.mdx:83`).
- With a custom `endpoint`, the S3 adapter sets `requestChecksumCalculation` and `responseChecksumValidation` to `WHEN_REQUIRED`. Source: `dist/chunk-ms1xp2b3.js:444-453`. Canonical AWS keeps the SDK default (CRC32). Documented at `s3.mdx:65-67`.
- The conditional guard strips `x-amz-checksum-*` headers from conditional requests. Source: `dist/chunk-ms1xp2b3.js:100-106` (region near line 100). Inference: conditional PUTs carry no SDK checksum.
- Upload receipts can hash the body with SHA-256, but only for buffered bodies (`docs/(concepts)/receipts.mdx:59`).
- Multipart ETags are not content hashes. Verified (run): `...-5` and `...-8` suffixes.
- The `fs` ETag is a SHA-1-derived hash of the bytes, with quotes in the returned value (`dist/fs/index.js:102-103`; Verified (run): `"d10a7d38d7795538"`).

Conclusion: keep our own SHA-256 in the manifest and verify it on restore. This is what `snapshots.mjs:245-250` and `:345-350` already do. Do not lean on provider ETags.

### 4.4 Credentials

- S3: standard AWS chain, or explicit `credentials` object. Verified (doc: `s3.mdx`).
- R2: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, or explicit options. Verified (doc: `r2.mdx`).
- Azure: five modes. Connection string, account key, token credential, SAS, anonymous. "Explicit auth options always win over environment variables" (`azure.mdx:64`).
- GCS: Application Default Credentials (`gcs.mdx:26-28`).
- `fs`: none.

Each adapter reads its own environment variables. There is no common credential format. Our profile layer must map a small set of secret references to adapter options.

### 4.5 Endpoint support

- S3: `endpoint` and `forcePathStyle`. Verified (run) on SeaweedFS.
- R2: `accountId` or `endpoint`. Verified (doc).
- Azure: `endpoint` for Azurite. Azurite needs `--skipApiVersionCheck` with `@azure/storage-blob` 12.34+ (`azure.mdx:66`). Installed here: 12.34.0.
- Other S3-compatible wrappers exist (MinIO, Hetzner, Wasabi, Storj, and more). They are thin `s3()` wrappers. Verified (doc: `docs/adapters/(vendor-adapters)/`).

### 4.6 Multipart and failed-upload cleanup

- Multipart is per call: `upload(key, body, { multipart: true | { partSize, concurrency } })`. Defaults: 5 MiB parts, 4 in flight. S3 limit is 10,000 parts. Verified (doc: `docs/(concepts)/multipart.mdx`).
- Peak memory is about `partSize x concurrency`. Verified (doc). Verified (run): +82 MB for 200 MiB.
- Cleanup: `new Upload({ ..., leavePartsOnError: false })`. Source: `dist/chunk-ms1xp2b3.js:146-151`. The abort path calls `upload.abort()` (`:162-166`).
- Verified (run): I aborted a streaming multipart upload with an `AbortSignal`. The object did not exist afterward. `list-multipart-uploads` showed no leftover uploads.
- Retries restart the whole call. A `ReadableStream` body is never retried (`multipart.mdx`, "Progress and retries").
- R2 with `client: "fetch"` throws on `multipart`. `aws-sdk` client is the default outside Workers.

Our current README says "Export uses single-object uploads, limited to 5 GB per volume on AWS S3" (`README.md:371`). Multipart removes that limit. But it does not combine with conditional create.

## 5. Requirement matrix

Legend: **Common** = works through the common SDK API. **Check** = needs `files.capabilities` check at runtime. **Outside** = needs `files.raw`, our own code, or our own format change.

| Requirement | Local `fs` | S3 (AWS) | S3-compatible / R2 | Azure (non-S3) |
| --- | --- | --- | --- | --- |
| Stream download to file | Common | Common | Common | Common (inference: same contract, not run) |
| Stream upload, bounded memory | Outside (adapter buffers) | Common via multipart | Common via multipart (Verified run on SeaweedFS) | Common (SDK splits blocks natively per docs; not run) |
| Conditional create, streaming body | Outside | Outside (`files.raw` PutObject) | Outside (`files.raw`, Verified run) | Outside (Azure SDK conditions on `raw`; Untested) |
| Conditional create, buffered body | Not available | Check (`conditional.create`) | Check, needs `s3({conditional:true})`. R2 adapter never advertises it. | Not available |
| Conditional create + multipart | Not available | Not available (SDK rule) | Not available | Not available |
| List prefix for "must be empty" | Common | Common | Common | Common (`list` with prefix) |
| Delete created objects on failure | Common | Common | Common | Common |
| Checksum verification | Outside (we hash) | Outside (we hash) | Outside (we hash) | Outside (we hash) |
| Metadata or sidecars | Adapter adds `.meta.json` | none | none | none |
| Endpoint override | n/a | n/a | Common | Common (`endpoint`) |
| Secrets via env or store | n/a | Check (chain or explicit) | Check | Check (5 modes) |

Reading the matrix: the common API covers listing, deleting, streaming download, and bounded-memory upload. Conditional create is the one requirement that splits providers. It needs a capability check, and for large streaming archives it needs an escape hatch.

## 6. Preserving our invariants

These parts stay exactly as they are. The storage layer must not touch them.

- Manifest format and validation: `snapshots.mjs:9-12`, `:252-264`.
- Tar validation without an extractor: `verifyTar`, `snapshots.mjs:144-243`. Runs on the local temp file, after download and before any volume is created (`:345-350`).
- SHA-256 and byte count per archive: `digest`, `:245-250`. Stored in the manifest and compared on restore.
- Ownership rules: volume ownership labels (`agent-env.owner`, `:86`), restore token label and claim check (`:368-371`), `disposeRestoredVolumes` (`:388-394`). These are Docker-side. Storage never sees them.
- Manifest is written last (`:294`, `:297-299`). Keep this order: archives first, manifest last, then conditional-create each object.
- Safe failed-upload cleanup. Today S3 failures may leave partial objects for manual inspection (`README.md:371`, `docs/snapshots-and-worktrees.md:131`). Local failures remove only the directory we created (`:302-307`, guarded by `owned`). A new backend should keep the same rule: delete only keys this call created, tracked in a list, never by prefix.
- The local temp directory is private and removed in `finally` (`:306`, `:385`).

So the backend interface can stay four methods, all file-based:

```
assertEmpty()                 // today: list-objects-v2 --max-keys 1 / mkdir exclusive
putNew(name, localFile)       // today: put-object --if-none-match '*' / wx file
get(name, localFile)          // today: get-object / copy with wx
removeCreated(names)          // new: delete only keys putNew created
```

`snapshotInstance` and `restoreSnapshot` call these instead of `aws()` and `createWriteStream`. Everything else is unchanged. That is a small diff. It is not a rewrite.

## 7. Minimal named-storage-profile design (not implemented)

### 7.1 Shape

Profiles live in project config under a `storage` key and in a user file. Project config is `agent-env.json` (loaded in `src/config.mjs:62-66`). The user file lives under the existing state root: `AGENT_ENV_HOME` or `~/.local/state/agent-env` (`src/paths.mjs:3`, `src/environments.mjs:83`). Suggested name: `storage.json`, mode 0600.

```json
{
  "storage": {
    "backups": {
      "type": "s3",
      "bucket": "team-backups",
      "prefix": "agent-env",
      "region": "eu-west-1",
      "endpoint": "https://<account>.r2.cloudflarestorage.com",
      "credentials": {
        "accessKeyId": { "env": "BACKUP_KEY_ID" },
        "secretAccessKey": { "env": "BACKUP_SECRET" }
      }
    },
    "nas": { "type": "local", "root": "/mnt/nas/agent-env" },
    "az": { "type": "azure", "container": "snaps", "accountName": "acct",
            "credentials": { "accountKey": { "store": "AZ_KEY" } } }
  }
}
```

Types for v1: `local`, `s3` (AWS CLI engine, today's behavior), `s3-sdk` (SDK engine, covers R2 and compatible), `azure`. Each type has a closed list of allowed fields. Unknown fields fail validation.

### 7.2 Secret references

- Allowed forms: `{ "env": "VAR" }` and `{ "store": "KEY" }`.
- A plain string value in a credential field is an error. Same policy as E2B today: "Do not put E2B credentials in agent-env.json" (`src/config.mjs:82`).
- `env` is read from the CLI process environment, like `awsEnv` is today (`bin/agent-env.mjs:196`).
- `store` reads the private store written by `agent-env env set` (`src/environments.mjs:79-92`). Note: that store is keyed by project path and environment name. A user-level profile cannot use `store` unless we add a global scope. Gap G6.
- Resolve in the CLI process. Send resolved values to the daemon in the request message, as `awsEnv` is sent now (`src/daemon.mjs:158`, `:233`, `:344`). Add resolved values to the redaction set (`src/daemon.mjs:462`).
- Never write resolved values to the manifest, to `agent-env.json`, to logs, or to reports.

### 7.3 Selecting a profile and precedence

My reading of "project/default precedence" is: a project profile beats a user-level profile of the same name. Confirm with Taras.

Order of lookup for `storage://NAME/rest`:

1. Project config `storage.NAME`.
2. User file `storage.NAME`.
3. Error: `Unknown storage profile NAME. Define it in agent-env.json or <state>/storage.json.`

A profile named `default` is not special in v1. If Taras wants "omit the location, use the default", add a project key `defaultStorage: "backups"` later. Not needed for v1.

Project profiles cannot weaken a user profile silently. The CLI prints which source supplied the profile.

### 7.4 Location syntax and backward compatibility

Add one new location form: `storage://NAME/prefix`. It follows the same prefix rules as `s3://` today (non-empty, no `..`, no `?` or `#`, no newlines; see `locationInfo`, `snapshots.mjs:14-20`).

| Input | Behavior |
| --- | --- |
| `s3://bucket/prefix` | Unchanged. AWS CLI engine. `--endpoint` flag unchanged. Same env allowlist (`bin/agent-env.mjs:196`). |
| `/abs/path`, `rel/path` | Unchanged. Local directory, created exclusively with mode 0700. |
| `storage://NAME/prefix` | New. Resolve profile NAME, apply its `prefix`, then the given sub-prefix. |
| bare word `checkpoint` | Still a relative local path. Do not reinterpret it as a profile. |

Why a URI form and not `--storage NAME`: `restore` takes the location as its first positional (`bin/agent-env.mjs:190`), so a flag would leave the positional ambiguous. A scheme is explicit and cannot collide with a local path.

`--endpoint` with `storage://` is an error. The profile owns the endpoint.

### 7.5 Capability checks in the adapter layer

At profile resolution, before any snapshot work:

1. Build the backend.
2. Ask for `conditionalCreate: "stream" | "buffered" | "none"`.
3. Policy:
   - `stream`: fine (local `wx`, AWS CLI, S3 `raw` path).
   - `buffered`: allow only if archive size is under a configured limit (profile field `maxBufferedBytes`, default 64 MiB), else fail before upload.
   - `none`: refuse. Message: `Storage profile NAME cannot create objects without overwriting. Use a backend that supports conditional create, or set "overwrite": "unsafe" on the profile.`
4. If a profile sets the unsafe opt-in, print a visible warning in the output and record it in the manifest as `source.storage.overwriteProtection: "none"`. This needs a manifest field. Gap G7.

This keeps the "no silent weakening" rule.

### 7.6 What the first slice should be

Smallest useful step, in order:

1. Extract the four-method interface. Re-implement the current local and AWS CLI code behind it. No behavior change. The existing E2E suite must pass unchanged.
2. Add `storage://` parsing, profile loading, and secret references. Backends: `local`, `s3` only. This alone delivers named profiles and the CLI config story.
3. Add one SDK-backed type (`s3-sdk` for R2, with `conditional: true` and a `raw` streaming conditional PUT). Prove it on a real second store.
4. Only then consider Azure or GCS.

Steps 1 and 2 need no new dependency. That is a strong point: most of the user's goal needs no files-sdk at all.

## 8. Concrete gaps

| ID | Gap | Impact | Evidence |
| --- | --- | --- | --- |
| G1 | Conditional create needs a buffered body. | Whole archive in memory. Fails for multi-GB volumes. | `chunk-5x6mtmfh.js:86`, `chunk-ms1xp2b3.js:591-593`. Run: +201 MB / 200 MiB. |
| G2 | Only S3-family adapters can do conditional create, and only with `conditional: true` off AWS. `r2()`, `azure()`, `gcs`, `fs`, `s3-fetch` cannot. | Our core no-overwrite rule has no common-API answer for non-S3. | `conditional-operations.mdx:85-87`, `r2.mdx:155`, `s3-fetch.mdx:74`. Run probe. |
| G3 | Conditional create and multipart do not combine. | Cannot have both >5 GB objects and atomic create via the SDK. | `conditional-operations.mdx:89`. AWS allows it natively on `CompleteMultipartUpload`. |
| G4 | `fs` adapter buffers, is labeled "Not for production", and adds sidecars. | Cannot replace our local backend. Local snapshot format would change. | `fs/index.js:603`, `fs.mdx:16`. Run: 614 MB peak. |
| G5 | No checksum feature in the common API. | We keep our own SHA-256. Fine, but no free end-to-end check. | `capabilities.mdx:83`. |
| G6 | `{store}` secret refs are project-scoped. | User-level profiles cannot use the private store. | `environments.mjs:79-85`. |
| G7 | Manifest has no storage metadata. | Cannot record that a snapshot was written without overwrite protection. | `snapshots.mjs:281-285`, `validateManifest` is strict on version 1. A new field needs a compat decision. |
| G8 | Cleanup is prefix-wide on failure only for local dirs. S3 leaves partial objects. | A new backend should delete only keys it created. | `snapshots.mjs:302-307`, `README.md:371`. |
| G9 | Dependency weight and ESM/peer-dependency installs. | 106 MB tree when S3 and Azure SDKs install. Users must install peers themselves. | Run: `du`, `npm view`. |
| G10 | SDK conditional guard rejects the call when the resolved host is not AWS and `conditional` is not set. | Good. But shared-config `endpoint_url` is only caught at request time. | `s3.mdx:43`, `chunk-ms1xp2b3.js:78-91`. |
| G11 | R2 conditional create via `s3({conditional:true})` is not proven on real R2. | Provider doc says it works. SDK says unsupported. | `r2.mdx:155` vs Cloudflare docs. |
| G12 | Azure and GCS create-only paths exist natively but not in the SDK. | Need `files.raw` plus provider SDK code per type. | Inference. |

## 9. Suggested real installed-CLI E2E coverage

AGENTS.md rules apply: end-to-end only, installed CLI, real services, isolated names and ports, no real credentials in fixtures, remove only what the test created. Ordinary CI must not need private credentials or paid cloud. Today the `s3` group already runs against a disposable SeaweedFS container (`scripts/ci-fixtures.sh:89-105`, `test/run.mjs:14,27-37,44,52`). Extend that pattern.

Per-step, all through `agent-env` as installed:

1. **Legacy compatibility**
   - `agent-env snapshot app s3://<bucket>/<new-prefix> --endpoint <seaweed>` then `restore`. Must behave as today.
   - `agent-env snapshot app <new-local-dir>` then `restore`.
   - Second snapshot to the same prefix or directory must fail and leave the first intact.
2. **Profile resolution**
   - Project profile and user profile with the same name: project wins. Output names the source.
   - Unknown profile fails with the documented message.
   - Plain-string credential in config fails before any network call.
   - `{ "env": "X" }` with X unset fails and names X, not its value.
   - Secret values never appear in command output, daemon log, or manifest (grep for the generated random key and secret).
3. **S3-compatible profile (SeaweedFS in CI)**
   - `storage://seaweed/<prefix>` snapshot and restore, then restore verifies SHA-256.
   - Pre-create `manifest.json` under the prefix, then run snapshot. Must refuse (nonempty prefix).
   - Race: two concurrent snapshots to the same new prefix. Exactly one wins. The loser exits non-zero and leaves the winner's manifest and archives restorable.
   - Corrupt one archive byte in the bucket (real `aws s3api put-object` by the test), then restore. Must fail with checksum mismatch before any volume exists.
   - Inject an unsafe tar (the existing tar-validation E2E fixtures) as an archive in storage. Restore must reject.
4. **Failed upload cleanup**
   - Kill the upload mid-stream (SIGTERM to the CLI), then check: no manifest exists, only keys that this run created are removed, a pre-existing unrelated object in the same bucket remains, and no multipart uploads remain (`list-multipart-uploads` empty).
5. **Large archive**
   - Snapshot a volume of at least 300 MiB. Record peak RSS of the CLI and daemon (`/usr/bin/time -l` on macOS, `-v` on Linux). Fail the test if peak exceeds a fixed ceiling well below the archive size. This catches the buffering gap (G1).
   - Fixture volume limit: SeaweedFS needs `-master.volumeSizeLimitMB` and `-volume.max` raised. With the CI values (`64`, `1`) a 24 MiB multipart upload failed with "No writable volumes" after earlier objects filled the volume. Verified (run).
6. **Capability refusal**
   - A profile of a type with no conditional create must fail closed with the documented message, and must not upload anything.
   - With the explicit unsafe opt-in, the output shows a warning and the manifest records it.
7. **Non-S3 backend** (only if added later)
   - Azurite container with `--skipApiVersionCheck`. Same cases 3 and 4. Real Azure is out of scope for ordinary CI.
8. **Real R2** (manual or nightly, private credentials, not in ordinary CI)
   - One snapshot and restore with a throwaway bucket and prefix. Removes only its own prefix. Proves G11.

## 10. What I ran, and what I did not

Ran (all local):

- `npm view files-sdk`, `npm pack files-sdk@3.1.2`, and an install of `files-sdk` plus AWS S3 and Azure blob packages in `/tmp`.
- Capability probes for `fs`, `s3` (three configs), `r2`, `azure`. No network calls.
- A throwaway SeaweedFS 4.52 container with random keys, for: conditional create (200 then 409 `Conflict`), stream rejection, multipart stream upload, streaming download, abort cleanup, and `files.raw` streaming conditional create (200 then 412).
- Memory comparisons: `fs` stream 256 MiB (614 MB peak). 200 MiB through SDK conditional Blob (+201 MB), `files.raw` stream (+52 MB), SDK multipart stream (+82 MB). Each of the three on 200 MiB ran in its own process after a warm-up call.

Early memory numbers at 24 to 48 MiB were noisy and I did not use them. SeaweedFS also failed several early uploads with "No writable volumes". That was the fixture's 64 MB volume limit, not the SDK. The aws CLI failed the same way. I recreated the fixture with larger limits.

Not run:

- Real AWS S3, real R2, real Azure, real GCS. No paid services touched. No credentials printed.
- Azurite and fake-gcs-server.
- Conditional `CompleteMultipartUpload` through `files.raw`.
- SFTP, FTP, WebDAV adapters.
- The files-sdk `sync`, `transfer`, plugin, and MCP features. Not needed for this decision.
- Transitive dependency vulnerability scan.

## 11. Sources

Package and docs (npm tarball `files-sdk@3.1.2`, unpacked read-only):

- `package/package.json`
- `package/docs/(concepts)/conditional-operations.mdx` (lines 85, 87, 89)
- `package/docs/(concepts)/capabilities.mdx` (lines 83, 89)
- `package/docs/(concepts)/multipart.mdx`
- `package/docs/(concepts)/receipts.mdx` (line 59)
- `package/docs/(concepts)/escape-hatch.mdx`
- `package/docs/adapters/(vendor-adapters)/s3.mdx` (lines 21, 43, 45, 63, 65-67)
- `package/docs/adapters/(vendor-adapters)/r2.mdx` (line 155)
- `package/docs/adapters/(vendor-adapters)/azure.mdx` (lines 18, 64, 66)
- `package/docs/adapters/(vendor-adapters)/gcs.mdx` (lines 26-28)
- `package/docs/adapters/(vendor-adapters)/s3-fetch.mdx` (lines 74, 100)
- `package/docs/adapters/(system-adapters)/fs.mdx` (lines 16, 47)
- `package/docs/api/(instance-methods)/upload.mdx`, `download.mdx`
- `package/docs/cli/index.mdx`, `package/docs/cli/streaming.mdx`
- `package/dist/chunk-ms1xp2b3.js` (lines 78-91, 100-106, 146-166, 444-453, 466, 586-608)
- `package/dist/chunk-5x6mtmfh.js` (line 86)
- `package/dist/fs/index.js` (lines 102-103, 256-259, 603)

Web:

- https://files-sdk.dev/ (v3.1.2, "Write once. Store anywhere.", 49 adapters)
- https://www.npmjs.com/package/files-sdk (registry JSON: https://registry.npmjs.org/files-sdk)
- https://developers.cloudflare.com/r2/api/s3/api/ (conditional PutObject)
- https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html
- https://learn.microsoft.com/en-us/rest/api/storageservices/specifying-conditional-headers-for-blob-service-operations

agent-env (this repo):

- `src/snapshots.mjs` lines 9-12, 14-27, 144-250, 252-264, 267-308, 329-394
- `src/config.mjs` lines 62-66, 82
- `src/environments.mjs` lines 79-92
- `src/paths.mjs` line 3
- `src/daemon.mjs` lines 158, 233, 344, 462
- `bin/agent-env.mjs` lines 37, 54, 190-197
- `README.md` lines 355-375
- `docs/snapshots-and-worktrees.md` lines 119-131, 207-221
- `scripts/ci-fixtures.sh` lines 89-105
- `test/run.mjs` lines 14, 27-37, 44, 52
- `AGENTS.md` (project rules)

Short supporting quotes, collected:

> "The initial implementation supports canonical AWS S3 buckets through the AWS SDK adapter."

> "Conditional uploads take a buffered body (`Blob`, `Uint8Array`, `ArrayBuffer`, or string) - a stream is rejected before I/O."

> "The separate body and sidecar layout cannot provide a cross-process atomic ETag compare-and-set boundary."

> "R2 does not advertise the SDK's provider-native conditional operation contract in this release."

> "There is no probe-then-mutate fallback."
