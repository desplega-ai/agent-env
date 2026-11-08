import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DockerProvider } from '../src/providers/docker.mjs';
import { snapshotInstance, restoreSnapshot } from '../src/snapshots.mjs';

const provider = new DockerProvider();
const image = 'busybox:1.37';
let unavailable;
try {
  await provider.docker({}, ['info', '--format', '{{.ServerVersion}}']);
  await provider.docker({}, ['image', 'inspect', image]);
} catch (error) { unavailable = `Docker and the existing ${image} image are required: ${error.message}`; }

async function fixture(t, count = 1, compose = false) {
  const directory = await mkdtemp(join(tmpdir(), 'dev-now-snapshots-test-'));
  const owner = `test-${randomUUID().slice(0, 8)}`;
  const spec = { owner, name: 'source', provider: compose ? 'compose' : 'docker', cwd: directory, services: {} };
  const handle = { spec, workspace: directory, services: {} };
  const containers = [], volumes = [];
  t.after(async () => {
    for (const name of containers.reverse()) await provider.docker(spec, ['rm', '-f', name]).catch(() => {});
    const owned = (await provider.docker(spec, ['volume', 'ls', '-q', '--filter', `label=dev-now.owner=${owner}`])).split(/\s+/).filter(Boolean);
    for (const name of new Set([...volumes, ...owned])) await provider.docker(spec, ['volume', 'rm', name]).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  });
  for (let i = 0; i < count; i++) {
    const service = `db${i}`;
    spec.services[service] = { volumes: { data: '/data' }, env: { SECRET: 'never-in-manifest' } };
    const volume = compose ? `${owner}_data_${i}` : provider.volume(spec, service, 'data');
    const container = `${provider.prefix(spec)}-${service}`;
    volumes.push(volume); containers.push(container);
    await provider.docker(spec, ['volume', 'create', '--label', compose ? `com.docker.compose.project=${owner}` : `dev-now.owner=${owner}`, volume]);
    await provider.docker(spec, ['run', '--rm', '--mount', `type=volume,src=${volume},dst=/data`, image, 'sh', '-c', `mkdir -p /data/nested /data/.bin; printf '%s' ${Buffer.from([0, 255, 1, 254, 10]).toString('base64')} | base64 -d > /data/nested/value; ln -s nested/value /data/link; ln -s ../nested/value /data/.bin/runner; ln /data/nested/value /data/hard; touch /data/nested/${'x'.repeat(120)}; ln -s nested/${'x'.repeat(120)} /data/long-link`]);
    await provider.docker(spec, ['create', '--name', container, ...(compose ? ['--label', `com.docker.compose.project=${owner}`] : []), '--mount', `type=volume,src=${volume},dst=/data`, '--mount', `type=bind,src=${directory},dst=/workspace`, '-e', 'SECRET=never-in-manifest', image, 'sleep', '600']);
    handle.services[service] = compose ? { containers: [container] } : { container };
  }
  return { directory, spec, handle, owner, containers, volumes, destination: { ...spec, name: 'restored' } };
}

test('real Docker exports binary archives, restores fresh volumes, and isolates fork data', { skip: unavailable }, async t => {
  const f = await fixture(t, 2);
  const location = join(f.directory, 'snapshot');
  const { manifest } = await snapshotInstance(f.handle, location, provider);
  assert.equal(manifest.version, 1);
  assert.equal(manifest.volumes.length, 2);
  assert.equal(manifest.omittedMounts.length, 2);
  assert.equal(JSON.stringify(manifest).includes('never-in-manifest'), false);
  for (const volume of manifest.volumes) {
    const archive = await readFile(join(location, volume.archive));
    assert.equal(createHash('sha256').update(archive).digest('hex'), volume.sha256);
    assert.equal(archive.length, volume.bytes);
    assert.ok(archive.includes(Buffer.from([0, 255, 1, 254, 10])));
  }
  const result = await restoreSnapshot(f.destination, location, provider);
  assert.equal(result.volumes.length, 2);
  for (const volume of result.volumes) {
    assert.equal(await provider.docker(f.spec, ['run', '--rm', '--mount', `type=volume,src=${volume.destinationName},dst=/data`, image, 'sh', '-c', 'readlink /data/link']), 'nested/value');
    await provider.docker(f.spec, ['run', '--rm', '--mount', `type=volume,src=${volume.destinationName},dst=/data`, image, 'sh', '-c', `test /data/hard -ef /data/nested/value && test -f /data/.bin/runner && test -f /data/long-link && test -f /data/nested/${'x'.repeat(120)}`]);
    await provider.docker(f.spec, ['run', '--rm', '--mount', `type=volume,src=${volume.destinationName},dst=/data`, image, 'sh', '-c', 'printf fork-only > /data/nested/value']);
  }
  for (const source of f.volumes) {
    assert.equal(await provider.docker(f.spec, ['run', '--rm', '--mount', `type=volume,src=${source},dst=/data`, image, 'sh', '-c', 'base64 /data/nested/value']), Buffer.from([0, 255, 1, 254, 10]).toString('base64'));
  }
  await assert.rejects(restoreSnapshot(f.destination, location, provider), /already exists/);
  await assert.rejects(snapshotInstance(f.handle, location, provider), /EEXIST/);
  assert.ok((await readFile(join(location, 'manifest.json'), 'utf8')).includes('sha256'));
});

test('Compose volume identity comes from inspection, with an explicit restore map', { skip: unavailable }, async t => {
  const f = await fixture(t, 1, true);
  const location = join(f.directory, 'snapshot');
  const { manifest } = await snapshotInstance(f.handle, location, provider);
  assert.equal(manifest.volumes[0].sourceName, f.volumes[0]);
  const destinationName = `${f.owner}_restored_data`;
  const result = await restoreSnapshot(f.destination, location, provider, { volumeNames: { v0: destinationName } });
  assert.equal(result.volumeNames.v0, destinationName);
});

test('snapshot requires stopped services and rejects shared or external mounts', { skip: unavailable }, async t => {
  const f = await fixture(t);
  const location = join(f.directory, 'snapshot');
  await provider.docker(f.spec, ['start', f.containers[0]]);
  await assert.rejects(snapshotInstance(f.handle, location, provider), /Stop service/);
  await provider.docker(f.spec, ['stop', '-t', '0', f.containers[0]]);
  const outsider = `${f.owner}-outsider`;
  f.containers.push(outsider);
  await provider.docker(f.spec, ['create', '--name', outsider, '--mount', `type=volume,src=${f.volumes[0]},dst=/data`, image, 'true']);
  await assert.rejects(snapshotInstance(f.handle, location, provider), /shares this volume/);
  const { manifest } = await snapshotInstance(f.handle, location, provider, { omitUnsupportedMounts: true });
  assert.equal(manifest.volumes.length, 0);
  assert.ok(manifest.omittedMounts.some(mount => /shares/.test(mount.reason)));
  await provider.docker(f.spec, ['rm', outsider]);
  const external = `${f.owner}-external`;
  f.volumes.push(external);
  await provider.docker(f.spec, ['volume', 'create', external]);
  await provider.docker(f.spec, ['rm', f.containers[0]]);
  await provider.docker(f.spec, ['create', '--name', f.containers[0], '--mount', `type=volume,src=${external},dst=/data`, image, 'true']);
  await assert.rejects(snapshotInstance(f.handle, join(f.directory, 'external'), provider), /external/);
});

test('all checksums pass before restore allocates data, and failures preserve existing volumes', { skip: unavailable }, async t => {
  const f = await fixture(t, 2);
  const location = join(f.directory, 'snapshot');
  const { manifest } = await snapshotInstance(f.handle, location, provider);
  await writeFile(join(location, manifest.volumes[1].archive), 'corrupted');
  await assert.rejects(restoreSnapshot(f.destination, location, provider), /Checksum/);
  assert.equal(await provider.docker(f.spec, ['volume', 'ls', '-q', '--filter', `name=^${provider.volume(f.destination, 'db0', 'data')}$`]), '');
  const original = await provider.docker(f.spec, ['volume', 'inspect', f.volumes[0]]);
  await assert.rejects(restoreSnapshot(f.spec, location, provider), /Checksum/);
  assert.equal(await provider.docker(f.spec, ['volume', 'inspect', f.volumes[0]]), original);
});

test('failed restore removes only volumes it created, including uncertain create responses', { skip: unavailable }, async t => {
  const f = await fixture(t, 2);
  const location = join(f.directory, 'snapshot');
  await snapshotInstance(f.handle, location, provider);
  const original = await provider.docker(f.spec, ['volume', 'inspect', f.volumes[0]]);
  let creates = 0;
  const failing = Object.create(provider);
  failing.docker = async (spec, args, options) => {
    const value = await provider.docker(spec, args, options);
    if (args[0] === 'volume' && args[1] === 'create' && ++creates === 2) throw new Error('Simulated lost create response');
    return value;
  };
  await assert.rejects(restoreSnapshot(f.destination, location, failing), /lost create response/);
  assert.equal(await provider.docker(f.spec, ['volume', 'ls', '-q', '--filter', `name=^${provider.prefix(f.destination)}-`]), '');
  assert.equal(await provider.docker(f.spec, ['volume', 'inspect', f.volumes[0]]), original);
});

test('restore detects a concurrent volume creator and preserves its data', { skip: unavailable }, async t => {
  const f = await fixture(t, 2);
  const location = join(f.directory, 'snapshot');
  await snapshotInstance(f.handle, location, provider);
  const competitor = provider.volume(f.destination, 'db1', 'data');
  f.volumes.push(competitor);
  const racing = Object.create(provider);
  racing.docker = async (spec, args, options) => {
    if (args[0] === 'volume' && args[1] === 'create' && args.at(-1) === competitor) {
      await provider.docker(spec, ['volume', 'create', '--label', 'test.owner=someone-else', competitor]);
      await provider.docker(spec, ['run', '--rm', '--mount', `type=volume,src=${competitor},dst=/data`, image, 'sh', '-c', 'printf keep > /data/value']);
    }
    return provider.docker(spec, args, options);
  };
  await assert.rejects(restoreSnapshot(f.destination, location, racing), /Another operation/);
  assert.equal(await provider.docker(f.spec, ['run', '--rm', '--mount', `type=volume,src=${competitor},dst=/data`, image, 'cat', '/data/value']), 'keep');
  assert.equal(await provider.docker(f.spec, ['volume', 'ls', '-q', '--filter', `name=^${provider.volume(f.destination, 'db0', 'data')}$`]), '');
});

test('restore refuses an existing running destination service before volume creation', { skip: unavailable }, async t => {
  const f = await fixture(t);
  const location = join(f.directory, 'snapshot');
  await snapshotInstance(f.handle, location, provider);
  const container = `${provider.prefix(f.destination)}-db0`;
  f.containers.push(container);
  await provider.docker(f.spec, ['run', '-d', '--name', container, image, 'sleep', '600']);
  await assert.rejects(restoreSnapshot(f.destination, location, provider), /Stop service/);
  assert.equal(await provider.docker(f.spec, ['volume', 'ls', '-q', '--filter', `name=^${provider.volume(f.destination, 'db0', 'data')}$`]), '');
});

function tar(entries) {
  const blocks = [];
  for (const { path, type = '0', target = '', body = Buffer.alloc(0) } of entries) {
    const header = Buffer.alloc(512);
    header.write(path, 0, 100);
    header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.fill(32, 148, 156);
    header.write(type, 156); header.write(target, 157, 100);
    header.write('ustar\0', 257); header.write('00', 263);
    const sum = header.reduce((total, byte) => total + byte, 0);
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, body, Buffer.alloc((512 - body.length % 512) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

test('restore rejects unsafe tar entries even when their checksums match', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dev-now-snapshots-malicious-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cases = [
    [{ path: '../escape' }], [{ path: '/escape' }], [{ path: 'link', type: '2', target: '../escape' }],
    [{ path: 'link', type: '2', target: '.' }, { path: 'link/file' }],
    [{ path: 'other', type: '2', target: '.' }, { path: 'link', type: '2', target: 'other/../escape' }],
    [{ path: 'file', type: '1', target: 'other' }],
    [{ path: 'file' }, { path: 'file' }], [{ path: 'file' }, { path: 'file/nested' }],
    [{ path: 'device', type: '3' }], [{ path: 'pax', type: 'x' }],
  ];
  const archives = cases.map(entries => tar(entries));
  const ambiguousFormat = tar([{ path: 'link', type: '2', target: '../escape' }]);
  ambiguousFormat.write('ustar  \0', 257);
  ambiguousFormat.write('fake-prefix', 345);
  ambiguousFormat.fill(32, 148, 156);
  const sum = ambiguousFormat.subarray(0, 512).reduce((total, byte) => total + byte, 0);
  ambiguousFormat.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  archives.push(ambiguousFormat);
  for (const archive of archives) {
    const manifest = { format: 'dev-now-snapshot', version: 1, omittedMounts: [], volumes: [{ id: 'v0', sourceName: 'source', archive: 'v0.tar', mounts: [{ service: 'db', target: '/data' }], bytes: archive.length, sha256: createHash('sha256').update(archive).digest('hex') }] };
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
    await writeFile(join(directory, 'v0.tar'), archive);
    const noAllocation = { docker() { throw new Error('UNEXPECTED DOCKER ACCESS'); } };
    await assert.rejects(restoreSnapshot({}, directory, noAllocation), error => !error.message.includes('UNEXPECTED') && /archive|symbolic|path/.test(error.message));
  }
});

test('restore rejects manifest paths, unsupported versions, and truncated archives before Docker access', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dev-now-snapshots-manifest-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = { format: 'dev-now-snapshot', version: 99, omittedMounts: [], volumes: [] };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(restoreSnapshot({}, directory, {}), /version/);
  const archive = tar([{ path: 'good' }]).subarray(0, 1024);
  manifest.version = 1;
  manifest.volumes = [{ id: 'v0', sourceName: 'source', archive: '../escape', mounts: [{ service: 'db', target: '/data' }], bytes: archive.length, sha256: createHash('sha256').update(archive).digest('hex') }];
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(restoreSnapshot({}, directory, {}), /invalid volume/);
  manifest.volumes[0].archive = 'v0.tar';
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(directory, 'v0.tar'), archive);
  await assert.rejects(restoreSnapshot({}, directory, {}), /truncated/);
});

async function fakeAws(directory) {
  const root = join(directory, 'objects'), command = join(directory, 'aws-fake');
  await mkdir(root);
  const log = join(directory, 'aws-log.jsonl');
  await writeFile(command, `#!${process.execPath}
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, copyFileSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
const root = ${JSON.stringify(root)};
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] !== '--endpoint-url' || args[1] !== 'http://s3.test.invalid:9000' || args[2] !== '--no-cli-pager' || args[3] !== 's3api') throw new Error('Invalid AWS global options');
const op = args[4];
const get = name => args[args.indexOf(name) + 1];
const bucket = get('--bucket');
const bucketRoot = join(root, bucket);
const walk = path => existsSync(path) ? readdirSync(path, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(path, entry.name)) : [join(path, entry.name)]) : [];
if (op === 'list-objects-v2') {
  const prefix = get('--prefix');
  console.log(JSON.stringify({ Contents: walk(bucketRoot).filter(path => path.slice(bucketRoot.length + 1).startsWith(prefix)).slice(0, 1).map(path => ({ Key: path.slice(bucketRoot.length + 1) })) }));
} else if (op === 'put-object') {
  if (get('--if-none-match') !== '*') throw new Error('Conditional create is required');
  const path = join(bucketRoot, get('--key'));
  if (existsSync(path)) throw new Error('PreconditionFailed');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, readFileSync(get('--body')), { flag: 'wx' });
  console.log('{}');
} else if (op === 'get-object') {
  copyFileSync(join(bucketRoot, get('--key')), args.at(-1));
  console.log('{}');
} else throw new Error('Unexpected AWS operation');
`, { mode: 0o755 });
  return { options: { awsCommand: command, endpointUrl: 'http://s3.test.invalid:9000' }, log, root };
}

test('S3 uses a precise AWS CLI contract, publishes the manifest last, and restores binary data', { skip: unavailable }, async t => {
  const f = await fixture(t);
  const fake = await fakeAws(f.directory);
  const location = 's3://test-bucket/checkpoints/one';
  await snapshotInstance(f.handle, location, provider, fake.options);
  const calls = (await readFile(fake.log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(calls[0][4], 'list-objects-v2');
  assert.equal(calls.at(-1)[calls.at(-1).indexOf('--key') + 1], 'checkpoints/one/manifest.json');
  const archive = await readFile(join(fake.root, 'test-bucket', 'checkpoints', 'one', 'v0.tar'));
  assert.ok(archive.includes(Buffer.from([0, 255, 1, 254, 10])));
  const restored = await restoreSnapshot(f.destination, location, provider, fake.options);
  assert.equal(restored.volumes.length, 1);
  await assert.rejects(snapshotInstance(f.handle, location, provider, fake.options), /already contains/);
  // A different prefix must not match this snapshot's prefix.
  await snapshotInstance(f.handle, 's3://test-bucket/checkpoints/one-more', provider, fake.options);
});

test('SSH transport reuses provider arguments and streams archives without text conversion', { skip: unavailable }, async t => {
  const f = await fixture(t);
  const shim = join(f.directory, 'ssh-shim'), log = join(f.directory, 'ssh-log.jsonl');
  await mkdir(shim);
  await writeFile(join(shim, 'ssh'), `#!${process.execPath}
import { appendFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (!args.includes('-F') || args[args.indexOf('--') + 1] !== 'snapshot-host') throw new Error('Invalid SSH connection arguments');
const child = spawn('sh', ['-c', args.at(-1)], { stdio: 'inherit' });
child.on('close', code => process.exit(code ?? 1));
`, { mode: 0o755 });
  const originalPath = process.env.PATH;
  const remoteProvider = new DockerProvider();
  const remoteSpec = { ...f.spec, host: 'snapshot-host', sshConfig: '/test/config with spaces' };
  const location = join(f.directory, 'remote-snapshot');
  try {
    process.env.PATH = `${shim}:${originalPath}`;
    await snapshotInstance({ ...f.handle, spec: remoteSpec }, location, remoteProvider);
    await restoreSnapshot({ ...remoteSpec, name: 'ssh-restored' }, location, remoteProvider);
  } finally { process.env.PATH = originalPath; }
  const calls = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(calls.some(args => args.at(-1).includes("'tar' '-C' '/data' '-cf' '-'") && args.includes('BatchMode=yes')));
  assert.ok(calls.some(args => args.at(-1).includes("'tar' '-C' '/data' '-xf' '-'")));
});

test('failed archive export removes its local destination and leaves source volumes intact', { skip: unavailable }, async t => {
  const f = await fixture(t);
  const textProvider = { docker(spec, args, options) {
    if (args[0] === 'run') {
      assert.equal(typeof options.stdio[1], 'number');
      throw new Error('deliberate-transport-failure');
    }
    return provider.docker(spec, args, options);
  } };
  const failed = join(f.directory, 'transport-failed');
  await assert.rejects(snapshotInstance(f.handle, failed, textProvider), /deliberate-transport-failure/);
  await assert.rejects(lstat(failed), { code: 'ENOENT' });
  assert.notEqual(await provider.docker(f.spec, ['volume', 'inspect', f.volumes[0]]), '');
});
