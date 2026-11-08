import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { run, freePort } from '../src/system.mjs';

const root = resolve(import.meta.dirname, '..');
const directory = await mkdtemp('/tmp/dev-now-features-');
const cwd = join(directory, 'checkout'), home = join(directory, 'state');
process.env.DEV_NOW_HOME = home;
await run('git', ['init', '-q', cwd]);
const port = await freePort();
const remote = process.env.DEV_NOW_TEST_SSH;
const remoteOptions = remote ? ['--ssh', remote, '--ssh-config', process.env.DEV_NOW_TEST_SSH_CONFIG] : [];
const storage = process.env.DEV_NOW_TEST_S3 ?? join(directory, 'snapshot');
const endpoint = process.env.DEV_NOW_TEST_S3_ENDPOINT;
const storageOptions = endpoint ? ['--endpoint', endpoint] : [];
const env = { ...process.env, DEV_NOW_HOME: home, DEV_NOW_TEST_PASSWORD: 'private-e2e-value-$-literal' };
const cli = async (args, directory = cwd) => JSON.parse(await run(process.execPath, [join(root, 'bin/dev-now.mjs'), '--json', ...args], { cwd: directory, env }));
const exec = async (name, service, args) => (await cli(['exec', name, '--service', service, '--', ...args])).output;
const sql = (name, query) => exec(name, 'db', ['psql', '-U', 'postgres', '-d', 'app', '-Atc', query]);
const images = new Set();
const docker = async args => {
  const { DockerProvider } = await import('../src/providers/docker.mjs');
  const provider = new DockerProvider();
  try { return await provider.docker({ host: remote, sshConfig: process.env.DEV_NOW_TEST_SSH_CONFIG }, args); }
  finally { await provider.dispose(); }
};
try {
  await writeFile(join(cwd, 'compose.yaml'), `services:
  web:
    build: .
    ports: ["${port}:3000"]
    volumes: [".:/workspace"]
    command: ["httpd", "-f", "-p", "3000", "-h", "/workspace"]
    depends_on:
      db: {condition: service_healthy}
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?required}
      POSTGRES_DB: app
    volumes: ["data:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U postgres"]
      interval: 1s
      timeout: 2s
      retries: 60
volumes:
  data: {}
`);
  await writeFile(join(cwd, 'Dockerfile'), 'FROM busybox:1.37\n');
  await writeFile(join(cwd, 'index.html'), 'initial source');
  await cli(['init']);
  const config = JSON.parse(await readFile(join(cwd, 'dev-now.json')));
  config.environments = { review: { env: { POSTGRES_PASSWORD: { secret: 'POSTGRES_PASSWORD' } } } };
  await writeFile(join(cwd, 'dev-now.json'), JSON.stringify(config));
  await run('git', ['-C', cwd, 'add', '.']);
  await run('git', ['-C', cwd, '-c', 'user.name=dev-now E2E', '-c', 'user.email=test@localhost', 'commit', '-qm', 'Test fixture']);
  await writeFile(join(cwd, 'index.html'), 'dirty source copied');
  await writeFile(join(cwd, '.env.local'), 'DO_NOT_COPY=private');
  await cli(['env', 'set', 'POSTGRES_PASSWORD', '--env', 'review', '--from-env', 'DEV_NOW_TEST_PASSWORD']);
  assert.deepEqual(await cli(['env', 'list', '--env', 'review']), ['POSTGRES_PASSWORD']);
  const first = await cli(['up', '--name', 'alpha', '--env', 'review', ...remoteOptions]);
  assert.equal(first.services.db.url, null);
  assert.equal(first.environment, 'review');
  const sourceFile = await readFile(join(cwd, 'compose.yaml'));
  await sql('alpha', "CREATE TABLE evidence(value text); INSERT INTO evidence VALUES ('persisted');");
  assert.equal(await exec('alpha', 'db', ['printenv', 'POSTGRES_PASSWORD']), '[redacted]');
  await cli(['down', 'alpha']);
  const saved = await cli(['snapshot', 'alpha', storage, ...storageOptions]);
  assert.equal(saved.omittedMounts.length, 1);
  const fork = await cli(['fork', 'alpha', 'beta', '--worktree', join(directory, 'beta')]);
  assert.equal(fork.worktree, await realpath(join(directory, 'beta')));
  assert.equal(await readFile(join(fork.worktree, 'index.html'), 'utf8'), 'dirty source copied');
  await assert.rejects(stat(join(fork.worktree, '.env.local')), { code: 'ENOENT' });
  assert.equal(await sql('beta', 'SELECT value FROM evidence'), 'persisted');
  await sql('beta', "UPDATE evidence SET value='fork-only';");
  for (const directory of [cwd, fork.worktree]) {
    await cli(['down', 'beta']);
    await cli(['up', 'beta'], directory);
    assert.equal(await exec('beta', 'db', ['printenv', 'POSTGRES_PASSWORD']), '[redacted]');
    assert.equal(await sql('beta', 'SELECT value FROM evidence'), 'fork-only');
  }
  await assert.rejects(exec('beta', 'db', ['sh', '-c', 'printf "application port 5173: %s" "$POSTGRES_PASSWORD"; exit 7']), error => {
    assert.equal(error.exitCode, 7);
    assert.match(error.message, /application port 5173: \[redacted\]/);
    assert.ok(!error.message.includes(env.DEV_NOW_TEST_PASSWORD));
    return true;
  });
  await cli(['restore', storage, '--name', 'restored', '--env', 'review', ...remoteOptions, ...storageOptions]);
  assert.equal(await sql('restored', 'SELECT value FROM evidence'), 'persisted');
  assert.equal(await sql('beta', 'SELECT value FROM evidence'), 'fork-only');
  await cli(['up', '--name', 'alpha', '--env', 'review', ...remoteOptions]);
  assert.equal(await sql('alpha', 'SELECT value FROM evidence'), 'persisted');
  assert.deepEqual(await readFile(join(cwd, 'compose.yaml')), sourceFile);
  const state = JSON.parse(await readFile(join(home, 'state.json')));
  for (const handle of Object.values(state.instances)) images.add(`dev-now-${handle.spec.owner}-${handle.spec.name}-web:dev-now`);
  console.log(`PASS: ${remote ? 'SSH' : 'local'} Compose CLI, smart init, environments, secret redaction, ${storage.startsWith('s3:') ? 'S3' : 'local'} snapshots, restore, and Git/data fork isolation.`);
} finally {
  const state = await readFile(join(home, 'state.json'), 'utf8').then(JSON.parse).catch(() => ({ instances: {} }));
  for (const handle of Object.values(state.instances)) images.add(`dev-now-${handle.spec.owner}-${handle.spec.name}-web:dev-now`);
  try { await cli(['rm', '--all', '--purge', '--remove-worktree', '--discard-worktree']); }
  finally { await cli(['daemon', 'stop']); }
  for (const image of images) await docker(['image', 'rm', image]).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
