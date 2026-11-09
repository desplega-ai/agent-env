import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCli, docker, fixture, freePort, run, until } from './helpers.mjs';

assert.ok(process.env.AGENT_ENV_CLI, 'Storage tests require an installed CLI.');
const endpoint = process.env.AGENT_ENV_TEST_S3_ENDPOINT;
const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(process.env.AGENT_ENV_TEST_S3 ?? '');
assert.ok(endpoint && match, 'Use the real S3 fixture.');
const [bucket, base] = match.slice(1);
const prefix = `${base}/storage-${randomUUID()}`;
const access = process.env.AWS_ACCESS_KEY_ID, secret = process.env.AWS_SECRET_ACCESS_KEY;
assert.ok(access && secret, 'The fixture requires task-owned credentials.');
const token = `task-session-${randomUUID()}`;
const test = await fixture('storage-s3');
const { directory, cwd, home } = test;
const awsConfig = join(directory, 'aws-config'), awsCredentials = join(directory, 'aws-credentials');
const temporary = join(directory, 'temporary');
await mkdir(temporary, { mode: 0o700 });
const env = {
  TMPDIR: temporary,
  STORAGE_TEST_ACCESS: access, STORAGE_TEST_SECRET: secret, STORAGE_TEST_TOKEN: token,
  AWS_ACCESS_KEY_ID: undefined, AWS_SECRET_ACCESS_KEY: undefined, AWS_SESSION_TOKEN: undefined,
  AWS_SECURITY_TOKEN: 'stale-shell-token',
  AWS_PROFILE: undefined, AWS_DEFAULT_PROFILE: undefined,
  AWS_CONFIG_FILE: awsConfig, AWS_SHARED_CREDENTIALS_FILE: awsCredentials,
  AWS_REGION: 'invalid region', AWS_DEFAULT_REGION: 'invalid region',
};
const { cli, invoke } = createCli(cwd, home, env);
const configFile = join(cwd, 'agent-env.json');
const aws = args => run('aws', ['--endpoint-url', endpoint, '--region', 'us-east-1', 's3api', ...args]);
const exec = async (name, args) => (await cli(['exec', name, '--service', 'web', '--', ...args])).output;
async function snapshotState() { return JSON.parse(await readFile(join(home, 'state.json'))); }
async function assertPrivate(result) {
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  for (const value of [access, secret, token]) assert.ok(!text.includes(value), 'Storage credentials escaped into public output.');
}
try {
  const credentialProcess = join(directory, 'credential-process.mjs');
  const credentialCount = join(directory, 'credential-count');
  await writeFile(credentialProcess, `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(credentialCount)}, 'called\\n');
console.log(JSON.stringify({ Version: 1, AccessKeyId: process.env.STORAGE_TEST_ACCESS, SecretAccessKey: process.env.STORAGE_TEST_SECRET, SessionToken: process.env.STORAGE_TEST_TOKEN }));\n`, { mode: 0o600 });
  await writeFile(awsConfig, `[profile fixture]\nregion = us-east-1\ns3 =\n    addressing_style = virtual\n    signature_version = s3v4\n[profile process-fixture]\nregion = us-east-1\ncredential_process = ${process.execPath} ${credentialProcess}\n[profile endpoint-fixture]\nregion = us-east-1\nendpoint_url = ${endpoint}\n`);
  await writeFile(awsCredentials, `[fixture]\naws_access_key_id = ${access}\naws_secret_access_key = ${secret}\n`, { mode: 0o600 });
  const originalConfig = await readFile(awsConfig, 'utf8');
  const config = { name: 'storage-source', services: { web: { image: 'busybox:1.37', port: await freePort(), containerPort: 3000, command: 'httpd -f -p 3000', volumes: { data: '/data' } } } };
  await writeFile(configFile, JSON.stringify(config));
  // Start the daemon with different AWS credentials. Later commands must use their invoking shell.
  await invoke(['list'], true, { env: { AWS_ACCESS_KEY_ID: 'stale-daemon-access', AWS_SECRET_ACCESS_KEY: 'stale-daemon-secret', AWS_SESSION_TOKEN: 'stale-daemon-token' } });
  await cli(['storage', 'add', 'remote', '--provider', 's3', '--bucket', bucket, '--endpoint', endpoint, '--region', 'us-east-1', '--prefix', prefix, '--addressing-style', 'path', '--access-key-env', 'STORAGE_TEST_ACCESS', '--secret-key-env', 'STORAGE_TEST_SECRET', '--session-token-env', 'STORAGE_TEST_TOKEN']);
  await assertPrivate(await cli(['storage', 'list']));
  await assertPrivate(await cli(['storage', 'check', 'remote']));
  const afterProbe = JSON.parse(await aws(['list-objects-v2', '--bucket', bucket, '--prefix', `${prefix}/.agent-env-check/`]));
  assert.equal(afterProbe.Contents?.length ?? 0, 0, 'Successful probes must remove their owned objects.');
  const fixtureContainer = process.env.AGENT_ENV_TEST_S3_CONTAINER;
  if (fixtureContainer) {
    const [info] = JSON.parse(await run('docker', ['inspect', fixtureContainer]));
    assert.equal(info.Config.Labels['agent-env.ci.fixture'], dirname(process.env.AWS_CONFIG_FILE));
    let child, finished;
    await run('docker', ['pause', fixtureContainer]);
    try {
      child = spawn(process.env.AGENT_ENV_CLI, ['--json', 'storage', 'check', 'remote'], {
        cwd, env: { ...process.env, ...env, AGENT_ENV_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', value => { stdout += value; });
      child.stderr.on('data', value => { stderr += value; });
      finished = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
      });
      await until(async () => (await readdir(temporary)).some(file => /^agent-env-storage-(?!check-)/.test(file)));
      child.kill('SIGINT');
      const stopped = await Promise.race([finished, new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error('Interrupted storage check did not stop.')), 10000);
        timer.unref();
      })]);
      assert.equal(stopped.code, 130, stopped.stderr);
      await assertPrivate(stopped);
      assert.ok(!(await readdir(temporary)).some(file => file.startsWith('agent-env-storage-')));
      console.log('PASS: SIGINT stops the real AWS command and removes private transport files.');
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await run('docker', ['unpause', fixtureContainer]);
      if (finished) await finished;
    }
  }
  await cli(['storage', 'add', 'named', '--provider', 's3', '--bucket', bucket, '--endpoint', endpoint, '--region', 'us-east-1', '--prefix', prefix, '--aws-profile', 'fixture', '--addressing-style', 'path']);
  const staleKeys = {
    AWS_ACCESS_KEY_ID: 'stale-shell-access', AWS_SECRET_ACCESS_KEY: 'stale-shell-secret', AWS_SESSION_TOKEN: 'stale-shell-session',
    AWS_ROLE_ARN: 'arn:aws:iam::000000000000:role/stale-fixture',
    AWS_WEB_IDENTITY_TOKEN_FILE: join(directory, 'missing-web-identity-token'), AWS_ROLE_SESSION_NAME: 'stale-fixture',
  };
  assert.equal((await cli(['storage', 'check', 'named'], { env: staleKeys })).source, 'user');
  const plainCheck = await invoke(['storage', 'check', 'named']);
  assert.match(plainCheck.stdout, /named \(user, s3\).*rejection passed/);
  await assertPrivate(plainCheck);
  await cli(['storage', 'add', 'process', '--provider', 's3', '--bucket', bucket, '--endpoint', endpoint, '--region', 'us-east-1', '--prefix', prefix, '--aws-profile', 'process-fixture', '--addressing-style', 'path']);
  await cli(['storage', 'check', 'process'], { env: staleKeys });
  assert.equal(await readFile(credentialCount, 'utf8'), 'called\n', 'Resolve credential processes once in the invoking CLI.');
  assert.equal(await readFile(awsConfig, 'utf8'), originalConfig, 'Storage commands must preserve the AWS configuration.');
  // A named profile without an endpoint must ignore the shell's fixture endpoint.
  // Block default AWS access through an unused local proxy. No cloud request is sent.
  await cli(['storage', 'add', 'aws-default', '--provider', 's3', '--bucket', bucket, '--region', 'us-east-1', '--access-key-env', 'STORAGE_TEST_ACCESS', '--secret-key-env', 'STORAGE_TEST_SECRET']);
  const blockedProxy = `http://127.0.0.1:${await freePort()}`;
  for (const endpointSource of [{ AWS_ENDPOINT_URL: endpoint }, { AWS_ENDPOINT_URL_S3: endpoint }, { AWS_PROFILE: 'endpoint-fixture' }]) {
    const isolated = await invoke(['storage', 'check', 'aws-default'], false, { env: {
      AWS_ENDPOINT_URL: undefined, AWS_ENDPOINT_URL_S3: undefined, ...endpointSource,
      AWS_MAX_ATTEMPTS: '1', HTTPS_PROXY: blockedProxy, https_proxy: blockedProxy,
      HTTP_PROXY: blockedProxy, http_proxy: blockedProxy,
      NO_PROXY: new URL(endpoint).hostname, no_proxy: new URL(endpoint).hostname,
    } });
    assert.notEqual(isolated.code, 0, 'A named profile inherited the shell endpoint.');
    assert.match(isolated.stderr, /Failed to connect to proxy URL/);
    await assertPrivate(isolated);
  }
  // Project credentials must remain independent of the complete user profile.
  await cli(['storage', 'add', 'remote', '--project', '--provider', 's3', '--bucket', bucket, '--endpoint', endpoint, '--region', 'us-east-1', '--prefix', `${prefix}/project`, '--addressing-style', 'path', '--access-key-env', 'MISSING_ACCESS', '--secret-key-env', 'MISSING_SECRET']);
  const missing = await invoke(['storage', 'check', 'remote'], false);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /MISSING_ACCESS/);
  await cli(['storage', 'remove', 'remote', '--project']);
  const conflict = await invoke(['snapshot', 'storage-source', 'storage://remote/conflict', '--endpoint', 'https://invalid.example.test'], false);
  assert.notEqual(conflict.code, 0);
  assert.match(conflict.stderr, /conflicts/);
  await cli(['storage', 'add', 'remote', '--project', '--provider', 's3', '--bucket', bucket, '--region', 'us-east-1', '--access-key-env', 'MISSING_ACCESS', '--secret-key-env', 'MISSING_SECRET']);
  const noEndpointMerge = await invoke(['snapshot', 'storage-source', 'storage://remote/check', '--endpoint', endpoint], false);
  assert.notEqual(noEndpointMerge.code, 0);
  assert.match(noEndpointMerge.stderr, /conflicts/);
  await cli(['storage', 'remove', 'remote', '--project']);
  await cli(['up']);
  await exec('storage-source', ['sh', '-c', 'printf persisted > /data/evidence']);
  const initial = (await snapshotState()).instances['storage-source'];
  const id = await docker(['inspect', '--format', '{{.Id}}', initial.services.web.container]);
  await cli(['storage', 'add', 'runtime-independent', '--project', '--provider', 'local', '--root', directory]);
  await cli(['up']);
  const updated = (await snapshotState()).instances['storage-source'];
  assert.equal(await docker(['inspect', '--format', '{{.Id}}', updated.services.web.container]), id);
  assert.ok(!Object.hasOwn(updated.spec, 'storage'));
  await cli(['down', 'storage-source']);
  const local = join(directory, 'legacy-local');
  await cli(['snapshot', 'storage-source', local]);
  await cli(['restore', local, '--name', 'local-restored']);
  assert.equal(await exec('local-restored', ['cat', '/data/evidence']), 'persisted');
  await cli(['down', 'local-restored']);
  await cli(['snapshot', 'storage-source', 'storage://runtime-independent/named-local']);
  await cli(['restore', 'storage://runtime-independent/named-local', '--name', 'named-local-restored']);
  assert.equal(await exec('named-local-restored', ['cat', '/data/evidence']), 'persisted');
  await cli(['down', 'named-local-restored']);
  await cli(['up', 'storage-source']);
  await exec('storage-source', ['sh', '-c', 'dd if=/dev/zero of=/data/large.bin bs=1048576 count=300 2>/dev/null']);
  const checksum = await exec('storage-source', ['sha256sum', '/data/large.bin']);
  await cli(['down', 'storage-source']);
  const saved = await cli(['snapshot', 'storage-source', 'storage://remote/large']);
  assert.deepEqual(saved.storageProfile, { name: 'remote', source: 'user' });
  await assertPrivate(saved);
  const manifestFile = join(directory, 'manifest.json');
  await aws(['get-object', '--bucket', bucket, '--key', `${prefix}/large/manifest.json`, manifestFile]);
  const manifest = JSON.parse(await readFile(manifestFile));
  assert.ok(manifest.volumes[0].bytes > 300 * 1024 * 1024);
  await assertPrivate(manifest);
  const duplicate = await invoke(['snapshot', 'storage-source', 'storage://remote/large'], false);
  assert.notEqual(duplicate.code, 0);
  assert.match(duplicate.stderr, /contains data/);
  await assertPrivate(duplicate);
  await cli(['restore', 'storage://named/large', '--name', 'remote-restored']);
  assert.equal(await exec('remote-restored', ['cat', '/data/evidence']), 'persisted');
  assert.equal(await exec('remote-restored', ['sha256sum', '/data/large.bin']), checksum);
  const overwrite = await invoke(['restore', 'storage://remote/large', '--name', 'remote-restored'], false);
  assert.notEqual(overwrite.code, 0);
  assert.match(overwrite.stderr, /new instance name/);
  // The legacy URL and endpoint retain the invoking shell's standard AWS credential chain.
  const legacy = `s3://${bucket}/${prefix}/large`;
  await cli(['restore', legacy, '--endpoint', endpoint, '--name', 'legacy-restored'], { env: { AWS_PROFILE: 'fixture', AWS_REGION: 'us-east-1', AWS_DEFAULT_REGION: 'us-east-1' } });
  assert.equal(await exec('legacy-restored', ['sha256sum', '/data/large.bin']), checksum);
  const failed = await invoke(['storage', 'check', 'remote'], false, { env: { STORAGE_TEST_SECRET: `${secret}-wrong` } });
  assert.notEqual(failed.code, 0);
  await assertPrivate(failed);
  assert.ok(!failed.stderr.includes(`${secret}-wrong`));
  const failedRestore = await invoke(['restore', 'storage://remote/large', '--name', 'unauthorized-restore'], false, { env: { STORAGE_TEST_SECRET: `${secret}-wrong` } });
  assert.notEqual(failedRestore.code, 0);
  await assertPrivate(failedRestore);
  assert.ok(!failedRestore.stderr.includes(`${secret}-wrong`));
  assert.ok(!(await cli(['list'])).some(instance => instance.name === 'unauthorized-restore'));
  for (const file of ['state.json', 'daemon.log']) {
    const text = await readFile(join(home, file), 'utf8').catch(() => '');
    await assertPrivate(text);
    assert.ok(!text.includes('STORAGE_TEST_'));
  }
  await assertPrivate(await readFile(join(home, 'storage.json'), 'utf8'));
  await assertPrivate(await readFile(configFile, 'utf8'));
  assert.equal(await readFile(awsConfig, 'utf8'), originalConfig);
  const temporaryFiles = await readdir(temporary);
  assert.ok(!temporaryFiles.some(name => name.startsWith('agent-env-storage-')), 'Private AWS transport files must be removed.');
  console.log('PASS: real SeaweedFS profiles, region, path style, session tokens, credential processes, and stale daemon isolation.');
  console.log('PASS: 300 MiB snapshot and restore, overwrite refusal, runtime identity, legacy locations, and credential privacy.');
} finally {
  try { await test.cleanup(); }
  finally {
    // This test owns the unique child prefix. Preserve all other fixture objects.
    await run('aws', ['--endpoint-url', endpoint, '--region', 'us-east-1', 's3', 'rm', `s3://${bucket}/${prefix}/`, '--recursive']);
  }
}
