import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { run } from '../src/system.mjs';

const directory = await mkdtemp(join(tmpdir(), 'dev-now-compose-e2e-'));
process.env.DEV_NOW_HOME = join(directory, 'private-state');
const { loadSpec } = await import('../src/config.mjs');
const { ComposeProvider } = await import('../src/providers/compose.mjs');
const { setEnvironmentSecret } = await import('../src/environments.mjs');
const provider = new ComposeProvider();
const handles = [];
const images = new Set();
const failedVolumes = new Set();
const owner = 'compose-e2e-' + process.pid;
const cwd = join(directory, 'checkout');
let externalVolume, externalNetwork;
try {
  await run('docker', ['info', '--format', '{{.ServerVersion}}']);
  await cp(resolve(import.meta.dirname, '../examples/compose'), cwd, { recursive: true });
  const original = await readFile(join(cwd, 'compose.yaml'), 'utf8');
  await setEnvironmentSecret({ cwd, key: 'POSTGRES_PASSWORD', fromEnv: 'INPUT', env: { INPUT: 'test-password-with-$-literal' } });
  const spec = async (name, options = {}) => ({ ...await loadSpec({ cwd, name, ...options }), owner });
  const create = async (name, options) => {
    const configuration = await spec(name, options);
    images.add(`${provider.prefix(configuration)}-web:dev-now`);
    const handle = await provider.create(configuration);
    handles.push(handle);
    return handle;
  };
  const first = await create('alpha');
  const second = await create('beta', { profile: 'tools' });
  assert.equal(first.services.db.internal, true);
  assert.equal(first.services.db.hostPort, undefined);
  assert.equal(first.services.tools, undefined);
  assert.equal(second.services.tools.internal, true);
  assert.notEqual(first.services.web.hostPort, second.services.web.hostPort);
  assert.equal(first.services.web.port, 3000);
  assert.equal((await stat(first.runtimeFile)).mode & 0o777, 0o600);
  assert.equal((await stat(first.runtimeDirectory)).mode & 0o777, 0o700);
  const connections = await provider.connect(first);
  try {
    assert.deepEqual(connections.map(connection => connection.name), ['web']);
    assert.match(await (await fetch(`http://127.0.0.1:${connections[0].backendPort}`)).text(), /Postgres is internal/);
  } finally { connections.forEach(connection => connection.close()); }
  const sql = (handle, query) => provider.exec(handle, 'db', ['psql', '-U', 'postgres', '-d', 'app', '-Atc', query]);
  await sql(first, "CREATE TABLE evidence(value text); INSERT INTO evidence VALUES ('alpha');");
  assert.equal(await sql(first, 'SELECT value FROM evidence'), 'alpha');
  assert.equal(await sql(second, "SELECT count(*) FROM pg_tables WHERE tablename='evidence'"), '0');
  const info = JSON.parse(await provider.docker(first.spec, ['inspect', first.services.db.container]))[0];
  assert.ok(info.Config.Env.includes('POSTGRES_PASSWORD=test-password-with-$-literal'));
  const mounts = info.Mounts.filter(mount => mount.Type === 'volume');
  assert.ok(mounts.every(mount => mount.Name.startsWith(provider.prefix(first.spec))));
  assert.equal(await provider.exec(first, 'db', ['printenv', 'POSTGRES_PASSWORD']), '[redacted]');
  await provider.stop(first);
  await provider.start(first);
  assert.equal(await sql(first, 'SELECT value FROM evidence'), 'alpha');
  await provider.remove(first);
  handles.splice(handles.indexOf(first), 1);
  const restored = await create('alpha');
  assert.equal(await sql(restored, 'SELECT value FROM evidence'), 'alpha');
  assert.equal(await readFile(join(cwd, 'compose.yaml'), 'utf8'), original);

  // Multiple aliases share one container. A completed dependency has no route.
  await writeFile(join(cwd, 'multi.yaml'), 'services:\n  web:\n    image: busybox:1.37\n    command: ["sh", "-c", "httpd -f -p 8080 & httpd -f -p 8081 & wait"]\n    ports: ["8080:8080", "8081:8081"]\n    depends_on:\n      migrate:\n        condition: service_completed_successfully\n  migrate:\n    image: busybox:1.37\n    command: ["true"]\n');
  await writeFile(join(cwd, 'multi.json'), JSON.stringify({ compose: { routes: {
    web: { service: 'web', target: 8080, port: 8080, protocol: 'http' },
    admin: { service: 'web', target: 8081, port: 8081, protocol: 'http' },
  } } }));
  const multi = await provider.create(await spec('multi', { 'compose-file': 'multi.yaml', config: 'multi.json' }));
  handles.push(multi);
  const aliases = await provider.connect(multi);
  try {
    assert.deepEqual(aliases.map(connection => connection.name), ['web', 'admin']);
    for (const connection of aliases) assert.equal((await fetch(`http://127.0.0.1:${connection.backendPort}`)).status, 404);
  } finally { aliases.forEach(connection => connection.close()); }
  assert.equal(multi.services.web.container, multi.services.admin.container);
  assert.equal((await provider.status(multi)).migrate, 'exited');

  // A failed start deletes only volumes that this attempt created.
  await writeFile(join(cwd, 'failure.yaml'), 'services:\n  worker:\n    image: busybox:1.37\n    command: ["sh", "-c", "echo $POSTGRES_PASSWORD; exit 9"]\n    volumes: ["data:/data"]\nvolumes:\n  data: {}\n');
  const failure = await spec('failure', { 'compose-file': 'failure.yaml' });
  const failedVolume = `${provider.prefix(failure)}-data`;
  failedVolumes.add(failedVolume);
  const fail = async () => {
    try { await provider.create(failure); assert.fail('The deliberately failed service started.'); }
    catch (error) { assert.ok(!error.message.includes('test-password-with-$-literal')); assert.match(error.message, /Compose up failed/); }
  };
  await fail();
  assert.equal(await run('docker', ['volume', 'ls', '-q', '--filter', `name=^${failedVolume}$`]), '');
  await run('docker', ['volume', 'create', failedVolume]);
  await fail();
  await run('docker', ['volume', 'inspect', failedVolume]);

  // A purge must not remove resources declared external.
  externalVolume = `dev-now-compose-e2e-${process.pid}-external-data`;
  externalNetwork = `dev-now-compose-e2e-${process.pid}-external-net`;
  await run('docker', ['volume', 'create', externalVolume]);
  await run('docker', ['network', 'create', externalNetwork]);
  await writeFile(join(cwd, 'external.yaml'), `services:\n  worker:\n    image: busybox:1.37\n    command: ["sleep", "3600"]\n    volumes: ["data:/data"]\nvolumes:\n  data:\n    external: true\n    name: ${externalVolume}\nnetworks:\n  default:\n    external: true\n    name: ${externalNetwork}\n`);
  const external = await provider.create(await spec('external', { 'compose-file': 'external.yaml' }));
  handles.push(external);
  await provider.remove(external, true);
  handles.splice(handles.indexOf(external), 1);
  await run('docker', ['volume', 'inspect', externalVolume]);
  await run('docker', ['network', 'inspect', externalNetwork]);
  console.log('PASS: Compose builds, profiles, dependencies, jobs, health, port aliases, loopback ports, private secrets, Postgres isolation, persistence, failure cleanup, source preservation, and external resource protection.');
} finally {
  const errors = [];
  for (const handle of handles.reverse()) {
    try { await provider.remove(handle, true); } catch (error) { errors.push(error); }
  }
  for (const image of images) await run('docker', ['image', 'rm', image]).catch(() => {});
  for (const volume of failedVolumes) await run('docker', ['volume', 'rm', volume]).catch(() => {});
  if (externalVolume) await run('docker', ['volume', 'rm', externalVolume]).catch(() => {});
  if (externalNetwork) await run('docker', ['network', 'rm', externalNetwork]).catch(() => {});
  await provider.dispose();
  await rm(directory, { recursive: true, force: true });
  if (errors.length) throw new AggregateError(errors, 'Compose E2E cleanup failed.');
}
