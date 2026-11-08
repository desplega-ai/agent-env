import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { docker, fixture, freePort, sshOptions, requestHttp } from './helpers.mjs';

const test = await fixture('compose', { AGENT_ENV_E2E_PASSWORD: 'compose-private-$-literal' });
const { cwd, home, cli, invoke } = test;
const token = randomUUID();
const port = await freePort(), adminPort = await freePort();
const externalVolume = `agent-env-test-${token}-data`, externalNetwork = `agent-env-test-${token}-net`;
const images = new Set();
let owner, retainedVolume, madeExternalVolume = false, madeExternalNetwork = false;
const options = [...sshOptions(), '--no-watch'];
const exec = async (name, service, command) => (await cli(['exec', name, '--service', service, '--', ...command])).output;
const sql = (name, query) => exec(name, 'db', ['psql', '-U', 'postgres', '-d', 'app', '-Atc', query]);
async function containers() {
  const ids = (await docker(['ps', '-aq', '--filter', `label=agent-env.e2e=${token}`])).split(/\s+/).filter(Boolean);
  return ids.length ? JSON.parse(await docker(['inspect', ...ids])) : [];
}
async function collectImages() {
  for (const info of await containers()) if (info.Config.Image.endsWith(':agent-env')) images.add(info.Config.Image);
}
async function up(name, file, config = 'agent-env.json', extra = []) {
  return cli(['up', '--name', name, '--compose-file', file, '--config', config, ...extra, ...options]);
}
try {
  await docker(['info', '--format', '{{.ServerVersion}}']);
  await docker(['compose', 'version']);
  const source = `services:
  web:
    build: .
    labels: {agent-env.e2e: "${token}"}
    ports: ["${port}:3000"]
    volumes: [".:/workspace"]
    secrets: [test_token]
    configs: [test_settings]
    command: [httpd, -f, -p, "3000", -h, /workspace]
    depends_on:
      db: {condition: service_healthy}
  db:
    image: postgres:16-alpine
    labels: {agent-env.e2e: "${token}"}
    environment:
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?required}
      POSTGRES_DB: app
    volumes: ["data:/var/lib/postgresql/data"]
    healthcheck:
      test: [CMD-SHELL, "pg_isready -h 127.0.0.1 -U postgres"]
      interval: 1s
      timeout: 2s
      retries: 60
  tools:
    image: busybox:1.37
    labels: {agent-env.e2e: "${token}"}
    profiles: [tools]
    command: [sleep, "3600"]
volumes:
  data: {}
secrets:
  test_token:
    file: .env.compose secret
configs:
  test_settings:
    file: .env.compose config
`;
  await writeFile(join(cwd, 'compose.yaml'), source);
  await writeFile(join(cwd, 'Dockerfile'), 'FROM busybox:1.37\n');
  await writeFile(join(cwd, 'index.html'), 'Compose public CLI');
  await writeFile(join(cwd, '.env.compose secret'), 'compose-file-private-value');
  await writeFile(join(cwd, '.env.compose config'), 'compose-file-settings');
  await writeFile(join(cwd, 'agent-env.json'), JSON.stringify({ provider: 'compose', env: { POSTGRES_PASSWORD: { secret: 'POSTGRES_PASSWORD' } } }));
  await cli(['env', 'set', 'POSTGRES_PASSWORD', '--from-env', 'AGENT_ENV_E2E_PASSWORD']);
  const first = await up('alpha', 'compose.yaml');
  const second = await up('beta', 'compose.yaml', 'agent-env.json', ['--profile', 'tools']);
  assert.equal(first.services.db.url, null);
  assert.equal(first.services.tools, undefined);
  assert.equal(second.services.tools.url, null);
  assert.equal((await requestHttp(`http://127.0.0.1:${port}`, { headers: { host: `alpha.localhost:${port}` } })).status, 200);
  assert.equal((await requestHttp(`http://127.0.0.1:${port}`, { headers: { host: `beta.localhost:${port}` } })).body, 'Compose public CLI');
  assert.equal(await exec('alpha', 'web', ['cat', '/run/secrets/test_token']), '[redacted]');
  assert.equal(await exec('alpha', 'web', ['cat', '/test_settings']), 'compose-file-settings');
  if (process.env.AGENT_ENV_TEST_SSH) {
    await exec('alpha', 'web', ['sh', '-c', 'test ! -e "/workspace/.env.compose secret" && test ! -e "/workspace/.env.compose config"']);
  }
  const infos = await containers();
  const network = Object.keys(infos.find(info => Object.keys(info.NetworkSettings.Networks).length).NetworkSettings.Networks)[0];
  owner = JSON.parse(await docker(['network', 'inspect', network]))[0].Labels['agent-env.owner'];
  assert.ok(owner);
  const web = infos.filter(info => info.Config.Labels['com.docker.compose.service'] === 'web');
  assert.equal(web.length, 2);
  const bindings = web.map(info => info.NetworkSettings.Ports['3000/tcp'][0]);
  assert.ok(bindings.every(binding => binding.HostIp === '127.0.0.1'));
  assert.notEqual(bindings[0].HostPort, bindings[1].HostPort);
  await collectImages();
  for (const entry of await readdir(home)) {
    if (!entry.startsWith('compose-')) continue;
    const directory = join(home, entry);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    for (const file of await readdir(directory)) assert.equal((await stat(join(directory, file))).mode & 0o777, 0o600);
  }
  await sql('alpha', "CREATE TABLE evidence(value text); INSERT INTO evidence VALUES ('alpha');");
  assert.equal(await sql('alpha', 'SELECT value FROM evidence'), 'alpha');
  assert.equal(await sql('beta', "SELECT count(*) FROM pg_tables WHERE tablename='evidence'"), '0');
  assert.equal(await exec('alpha', 'db', ['printenv', 'POSTGRES_PASSWORD']), '[redacted]');
  await cli(['down', 'alpha']);
  await cli(['up', 'alpha']);
  assert.equal(await sql('alpha', 'SELECT value FROM evidence'), 'alpha');
  await cli(['rm', 'alpha']);
  await up('alpha', 'compose.yaml');
  assert.equal(await sql('alpha', 'SELECT value FROM evidence'), 'alpha');
  assert.equal(await readFile(join(cwd, 'compose.yaml'), 'utf8'), source);

  await writeFile(join(cwd, 'multi.yaml'), `services:
  web:
    image: busybox:1.37
    labels: {agent-env.e2e: "${token}"}
    command: [sh, -c, "httpd -f -p 8080 & httpd -f -p 8081 & wait"]
    ports: ["8080:8080", "8081:8081"]
    depends_on:
      migrate: {condition: service_completed_successfully}
  migrate:
    image: busybox:1.37
    labels: {agent-env.e2e: "${token}"}
    command: ["true"]
`);
  await writeFile(join(cwd, 'multi.json'), JSON.stringify({ provider: 'compose', compose: { routes: {
    web: { service: 'web', target: 8080, port, protocol: 'http' },
    admin: { service: 'web', target: 8081, port: adminPort, protocol: 'http' },
  } } }));
  await up('multi', 'multi.yaml', 'multi.json');
  for (const routePort of [port, adminPort]) assert.equal((await requestHttp(`http://127.0.0.1:${routePort}`, { headers: { host: `multi.localhost:${routePort}` } })).status, 404);
  const listed = (await cli(['list'])).find(instance => instance.name === 'multi');
  assert.equal(listed.status.migrate, 'exited');
  assert.equal(listed.services.migrate.url, null);

  // A new failed stack must release every container, network, and volume it creates.
  await writeFile(join(cwd, 'failure.yaml'), `services:
  worker:
    image: busybox:1.37
    labels: {agent-env.e2e: "${token}"}
    command: [sh, -c, "printenv POSTGRES_PASSWORD; echo deliberate-compose-failure; exit 9"]
    environment:
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD}
    volumes: ["data:/data"]
volumes:
  data:
    labels: {agent-env.e2e.failure: "${token}"}
`);
  const failure = await invoke(['up', '--name', 'failure', '--compose-file', 'failure.yaml', ...options], false);
  assert.notEqual(failure.code, 0);
  assert.ok(!(failure.stdout + failure.stderr).includes('compose-private-$-literal'));
  assert.equal(await docker(['volume', 'ls', '-q', '--filter', `label=agent-env.e2e.failure=${token}`]), '');
  assert.ok((await containers()).every(info => !info.Config.Labels['com.docker.compose.project'].endsWith('-failure')));
  assert.equal(await docker(['network', 'ls', '-q', '--filter', `label=agent-env.owner=${owner}`, '--filter', 'name=-failure']), '');

  // A later failed start must retain data from the earlier successful stack.
  await writeFile(join(cwd, 'retained.yaml'), `services:
  worker:
    image: busybox:1.37
    labels: {agent-env.e2e: "${token}"}
    command: [sleep, "3600"]
    volumes: ["data:/data"]
volumes:
  data: {}
`);
  await up('retained', 'retained.yaml');
  await exec('retained', 'worker', ['sh', '-c', 'printf preserve-me > /data/value']);
  const retained = (await containers()).find(info => info.Config.Labels['com.docker.compose.project'].endsWith('-retained'));
  retainedVolume = retained.Mounts.find(mount => mount.Destination === '/data').Name;
  await cli(['rm', 'retained']);
  const retainedFailure = await invoke(['up', '--name', 'retained', '--compose-file', 'failure.yaml', ...options], false);
  assert.notEqual(retainedFailure.code, 0);
  await docker(['volume', 'inspect', retainedVolume]);
  await up('retained', 'retained.yaml');
  assert.equal(await exec('retained', 'worker', ['cat', '/data/value']), 'preserve-me');

  await docker(['volume', 'create', externalVolume]);
  madeExternalVolume = true;
  await docker(['network', 'create', externalNetwork]);
  madeExternalNetwork = true;
  await writeFile(join(cwd, 'external.yaml'), `services:
  worker:
    image: busybox:1.37
    labels: {agent-env.e2e: "${token}"}
    command: [sleep, "3600"]
    volumes: ["data:/data"]
volumes:
  data:
    external: true
    name: ${externalVolume}
networks:
  default:
    external: true
    name: ${externalNetwork}
`);
  await up('external', 'external.yaml');
  await exec('external', 'worker', ['sh', '-c', 'printf external-survives > /data/value']);
  await cli(['rm', 'external', '--purge']);
  await docker(['volume', 'inspect', externalVolume]);
  await docker(['network', 'inspect', externalNetwork]);
  assert.equal(await docker(['run', '--rm', '--mount', `type=volume,src=${externalVolume},dst=/data`, 'busybox:1.37', 'cat', '/data/value']), 'external-survives');
  await writeFile(join(cwd, 'Dockerfile.slow'), `FROM busybox:1.37\nRUN echo ${token} >/build-marker && sleep 12\n`);
  await writeFile(join(cwd, 'slow.yaml'), `services:
  web:
    build: {context: ., dockerfile: Dockerfile.slow}
    labels: {agent-env.e2e: "${token}"}
    command: [sh, -c, "sleep 3; exec httpd -f -p 3000"]
    ports: ["${port}:3000"]
`);
  await up('slow', 'slow.yaml', 'agent-env.json', ['--timeout', '8']);
  await collectImages();
  await cli(['rm', 'slow', '--purge']);
  assert.equal(await docker(['image', 'ls', '-q', '--filter', `reference=agent-env-${owner}-slow-web:agent-env`]), '', 'Purge must remove the owned built image.');
  console.log('PASS: Compose CLI builds, profiles, jobs, health, route aliases, isolated ports/data, secrets, persistence, failure cleanup, and external resource protection.');
} finally {
  try { await collectImages(); } finally { await test.cleanup(); }
  const leakedImages = [];
  for (const image of images) {
    if (await docker(['image', 'ls', '-q', '--filter', `reference=${image}`])) {
      leakedImages.push(image);
      await docker(['image', 'rm', image]);
    }
  }
  if (madeExternalVolume) await docker(['volume', 'rm', externalVolume]);
  if (madeExternalNetwork) await docker(['network', 'rm', externalNetwork]);
  if (owner) {
    for (const resource of ['volume', 'network']) {
      const retained = (await docker([resource, 'ls', '-q', '--filter', `label=agent-env.owner=${owner}`])).split(/\s+/).filter(Boolean);
      for (const name of retained) await docker([resource, 'rm', name]);
      assert.equal(await docker([resource, 'ls', '-q', '--filter', `label=agent-env.owner=${owner}`]), '', `${resource} cleanup left owned resources.`);
    }
  }
  assert.equal((await containers()).length, 0);
  assert.deepEqual(leakedImages, [], 'Purge must remove owned Compose images.');
}
