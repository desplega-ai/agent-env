import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm, stat, symlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import http from 'node:http';
import { freePort, delay, createCli, targetOptions, until, run } from './helpers.mjs';

const directory = await mkdtemp(join(tmpdir(), 'agent-env-e2e-space '));
const remote = process.env.AGENT_ENV_TEST_SSH;
const stateRoot = join(directory, '.agent-env');
const state = remote ? join(stateRoot, 'x'.repeat(Math.max(1, 87 - Buffer.byteLength(stateRoot)))) : stateRoot;
const webPort = await freePort(), dbPort = await freePort();
const options = [...targetOptions(), '--no-watch'];
const config = {
  services: {
    web: { image: 'busybox:1.37', port: webPort, containerPort: 3000, command: 'httpd -f -p 3000 -h /workspace', volumes: { data: '/data' } },
    db: { image: 'postgres:16-alpine', port: dbPort, containerPort: 5432, protocol: 'tcp', health: 'pg_isready -h 127.0.0.1 -U postgres', env: { POSTGRES_PASSWORD: 'test-only', POSTGRES_DB: 'app' }, volumes: { data: '/var/lib/postgresql/data' } },
  },
};
await writeFile(join(directory, 'agent-env.json'), JSON.stringify(config));
await writeFile(join(directory, 'index.html'), 'version-one');
const syncFile = join(directory, 'sync-check.txt');
const syncTime = new Date('2020-01-01T00:00:00Z');
await writeFile(syncFile, 'sync-one');
await utimes(syncFile, syncTime, syncTime);
await writeFile(join(directory, '.env'), 'TEST_SECRET=do-not-sync');
const clientEnv = {};
if (remote) {
  const binaries = join(directory, 'client-bin');
  await mkdir(binaries);
  await symlink(process.execPath, join(binaries, 'node'));
  for (const binary of ['ssh', 'rsync']) {
    await symlink(await run('/bin/sh', ['-c', `command -v ${binary}`]), join(binaries, binary));
  }
  clientEnv.PATH = binaries;
}
const { invoke, cli } = createCli(directory, state, clientEnv);
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
  if (!remote) {
    const unavailableState = join(directory, 'unavailable-engine');
    const { invoke: unavailable } = createCli(directory, unavailableState, {
      DOCKER_HOST: `unix://${join(directory, 'missing-docker.sock')}`, DOCKER_CONTEXT: '',
    });
    const result = await unavailable(['up', '--name', 'unavailable', '--local'], false);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Docker engine is unavailable/);
    await assert.rejects(stat(unavailableState), { code: 'ENOENT' });
  }
  if (remote) {
    assert.ok(Buffer.byteLength(state) >= 88, 'Exercise SSH from a long private state path.');
    assert.ok(Buffer.byteLength(join(state, 'control.sock')) < 104, 'Keep the daemon socket within the macOS path limit.');
  }
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
  await writeFile(syncFile, 'sync-two');
  await utimes(syncFile, syncTime, syncTime);
  await cli(['sync', 'alpha']);
  // Wait for the container's bind mount to expose the synchronized source.
  await until(async () => (await get('alpha.localhost')).body === 'version-two');
  assert.equal(await execute('alpha', 'web', ['cat', '/workspace/sync-check.txt']), 'sync-two');
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
  const failedExec = await invoke(['exec', 'alpha', '--', 'sh', '-c', 'printf failure-stdout; printf failure-stderr >&2; exit 7'], false);
  await cli(['down', 'alpha']);
  await cli(['rm', 'gamma']);
  const retained = await invoke(['fork', 'alpha', 'gamma'], false);
  assert.notEqual(retained.code, 0);
  assert.match(retained.stderr, /already exists/);
  await cli(['up', '--name', 'gamma', ...options]);
  assert.equal(await sql('gamma', 'SELECT value FROM evidence'), 'fork');
  const failedConfig = { services: { web: { ...config.services.web, env: { FAIL_SECRET: 'startup-private-$-literal' }, command: 'touch /data/partial; printf "%s\n" "$FAIL_SECRET"; echo deliberate-failure >&2; exit 9' } } };
  await writeFile(join(directory, 'failed.json'), JSON.stringify(failedConfig));
  const failedStart = await invoke(['up', '--name', 'broken', '--config', 'failed.json', ...options], false);
  assert.notEqual(failedStart.code, 0);
  assert.match(failedStart.stderr, /deliberate-failure/);
  assert.match(failedStart.stderr, /\[redacted\]/);
  assert.ok(!failedStart.stderr.includes('startup-private-$-literal'), 'Failed startup disclosed a secret.');
  await cli(['up', '--name', 'broken', ...options]);
  await execute('broken', 'web', ['sh', '-c', 'test ! -e /data/partial']);
  await execute('broken', 'web', ['sh', '-c', 'printf retained-before-failure > /data/prior']);
  await cli(['rm', 'broken']);
  const retainedFailure = await invoke(['up', '--name', 'broken', '--config', 'failed.json', ...options], false);
  assert.notEqual(retainedFailure.code, 0);
  await cli(['up', '--name', 'broken', ...options]);
  assert.equal(await execute('broken', 'web', ['cat', '/data/prior']), 'retained-before-failure');
  const slowConfig = { startupTimeoutSeconds: 1, services: { web: {
    ...config.services.web, command: 'touch /data/partial; sleep 5; httpd -f -p 3000 -h /workspace',
  } } };
  await writeFile(join(directory, 'slow.json'), JSON.stringify(slowConfig));
  const slowStart = await invoke(['up', '--name', 'slow', '--config', 'slow.json', ...options], false);
  assert.notEqual(slowStart.code, 0);
  assert.match(slowStart.stderr, /ready|timed out|timeout|within 1 seconds/i);
  await cli(['up', '--name', 'slow', '--timeout', '30', ...options]);
  await execute('slow', 'web', ['sh', '-c', 'test ! -e /data/partial']);
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
  assert.equal(failedExec.code, 7);
  assert.match(failedExec.stdout + failedExec.stderr, /failure-stdout/);
  assert.match(failedExec.stdout + failedExec.stderr, /failure-stderr/);
  console.log('PASS: routing, Postgres, persistence, sync, daemon recovery, fork isolation, failed-start cleanup, port conflicts, and exit codes.');
} finally {
  const cleanup = await invoke(['rm', '--all', '--purge'], false);
  const shutdown = await invoke(['daemon', 'stop'], false);
  assert.equal(cleanup.code, 0, cleanup.stderr);
  assert.equal(shutdown.code, 0, shutdown.stderr);
  await delay(1200);
  await rm(directory, { recursive: true, force: true });
}
