import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { freePort, delay } from '../src/system.mjs';

const root = resolve(import.meta.dirname, '..');
const directory = await mkdtemp('/tmp/dev-now-e2e-space ');
const state = join(directory, '.dev-now');
const webPort = await freePort(), dbPort = await freePort();
const remote = process.env.DEV_NOW_TEST_SSH;
const sshConfig = process.env.DEV_NOW_TEST_SSH_CONFIG;
const options = [...(remote ? ['--ssh', remote, ...(sshConfig ? ['--ssh-config', sshConfig] : [])] : []), '--no-watch'];
const config = {
  services: {
    web: { image: 'busybox:1.37', port: webPort, containerPort: 3000, command: 'httpd -f -p 3000 -h /workspace', volumes: { data: '/data' } },
    db: { image: 'postgres:16-alpine', port: dbPort, containerPort: 5432, protocol: 'tcp', health: 'pg_isready -h 127.0.0.1 -U postgres', env: { POSTGRES_PASSWORD: 'test-only', POSTGRES_DB: 'app' }, volumes: { data: '/var/lib/postgresql/data' } },
  },
};
await writeFile(join(directory, 'dev-now.json'), JSON.stringify(config));
await writeFile(join(directory, 'index.html'), 'version-one');
await writeFile(join(directory, '.env'), 'TEST_SECRET=do-not-sync');
const invoke = (args, ok = true) => new Promise((resolveResult, reject) => {
  const child = spawn(process.execPath, [join(root, 'bin/dev-now.mjs'), ...args], { cwd: directory, env: { ...process.env, DEV_NOW_HOME: state }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  child.on('error', reject);
  child.on('close', code => {
    if (ok && code !== 0) reject(new Error(`${args.join(' ')}: ${stderr}`));
    else resolveResult({ code, stdout, stderr });
  });
});
const cli = async args => JSON.parse((await invoke([...args, '--json'])).stdout);
const get = (host, headers = {}) => new Promise((resolveResult, reject) => {
  http.get({ host: '127.0.0.1', port: webPort, headers: { host: `${host}:${webPort}`, ...headers } }, async response => {
    let body = '';
    for await (const chunk of response) body += chunk;
    resolveResult({ status: response.statusCode, body });
  }).on('error', reject);
});
const execute = async (name, service, command) => JSON.parse((await invoke(['exec', name, '--service', service, '--json', '--', ...command])).stdout).output;
const sql = (name, query) => execute(name, 'db', ['psql', '-U', 'postgres', '-d', 'app', '-Atc', query]);
try {
  console.log(`E2E target: ${remote ?? 'local Docker'}`);
  let started = Date.now();
  const first = await cli(['up', '--name', 'alpha', ...options]);
  console.log(`First stack ready: ${Date.now() - started} ms`);
  assert.equal(first.connected, true);
  assert.equal((await get('alpha.localhost')).body, 'version-one');
  assert.equal((await get('localhost')).body, 'version-one');
  if (remote) await execute('alpha', 'web', ['sh', '-c', 'test ! -e /workspace/.env']);
  await execute('alpha', 'web', ['sh', '-c', 'printf durable > /data/value']);
  await sql('alpha', "CREATE TABLE evidence(value text); INSERT INTO evidence VALUES ('original');");
  assert.equal(await sql('alpha', 'SELECT value FROM evidence'), 'original');
  await cli(['up', '--name', 'beta', ...options]);
  await execute('beta', 'web', ['sh', '-c', 'test ! -e /data/value']);
  // Each named instance has an independent database.
  assert.equal(await sql('beta', "SELECT count(*) FROM pg_tables WHERE tablename='evidence'"), '0');
  await cli(['use', 'beta']);
  const list = await cli(['list']);
  assert.equal(list.find(item => item.name === 'beta').services.web.selected, true);
  assert.equal((await get('missing.localhost')).status, 404);
  assert.equal((await get('attacker.example')).status, 403);
  await writeFile(join(directory, 'index.html'), 'version-two');
  await cli(['sync', 'alpha']);
  assert.equal((await get('alpha.localhost')).body, 'version-two');
  if (remote) assert.equal((await get('localhost')).body, 'version-one');
  await invoke(['daemon', 'stop']);
  await delay(1200);
  const restored = await cli(['list']);
  assert.equal(restored.find(item => item.name === 'beta').services.web.selected, true);
  assert.equal((await get('alpha.localhost')).body, 'version-two');
  await cli(['down', 'alpha']);
  started = Date.now();
  await cli(['up', '--name', 'alpha', ...options]);
  console.log(`Warm start: ${Date.now() - started} ms`);
  assert.equal(await execute('alpha', 'web', ['cat', '/data/value']), 'durable');
  assert.equal(await sql('alpha', 'SELECT value FROM evidence'), 'original');
  const denied = await invoke(['fork', 'alpha', 'gamma'], false);
  assert.notEqual(denied.code, 0);
  assert.match(denied.stderr, /Stop the source/);
  await cli(['down', 'alpha']);
  await cli(['fork', 'alpha', 'gamma']);
  assert.equal(await execute('gamma', 'web', ['cat', '/data/value']), 'durable');
  assert.equal(await sql('gamma', 'SELECT value FROM evidence'), 'original');
  await sql('gamma', "UPDATE evidence SET value='fork';");
  await cli(['up', '--name', 'alpha', ...options]);
  assert.equal(await sql('alpha', 'SELECT value FROM evidence'), 'original');
  assert.equal(await sql('gamma', 'SELECT value FROM evidence'), 'fork');
  await cli(['use', 'alpha']);
  // PostgreSQL SSL negotiation checks the real TCP route without a client dependency.
  const net = await import('node:net');
  const probe = net.connect(dbPort, '127.0.0.1');
  const sslRequest = Buffer.alloc(8);
  sslRequest.writeInt32BE(8, 0); sslRequest.writeInt32BE(80877103, 4);
  const sslResponse = await new Promise((resolveResult, reject) => {
    probe.setTimeout(3000, () => probe.destroy(new Error('Postgres route timed out.')));
    probe.on('connect', () => probe.write(sslRequest));
    probe.once('data', resolveResult);
    probe.once('error', reject);
  });
  probe.destroy();
  assert.equal(sslResponse.toString(), 'N');
  const failedExec = await invoke(['exec', 'alpha', '--', 'sh', '-c', 'exit 7'], false);
  assert.equal(failedExec.code, 7);
  await cli(['down', 'alpha']);
  await cli(['rm', 'gamma']);
  const retained = await invoke(['fork', 'alpha', 'gamma'], false);
  assert.notEqual(retained.code, 0);
  assert.match(retained.stderr, /already exists/);
  await cli(['up', '--name', 'gamma', ...options]);
  assert.equal(await sql('gamma', 'SELECT value FROM evidence'), 'fork');
  const failedConfig = { services: { web: { ...config.services.web, command: 'touch /data/partial; echo deliberate-failure >&2; exit 9' } } };
  await writeFile(join(directory, 'failed.json'), JSON.stringify(failedConfig));
  const failedStart = await invoke(['up', '--name', 'broken', '--config', 'failed.json', ...options], false);
  assert.notEqual(failedStart.code, 0);
  assert.match(failedStart.stderr, /deliberate-failure/);
  await cli(['up', '--name', 'broken', ...options]);
  await execute('broken', 'web', ['sh', '-c', 'test ! -e /data/partial']);
  const occupied = net.createServer();
  occupied.listen(0, '127.0.0.1');
  await new Promise(resolveResult => occupied.once('listening', resolveResult));
  try {
    const collisionConfig = { services: { web: { ...config.services.web, port: occupied.address().port } } };
    await writeFile(join(directory, 'collision.json'), JSON.stringify(collisionConfig));
    const collision = await invoke(['up', '--name', 'blocked', '--config', 'collision.json', ...options], false);
    assert.notEqual(collision.code, 0);
    assert.match(collision.stderr, /Cannot bind/);
    assert.equal(occupied.listening, true);
  } finally { await new Promise(resolveResult => occupied.close(resolveResult)); }
  console.log('PASS: routing, Postgres, persistence, sync, daemon recovery, fork isolation, failed-start cleanup, port conflicts, and exit codes.');
} finally {
  const cleanup = await invoke(['rm', '--all', '--purge'], false);
  const shutdown = await invoke(['daemon', 'stop'], false);
  assert.equal(cleanup.code, 0, cleanup.stderr);
  assert.equal(shutdown.code, 0, shutdown.stderr);
  await delay(1200);
  await rm(directory, { recursive: true, force: true });
}
