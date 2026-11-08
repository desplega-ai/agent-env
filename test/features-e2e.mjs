import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, realpath, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { run, freePort, createCli, sshOptions, docker } from './helpers.mjs';

const directory = await mkdtemp(join(tmpdir(), 'agent-env-features-'));
const cwd = join(directory, 'checkout'), home = join(directory, 'state');
await run('git', ['init', '-q', cwd]);
const port = await freePort();
const remote = process.env.AGENT_ENV_TEST_SSH;
const remoteOptions = sshOptions();
const s3 = process.env.AGENT_ENV_TEST_S3;
const storage = s3 ? `${s3.replace(/\/$/, '')}/agent-env-e2e-${Date.now()}-${process.pid}` : join(directory, 'snapshot');
const endpoint = process.env.AGENT_ENV_TEST_S3_ENDPOINT;
const storageOptions = endpoint ? ['--endpoint', endpoint] : [];
const env = { ...process.env, AGENT_ENV_HOME: home, AGENT_ENV_TEST_PASSWORD: 'private-e2e-value-$-literal' };
const { cli: jsonCli, invoke } = createCli(cwd, home, env);
const cli = (args, directory = cwd) => jsonCli(args, { cwd: directory });
const exec = async (name, service, args) => (await cli(['exec', name, '--service', service, '--', ...args])).output;
const sql = (name, query) => exec(name, 'db', ['psql', '-U', 'postgres', '-d', 'app', '-Atc', query]);
const images = new Set();

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
  await writeFile(join(cwd, 'binary.dat'), Buffer.from([0, 255, 13, 10, 129]));
  await writeFile(join(cwd, 'removed.txt'), 'remove in dirty checkout');
  await writeFile(join(cwd, '.gitignore'), 'ignored.txt\nnode_modules/\n');
  await cli(['init']);
  const config = JSON.parse(await readFile(join(cwd, 'agent-env.json')));
  config.environments = { review: { env: { POSTGRES_PASSWORD: { secret: 'POSTGRES_PASSWORD' } } } };
  await writeFile(join(cwd, 'agent-env.json'), JSON.stringify(config));
  await run('git', ['-C', cwd, 'add', '.']);
  await run('git', ['-C', cwd, '-c', 'user.name=agent-env E2E', '-c', 'user.email=test@localhost', 'commit', '-qm', 'Test fixture']);
  await writeFile(join(cwd, 'index.html'), 'dirty source copied');
  await writeFile(join(cwd, '.env.local'), 'DO_NOT_COPY=private');
  await writeFile(join(cwd, 'binary.dat'), Buffer.from([0, 254, 0, 253]));
  await rm(join(cwd, 'removed.txt'));
  await mkdir(join(cwd, 'src/build'), { recursive: true });
  await writeFile(join(cwd, 'src/build/source.txt'), 'nested source');
  await writeFile(join(cwd, 'ignored.txt'), 'ignored private data');
  await writeFile(join(cwd, 'secret.key'), 'excluded credential fixture');
  await symlink('/etc/passwd', join(cwd, 'outside-link'));
  const dirtyStatus = await run('git', ['-C', cwd, 'status', '--porcelain=v1']);
  await cli(['env', 'set', 'POSTGRES_PASSWORD', '--env', 'review', '--from-env', 'AGENT_ENV_TEST_PASSWORD']);
  assert.deepEqual(await cli(['env', 'list', '--env', 'review']), ['POSTGRES_PASSWORD']);
  const first = await cli(['up', '--name', 'alpha', '--env', 'review', ...remoteOptions]);
  assert.equal(first.services.db.url, null);
  assert.equal(first.environment, 'review');
  const sourceFile = await readFile(join(cwd, 'compose.yaml'));
  await sql('alpha', "CREATE TABLE evidence(value text); INSERT INTO evidence VALUES ('persisted');");
  assert.equal(await exec('alpha', 'db', ['printenv', 'POSTGRES_PASSWORD']), '[redacted]');
  const runningSnapshot = await invoke(['snapshot', 'alpha', join(directory, 'running-snapshot')], false);
  assert.notEqual(runningSnapshot.code, 0);
  assert.match(runningSnapshot.stderr, /Stop the source/);
  await cli(['down', 'alpha']);
  const saved = await cli(['snapshot', 'alpha', storage, ...storageOptions]);
  assert.equal(saved.omittedMounts.length, 1);
  const duplicate = await invoke(['snapshot', 'alpha', storage, ...storageOptions], false);
  assert.notEqual(duplicate.code, 0);
  assert.match(duplicate.stderr, /exist|contains data/i);
  if (!s3) {
    const manifest = JSON.parse(await readFile(join(storage, 'manifest.json'), 'utf8'));
    const archivePath = join(storage, manifest.volumes[0].archive);
    const originalArchive = await readFile(archivePath);
    const owner = JSON.parse(await readFile(join(home, 'state.json'), 'utf8')).instances.alpha.spec.owner;
    const beforeVolumes = await docker(['volume', 'ls', '-q', '--filter', `label=agent-env.owner=${owner}`]);
    try {
      await writeFile(archivePath, Buffer.concat([originalArchive, Buffer.from('corrupt')]));
      const corrupted = await invoke(['restore', storage, '--name', 'corrupt', '--env', 'review', ...remoteOptions], false);
      assert.notEqual(corrupted.code, 0);
      assert.match(corrupted.stderr, /Checksum|size mismatch/);
      assert.equal(await docker(['volume', 'ls', '-q', '--filter', `label=agent-env.owner=${owner}`]), beforeVolumes);
      assert.ok((await cli(['list'])).every(item => item.name !== 'corrupt'));
    } finally { await writeFile(archivePath, originalArchive); }
  }
  const fork = await cli(['fork', 'alpha', 'beta', '--worktree', join(directory, 'beta')]);
  assert.equal(fork.worktree, await realpath(join(directory, 'beta')));
  assert.equal(await readFile(join(fork.worktree, 'index.html'), 'utf8'), 'dirty source copied');
  assert.deepEqual(await readFile(join(fork.worktree, 'binary.dat')), Buffer.from([0, 254, 0, 253]));
  assert.equal(await readFile(join(fork.worktree, 'src/build/source.txt'), 'utf8'), 'nested source');
  for (const file of ['.env.local', 'removed.txt', 'ignored.txt', 'secret.key', 'outside-link']) await assert.rejects(stat(join(fork.worktree, file)), { code: 'ENOENT' });
  assert.equal(await run('git', ['-C', cwd, 'status', '--porcelain=v1']), dirtyStatus);
  const dirtyRemoval = await invoke(['rm', 'beta', '--purge', '--remove-worktree'], false);
  assert.notEqual(dirtyRemoval.code, 0);
  assert.match(dirtyRemoval.stderr, /dirty|changes|untracked/i);
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
    assert.ok(!error.message.includes(env.AGENT_ENV_TEST_PASSWORD));
    return true;
  });
  await cli(['restore', storage, '--name', 'restored', '--env', 'review', ...remoteOptions, ...storageOptions]);
  assert.equal(await sql('restored', 'SELECT value FROM evidence'), 'persisted');
  assert.equal(await sql('beta', 'SELECT value FROM evidence'), 'fork-only');
  await cli(['up', '--name', 'alpha', '--env', 'review', ...remoteOptions]);
  assert.equal(await sql('alpha', 'SELECT value FROM evidence'), 'persisted');
  assert.deepEqual(await readFile(join(cwd, 'compose.yaml')), sourceFile);
  const overwrite = await invoke(['restore', storage, '--name', 'restored', '--env', 'review', ...remoteOptions, ...storageOptions], false);
  assert.notEqual(overwrite.code, 0);
  assert.match(overwrite.stderr, /new instance name/);
  assert.equal(await sql('restored', 'SELECT value FROM evidence'), 'persisted');
  const state = JSON.parse(await readFile(join(home, 'state.json')));
  for (const handle of Object.values(state.instances)) images.add(`agent-env-${handle.spec.owner}-${handle.spec.name}-web:agent-env`);
  console.log(`PASS: ${remote ? 'SSH' : 'local'} Compose CLI, smart init, environments, secret redaction, ${storage.startsWith('s3:') ? 'S3' : 'local'} snapshots, restore, and Git/data fork isolation.`);
} finally {
  const state = await readFile(join(home, 'state.json'), 'utf8').then(JSON.parse).catch(() => ({ instances: {} }));
  for (const handle of Object.values(state.instances)) images.add(`agent-env-${handle.spec.owner}-${handle.spec.name}-web:agent-env`);
  try { await cli(['rm', '--all', '--purge', '--remove-worktree', '--discard-worktree']); }
  finally { await cli(['daemon', 'stop']); }
  for (const image of images) await docker(['image', 'rm', image]).catch(() => {});
  if (s3) await run('aws', [...storageOptions.map(value => value === '--endpoint' ? '--endpoint-url' : value), 's3', 'rm', storage, '--recursive']);
  await rm(directory, { recursive: true, force: true });
}
