import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSpec } from '../src/config.mjs';
import { ComposeProvider, composeServiceMetadata } from '../src/providers/compose.mjs';
import { run } from '../src/system.mjs';

const composeAvailable = await run('docker', ['compose', 'version']).then(() => true, () => false);
test('remote Compose rejects excluded bind and build paths but accepts nested source directories', { skip: !composeAvailable }, async t => {
  const cwd = await fixture(t);
  for (const directory of ['build', 'dist', 'src/build']) {
    await mkdir(join(cwd, directory), { recursive: true });
    await writeFile(join(cwd, directory, 'Dockerfile'), 'FROM busybox:1.37\n');
  }
  for (const source of ['    build: ./build\n', '    volumes: ["./dist:/assets"]\n', '    build: {context: ., dockerfile: build/Dockerfile}\n']) {
    await writeFile(join(cwd, 'compose.yaml'), `services:\n  worker:\n    image: busybox:1.37\n${source}`);
    const spec = { ...await loadSpec({ cwd }), owner: 'test-owner', host: 'remote' };
    await assert.rejects(new ComposeProvider().prepare(spec, '/remote/workspace', await fixture(t)), /excluded from checkout synchronization/);
  }
  await writeFile(join(cwd, 'compose.yaml'), 'services:\n  worker:\n    build: ./src/build\n    volumes: ["./src/build:/assets"]\n');
  const spec = { ...await loadSpec({ cwd }), owner: 'test-owner', host: 'remote' };
  const prepared = await new ComposeProvider().prepare(spec, '/remote/workspace', await fixture(t));
  const model = JSON.parse(await readFile(prepared.localFile, 'utf8'));
  assert.equal(model.services.worker.build.context, '/remote/workspace/src/build');
  assert.equal(model.services.worker.volumes[0].source, '/remote/workspace/src/build');
});
async function fixture(t, yaml) {
  const cwd = await mkdtemp(join(tmpdir(), 'dev-now-compose-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  if (yaml) await writeFile(join(cwd, 'compose.yaml'), yaml);
  return cwd;
}
const model = () => ({ services: { web: { image: 'node:22', ports: [{ target: 3000, published: '3000' }] }, db: { image: 'postgres:16', expose: ['5432'] }, tools: { image: 'busybox', profiles: ['tools'] } } });
test('metadata retains desired public ports without inventing internal routes', () => {
  const services = composeServiceMetadata(model());
  assert.equal(services.web.port, 3000);
  assert.equal(services.web.protocol, 'http');
  assert.equal(services.db.internal, true);
  assert.equal(services.db.port, undefined);
  assert.equal(services.tools, undefined);
  assert.equal(composeServiceMetadata(model(), { profiles: ['tools'] }).tools.internal, true);
  const optional = model();
  optional.services.tools.ports = [{ target: 8000, published: '8000' }];
  assert.equal(composeServiceMetadata(optional, { routes: { tools: { service: 'tools', target: 8000, port: 8000, protocol: 'http' } } }).tools, undefined);
});
test('multiple published ports require explicit route aliases', () => {
  const config = model();
  config.services.web.ports.push({ target: 9090, published: '9090' });
  assert.throws(() => composeServiceMetadata(config), /multiple ports/);
  const routes = { web: { service: 'web', target: 3000, port: 3000, protocol: 'http' }, admin: { service: 'web', target: 9090, port: 9090, protocol: 'http' } };
  const services = composeServiceMetadata(config, { routes });
  assert.equal(services.admin.composeService, 'web');
  assert.equal(services.admin.containerPort, 9090);
  assert.throws(() => composeServiceMetadata(config, { routes: { ...routes, unused: { service: 'missing', target: 80 } } }), /does not match/);
});
test('unsupported features produce explicit errors before provisioning', () => {
  for (const [property, value, message] of [['network_mode', 'host', /network_mode/], ['scale', 2, /replicas/], ['volumes_from', ['external'], /volumes_from/], ['develop', { watch: [] }, /watch provider/]]) {
    const config = model();
    config.services.web[property] = value;
    assert.throws(() => composeServiceMetadata(config), message);
  }
  const udp = model();
  udp.services.web.ports[0].protocol = 'udp';
  assert.throws(() => composeServiceMetadata(udp), /UDP/);
});
test('loadSpec normalizes real Compose files, selected profiles, environment files, and names', { skip: !composeAvailable }, async t => {
  const cwd = await fixture(t, 'services:\n  web:\n    image: busybox:1.37\n    ports: ["${PUBLIC_PORT}:3000"]\n  db:\n    image: postgres:16-alpine\n  tools:\n    image: busybox:1.37\n    profiles: [tools]\n');
  await writeFile(join(cwd, '.env.review'), 'PUBLIC_PORT=4111\n');
  await writeFile(join(cwd, 'dev-now.json'), JSON.stringify({ environments: { review: { envFiles: ['.env.review'] } } }));
  const spec = await loadSpec({ cwd, env: ['review'], profile: ['tools'], 'compose-file': ['compose.yaml'] });
  assert.equal(spec.provider, 'compose');
  assert.equal(spec.services.web.port, 4111);
  assert.equal(spec.services.tools.internal, true);
  assert.equal(spec.environment, 'review');
  await assert.rejects(loadSpec({ cwd, env: ['review', 'default'] }), /one named environment/);
});
test('private normalization replaces names and ports, isolates resources, and retains literal dollar values', { skip: !composeAvailable }, async t => {
  const source = 'services:\n  web:\n    image: busybox:1.37\n    container_name: fixed-name\n    ports: ["0.0.0.0:3000:3000"]\n    environment:\n      LITERAL: "value-$$DOLLAR"\n    volumes: ["data:/data"]\nvolumes:\n  data:\n    name: fixed-data\nnetworks:\n  default:\n    name: fixed-network\n';
  const cwd = await fixture(t, source);
  const directory = await fixture(t);
  const spec = { ...await loadSpec({ cwd }), owner: 'test-owner' };
  const prepared = await new ComposeProvider().prepare(spec, cwd, directory);
  const runtime = JSON.parse(await readFile(prepared.localFile, 'utf8'));
  assert.equal(runtime.services.web.container_name, undefined);
  assert.ok(runtime.services.web.networks.default.aliases.includes('fixed-name'));
  assert.equal(runtime.services.web.ports[0].host_ip, '127.0.0.1');
  assert.equal(runtime.services.web.ports[0].published, '0');
  assert.equal(runtime.volumes.data.name, 'dev-now-test-owner-' + spec.name + '-data');
  assert.equal(runtime.networks.default.name, 'dev-now-test-owner-' + spec.name + '-default');
  const roundtrip = JSON.parse(await run('docker', ['compose', '-f', prepared.localFile, 'config', '--format', 'json']));
  assert.ok(roundtrip.services.web.environment.LITERAL === 'value-$$DOLLAR');
  assert.equal(await readFile(join(cwd, 'compose.yaml'), 'utf8'), source);
  assert.equal((await stat(prepared.localFile)).mode & 0o777, 0o600);
});
test('default dotenv interpolation stays private and supports log redaction', { skip: !composeAvailable }, async t => {
  const cwd = await fixture(t, 'services:\n  worker:\n    image: busybox:1.37\n    command: ["echo", "${PRIVATE_VALUE}"]\n');
  await writeFile(join(cwd, '.env'), 'PRIVATE_VALUE=private-dollar-$$-value\n');
  const spec = { ...await loadSpec({ cwd }), owner: 'test-owner' };
  const runtimeDirectory = await fixture(t);
  await new ComposeProvider().prepare(spec, cwd, runtimeDirectory);
  const values = JSON.parse(await readFile(join(runtimeDirectory, 'redactions.json'), 'utf8'));
  const value = values.find(item => item?.startsWith('private-dollar-'));
  assert.ok(value);
  assert.equal(await new ComposeProvider().redact({ runtimeDirectory }, `prefix ${value} suffix`), 'prefix [redacted] suffix');
});

test('Compose redaction preserves literals and captures service environment files', { skip: !composeAvailable }, async t => {
  const cwd = await fixture(t, 'services:\n  worker:\n    image: busybox:1.37\n    env_file: private.env\n    secrets: [file-secret]\n    environment:\n      HOST: 0.0.0.0\n      PORT: "5173"\n      FLAG: "1"\n      POSTGRES_DB: app\nsecrets:\n  file-secret:\n    file: private.txt\n');
  await writeFile(join(cwd, 'private.env'), 'UNSET_VALUE\nFILE_VALUE=file-private\nEXPANDED=${POSTGRES_DB}-private\nPORT=1000\n');
  await writeFile(join(cwd, 'private.txt'), 'file-secret-private\n');
  await writeFile(join(cwd, 'dev-now.json'), JSON.stringify({ env: { POSTGRES_DB: 'app', PORT: '5173' } }));
  const previous = process.env.PORT;
  process.env.PORT = '1234';
  t.after(() => { if (previous === undefined) delete process.env.PORT; else process.env.PORT = previous; });
  const spec = { ...await loadSpec({ cwd }), owner: 'test-owner' };
  const runtimeDirectory = await fixture(t);
  const provider = new ComposeProvider();
  await provider.prepare(spec, cwd, runtimeDirectory);
  assert.equal(await provider.redact({ runtimeDirectory }, 'application 0.0.0.0:5173 (1 row) file-private app-private file-secret-private'), 'application 0.0.0.0:5173 (1 row) [redacted] [redacted] [redacted]');
});

test('retained Compose volumes can be purged without the removed runtime file', async () => {
  const provider = new ComposeProvider();
  const spec = { name: 'demo', owner: 'test-owner' };
  const volume = `${provider.prefix(spec)}-data`;
  const calls = [];
  let owner = spec.owner;
  provider.docker = async (_spec, args) => {
    calls.push(args);
    if (args[1] === 'ls') return volume;
    if (args[1] === 'inspect') return JSON.stringify([{ Name: volume, Labels: { 'dev-now.owner': owner, 'com.docker.compose.project': provider.prefix(spec) } }]);
    if (args[1] === 'rm') return '';
    assert.fail(`Unexpected Docker operation: ${args.join(' ')}`);
  };
  const handle = { spec, removed: true, ownedVolumes: [volume], runtimeDirectory: '/missing' };
  await provider.remove(handle, true);
  assert.deepEqual(calls.at(-1), ['volume', 'rm', volume]);
  owner = 'another-owner';
  calls.length = 0;
  await assert.rejects(provider.remove(handle, true), /ownership labels/);
  assert.ok(calls.every(args => args[1] !== 'rm'));
});
test('remote normalization maps build and bind paths while disabled profiles remain inactive', { skip: !composeAvailable }, async t => {
  const cwd = await fixture(t, 'services:\n  web:\n    build: .\n    ports: ["8088:3000"]\n    volumes: [".:/app"]\n  unused:\n    image: busybox:1.37\n    profiles: [optional]\n    volumes: ["/outside-the-checkout:/data"]\n');
  await writeFile(join(cwd, 'Dockerfile'), 'FROM busybox:1.37\n');
  const spec = { ...await loadSpec({ cwd }), owner: 'test-owner', host: 'remote' };
  const prepared = await new ComposeProvider().prepare(spec, '/remote/workspace', await fixture(t));
  const runtime = JSON.parse(await readFile(prepared.localFile, 'utf8'));
  assert.equal(runtime.services.web.build.context, '/remote/workspace');
  assert.equal(runtime.services.web.volumes[0].source, '/remote/workspace');
  assert.equal(runtime.services.unused, undefined);
  await writeFile(join(cwd, 'compose.yaml'), `services:\n  worker:\n    build: ${await fixture(t)}\n`);
  const outside = { ...await loadSpec({ cwd }), owner: 'test-owner', host: 'remote' };
  await assert.rejects(new ComposeProvider().prepare(outside, '/remote/workspace', await fixture(t)), /inside the checkout/);
});
test('services that share a built image use one isolated image tag', { skip: !composeAvailable }, async t => {
  const cwd = await fixture(t, 'services:\n  web:\n    image: shared-app:local\n    build: .\n    pull_policy: always\n  worker:\n    image: shared-app:local\n');
  await writeFile(join(cwd, 'Dockerfile'), 'FROM busybox:1.37\n');
  const spec = { ...await loadSpec({ cwd }), owner: 'test-owner' };
  const prepared = await new ComposeProvider().prepare(spec, cwd, await fixture(t));
  const runtime = JSON.parse(await readFile(prepared.localFile, 'utf8'));
  assert.equal(runtime.services.web.image, runtime.services.worker.image);
  assert.ok(runtime.services.web.image.startsWith(`dev-now-test-owner-${spec.name}-image-`));
  assert.equal(runtime.services.web.pull_policy, 'build');
  assert.equal(runtime.services.worker.pull_policy, 'never');
});
test('the resolved model survives shell changes and makes source changes visible to the daemon', { skip: !composeAvailable }, async t => {
  const cwd = await fixture(t, 'services:\n  worker:\n    image: busybox:1.37\n    command: ["echo", "${DEV_NOW_TEST_INPUT}"]\n');
  const previous = process.env.DEV_NOW_TEST_INPUT;
  t.after(() => { if (previous === undefined) delete process.env.DEV_NOW_TEST_INPUT; else process.env.DEV_NOW_TEST_INPUT = previous; });
  process.env.DEV_NOW_TEST_INPUT = 'first-value';
  const spec = { ...await loadSpec({ cwd }), owner: 'test-owner' };
  process.env.DEV_NOW_TEST_INPUT = 'second-value';
  const prepared = await new ComposeProvider().prepare(spec, cwd, await fixture(t));
  const runtime = JSON.parse(await readFile(prepared.localFile, 'utf8'));
  assert.ok(runtime.services.worker.command.includes('first-value'));
  assert.equal(await new ComposeProvider().redact({ runtimeDirectory: prepared.localFile.replace(/\/compose\.json$/, '') }, 'first-value'), '[redacted]');
  assert.notDeepEqual(spec.compose.model, (await loadSpec({ cwd })).compose.model);
  assert.ok(spec.compose.model.services.worker.command.includes('first-value'));
});
test('remote normalization rejects paths outside the checkout, including symlinks', { skip: !composeAvailable }, async t => {
  const outside = await fixture(t);
  for (const link of [false, true]) {
    const cwd = await fixture(t);
    if (link) await symlink(outside, join(cwd, 'escape'));
    const source = link ? './escape' : outside;
    await writeFile(join(cwd, 'compose.yaml'), `services:\n  web:\n    image: busybox:1.37\n    volumes: ["${source}:/data"]\n`);
    const spec = { ...await loadSpec({ cwd }), owner: 'test-owner', host: 'remote' };
    await assert.rejects(new ComposeProvider().prepare(spec, '/remote/workspace', await fixture(t)), /inside the checkout/);
  }
});
test('connect skips internal services and removal never forces external resources', async () => {
  const provider = new ComposeProvider();
  const services = { web: { hostPort: 4111 }, db: { internal: true } };
  assert.deepEqual((await provider.connect({ spec: {}, services })).map(({ name, backendPort }) => ({ name, backendPort })), [{ name: 'web', backendPort: 4111 }]);
  let args;
  provider.compose = async (handle, value) => { args = value; };
  const directory = await mkdtemp(join(tmpdir(), 'dev-now-compose-remove-test-'));
  await provider.remove({ spec: {}, runtimeDirectory: directory }, true);
  assert.deepEqual(args, ['down', '--remove-orphans', '--volumes']);
});
