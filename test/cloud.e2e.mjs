import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { run, freePort, delay } from '../src/system.mjs';
import { createCloudManager } from '../src/cloud.mjs';
import { removeOwnedWorktree } from '../src/worktrees.mjs';

if (process.env.DEV_NOW_TEST_CLOUD !== '1') throw new Error('Set DEV_NOW_TEST_CLOUD=1 to authorize one temporary billed Hetzner machine.');
const directory = await mkdtemp('/tmp/dev-now-cloud-review-');
const cwd = join(directory, 'checkout'), home = join(directory, 'state');
const cliPath = resolve(import.meta.dirname, '../bin/dev-now.mjs');
const env = { ...process.env, DEV_NOW_HOME: home };
const cli = async args => JSON.parse(await run(process.execPath, [cliPath, '--json', ...args], { cwd, env }));
const state = async () => JSON.parse(await readFile(join(home, 'state.json'), 'utf8'));
const port = await freePort();
let cloud, worktree, complete = false;
async function until(check, milliseconds = 120000) {
  const deadline = Date.now() + milliseconds;
  do { if (await check()) return; await delay(1000); } while (Date.now() < deadline);
  throw new Error('The cloud test condition did not complete before its deadline.');
}
async function absentResources() {
  if (!cloud) return;
  for (const kind of ['server', 'primary-ip', 'ssh-key']) {
    const resources = JSON.parse(await run('hcloud', [kind, 'list', '--output', 'json']));
    assert.ok(resources.every(resource => resource.labels?.['dev-now.record'] !== cloud.recordId), `${kind} still exists`);
  }
}
try {
  await run('git', ['init', '-q', cwd]);
  await mkdir(join(cwd, 'src/build'), { recursive: true });
  await writeFile(join(cwd, 'src/build/source.txt'), 'nested source');
  await writeFile(join(cwd, 'index.html'), 'cloud review');
  await writeFile(join(cwd, 'dev-now.json'), JSON.stringify({ services: { web: { image: 'busybox:1.37', port, containerPort: 3000,
    command: 'httpd -f -p 3000 -h /workspace', volumes: { data: '/data' } } } }));
  await run('git', ['-C', cwd, 'add', '.']);
  await run('git', ['-C', cwd, '-c', 'user.name=dev-now E2E', '-c', 'user.email=test@localhost', 'commit', '-qm', 'Cloud fixture']);
  const cloudArgs = ['--cloud', 'hetzner', '--location', process.env.DEV_NOW_TEST_CLOUD_LOCATION ?? 'hel1', '--idle-minutes', '0'];
  await cli(['up', '--name', 'alpha', ...cloudArgs]);
  cloud = (await state()).instances.alpha.spec.cloud;
  console.log('Cloud provisioned. Checking credential binding, synchronization, and forks.');
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/src/build/source.txt`)).text(), 'nested source');
  await writeFile(join(cwd, 'src/build/source.txt'), 'synchronized nested source');
  await until(async () => await (await fetch(`http://127.0.0.1:${port}/src/build/source.txt`)).text() === 'synchronized nested source');
  let apiCalls = 0;
  const wrongCredential = createCloudManager({ home, run: (binary, args, options) => {
    if (binary === 'hcloud' && args[0] !== 'config') apiCalls++;
    return run(binary, args, { ...options, env: { ...process.env, ...options?.env, HCLOUD_TOKEN: 'dev-now-intentionally-invalid-test-token' } });
  } });
  await assert.rejects(wrongCredential.destroyCloud(cloud), /differs from this cloud record/);
  assert.equal(apiCalls, 0);
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
  complete = true;
  console.log('PASS: real Hetzner credential binding, nested source sync, retained fork recreation, and expiry of sleeping peers.');
} finally {
  try {
    await cli(['rm', '--all', '--purge']);
    const records = await readdir(join(home, 'cloud'), { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    for (const entry of records) {
      if (!entry.isDirectory()) continue;
      const record = JSON.parse(await readFile(join(home, 'cloud', entry.name, 'record.json'), 'utf8'));
      await createCloudManager({ home }).destroyCloud(record);
    }
    await absentResources();
    await cli(['daemon', 'stop']);
    if (worktree) await removeOwnedWorktree(worktree, { dirty: 'discard' });
    await rm(directory, { recursive: true, force: true });
  } catch (error) {
    console.error(`Cloud cleanup needs attention. Recovery files remain at ${directory}.`);
    if (complete) throw error;
  }
}
