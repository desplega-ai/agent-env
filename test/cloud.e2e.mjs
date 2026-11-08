import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { run, freePort, delay, createCli } from './helpers.mjs';

if (process.env.AGENT_ENV_TEST_CLOUD !== '1') throw new Error('Set AGENT_ENV_TEST_CLOUD=1 to authorize one temporary billed Hetzner machine.');
const directory = await mkdtemp(join(tmpdir(), 'agent-env-cloud-review-'));
const cwd = join(directory, 'checkout'), home = join(directory, 'state');
const { cli, invoke } = createCli(cwd, home);
const state = async () => JSON.parse(await readFile(join(home, 'state.json'), 'utf8'));
const port = await freePort();
let cloud, worktree;
async function until(check, milliseconds = 120000) {
  const deadline = Date.now() + milliseconds;
  do { if (await check()) return; await delay(1000); } while (Date.now() < deadline);
  throw new Error('The cloud test condition did not complete before its deadline.');
}
async function absentResources() {
  if (!cloud) return;
  for (const kind of ['server', 'primary-ip', 'ssh-key']) {
    const resources = JSON.parse(await run('hcloud', [kind, 'list', '--output', 'json']));
    assert.ok(resources.every(resource => resource.labels?.['agent-env.record'] !== cloud.recordId), `${kind} still exists`);
  }
}
try {
  await run('git', ['init', '-q', cwd]);
  await mkdir(join(cwd, 'src/build'), { recursive: true });
  await writeFile(join(cwd, 'src/build/source.txt'), 'nested source');
  await writeFile(join(cwd, 'index.html'), 'cloud review');
  await writeFile(join(cwd, 'agent-env.json'), JSON.stringify({ services: { web: { image: 'busybox:1.37', port, containerPort: 3000,
    command: 'httpd -f -p 3000 -h /workspace', volumes: { data: '/data' } } } }));
  await run('git', ['-C', cwd, 'add', '.']);
  await run('git', ['-C', cwd, '-c', 'user.name=agent-env E2E', '-c', 'user.email=test@localhost', 'commit', '-qm', 'Cloud fixture']);
  const cloudArgs = ['--cloud', 'hetzner', '--location', process.env.AGENT_ENV_TEST_CLOUD_LOCATION ?? 'hel1', '--idle-minutes', '0'];
  await cli(['up', '--name', 'alpha', ...cloudArgs]);
  cloud = (await state()).instances.alpha.spec.cloud;
  console.log('Cloud provisioned. Checking credential binding, synchronization, and forks.');
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/src/build/source.txt`)).text(), 'nested source');
  await writeFile(join(cwd, 'src/build/source.txt'), 'synchronized nested source');
  await until(async () => await (await fetch(`http://127.0.0.1:${port}/src/build/source.txt`)).text() === 'synchronized nested source');
  await cli(['daemon', 'stop']);
  try {
    const rejected = await invoke(['rm', 'alpha', '--purge'], false, { env: { HCLOUD_TOKEN: 'agent-env-intentionally-invalid-test-token' } });
    assert.notEqual(rejected.code, 0);
    assert.match(rejected.stderr, /differs from this cloud record/);
    const servers = JSON.parse(await run('hcloud', ['server', 'list', '--output', 'json']));
    assert.ok(servers.some(server => server.labels?.['agent-env.record'] === cloud.recordId));
  } finally {
    await cli(['daemon', 'stop']);
  }
  await cli(['exec', 'alpha', '--', 'sh', '-c', 'echo durable > /data/value']);
  await cli(['down', 'alpha']);
  await cli(['fork', 'alpha', 'beta', '--worktree', join(directory, 'beta')]);
  worktree = (await state()).instances.beta.worktree;
  await cli(['up', 'alpha']);
  await cli(['rm', 'beta']);
  await cli(['up', 'beta']);
  assert.deepEqual((await state()).instances.beta.worktree, worktree);
  assert.equal((await cli(['exec', 'beta', '--', 'cat', '/data/value'])).output, 'durable');
  console.log('Shared fork recreation retained data and worktree ownership. Checking sleeping expiry.');
  await cli(['up', '--name', 'alpha', ...cloudArgs, '--ttl-hours', '0.01']);
  await cli(['down', '--all']);
  const sleeping = Object.values((await state()).instances);
  assert.equal(sleeping.length, 2);
  assert.ok(sleeping.every(handle => handle.sleeping && !handle.running));
  await until(async () => (await cli(['list'])).length === 0);
  await absentResources();
  console.log('PASS: real Hetzner credential binding, nested source sync, retained fork recreation, and expiry of sleeping peers.');
} finally {
  try {
    await cli(['rm', '--all', '--purge', '--remove-worktree', '--discard-worktree']);
    await absentResources();
    await cli(['daemon', 'stop']);
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    console.error(`Cloud cleanup needs attention. Recovery files remain at ${directory}.`);
    throw error;
  }
}
