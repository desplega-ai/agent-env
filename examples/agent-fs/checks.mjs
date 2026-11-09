import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import {
  S3Client, CreateBucketCommand, HeadBucketCommand, PutBucketVersioningCommand,
  GetBucketVersioningCommand, GetObjectCommand, ListObjectVersionsCommand,
} from '@aws-sdk/client-s3';

const Bucket = process.env.S3_BUCKET;
const s3 = new S3Client({
  endpoint: process.env.S3_ENDPOINT,
  region: process.env.S3_REGION,
  forcePathStyle: true,
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY },
  maxAttempts: 1,
  requestHandler: { connectionTimeout: 2000, socketTimeout: 5000 },
});
const mode = process.argv[2];
try {
  if (mode === 'init') {
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        await s3.send(new HeadBucketCommand({ Bucket }));
        ready = true;
        break;
      } catch (error) {
        if (error.$metadata?.httpStatusCode === 404) {
          await s3.send(new CreateBucketCommand({ Bucket }));
          ready = true;
          break;
        }
        await Bun.sleep(1000);
      }
    }
    assert.ok(ready, 'The fixture S3 service did not become ready.');
    await s3.send(new PutBucketVersioningCommand({ Bucket, VersioningConfiguration: { Status: 'Enabled' } }));
    console.log('PASS: authenticated S3 bucket initialization and versioning.');
  } else {
    assert.ok(mode === 'write' || mode === 'persist', 'Use write or persist for acceptance checks.');
    const base = 'http://127.0.0.1:7433';
    const request = (path, options = {}) => fetch(`${base}${path}`, { ...options, signal: AbortSignal.timeout(15000) });
    assert.equal((await request('/auth/me')).status, 401, 'Anonymous API access must fail.');
    assert.equal((await request('/auth/me', { headers: { Authorization: 'Bearer invalid-fixture-key' } })).status, 401);
    let identity;
    if (mode === 'write') {
      const response = await request('/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `${randomUUID()}@acceptance.invalid` }),
      });
      assert.equal(response.status, 200, 'Fixture registration must succeed.');
      identity = await response.json();
      await writeFile('/data/acceptance.json', JSON.stringify(identity), { mode: 0o600 });
    } else identity = JSON.parse(await readFile('/data/acceptance.json', 'utf8'));
    const headers = { Authorization: `Bearer ${identity.apiKey}`, 'Content-Type': 'application/json' };
    const me = await request('/auth/me', { headers });
    assert.equal(me.status, 200, 'The real API key must authenticate.');
    const context = await me.json();
    assert.equal(context.userId, identity.userId);
    const driveId = context.defaultDriveId;
    assert.ok(driveId);
    async function cli(args) {
      const child = Bun.spawn(['bun', '--no-env-file', 'packages/cli/src/index.ts', '--json', ...args], {
        env: {
          ...process.env, AGENT_FS_API_URL: base, AGENT_FS_API_KEY: identity.apiKey,
          AGENT_FS_DEFAULT_ORG_ID: identity.orgId, AGENT_FS_DEFAULT_DRIVE_ID: driveId,
        },
        stdout: 'pipe', stderr: 'pipe', stdin: 'ignore',
      });
      const [stdout, , code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      assert.equal(code, 0, 'The agent-fs CLI command must succeed.');
      return JSON.parse(stdout);
    }
    const path = '/acceptance.txt';
    const original = 'agent-env first version\n';
    const updated = 'agent-env persistent version\n';
    if (mode === 'write') {
      assert.equal((await cli(['write', path, '--content', original])).version, 1);
      assert.equal((await cli(['cat', path])).content, original);
      assert.equal((await cli(['write', path, '--content', updated])).version, 2);
    }
    assert.equal((await cli(['cat', path])).content, updated);
    const response = await request(`/orgs/${identity.orgId}/ops`, {
      method: 'POST', headers, body: JSON.stringify({ op: 'cat', driveId, path }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).content, updated);
    assert.deepEqual((await cli(['log', path])).versions.map(row => row.version), [2, 1]);
    const Key = `${identity.orgId}/drives/${driveId}/acceptance.txt`;
    assert.equal((await s3.send(new GetBucketVersioningCommand({ Bucket }))).Status, 'Enabled');
    const object = await s3.send(new GetObjectCommand({ Bucket, Key }));
    assert.equal(await object.Body.transformToString(), updated);
    const versions = (await s3.send(new ListObjectVersionsCommand({ Bucket, Prefix: Key }))).Versions;
    assert.equal(versions.length, 2, 'S3 must retain two real object versions.');
    const historical = await s3.send(new GetObjectCommand({ Bucket, Key, VersionId: versions.find(row => !row.IsLatest).VersionId }));
    assert.equal(await historical.Body.transformToString(), original);
    const denied = await fetch(`${process.env.S3_ENDPOINT}/${Bucket}/${Key}`, { signal: AbortSignal.timeout(5000) });
    assert.equal(denied.status, 403, 'Anonymous object access must fail.');
    console.log(`PASS: ${mode}, HTTP authentication, agent-fs CLI write/read/history, and authenticated S3 version bytes.`);
  }
} finally {
  s3.destroy();
}
