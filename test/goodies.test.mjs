import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from '../src/system.mjs';
import { loadSpec } from '../src/config.mjs';

test('service templates retain secret references and reject collisions', async t => {
  const cwd = await mkdtemp('/tmp/agent-env-goodies-');
  const home = join(cwd, '.agent-env');
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const cli = args => run(process.execPath, [new URL('../bin/agent-env.mjs', import.meta.url).pathname, ...args], { cwd, env: { ...process.env, AGENT_ENV_HOME: home } });
  await cli(['add', 'postgres']);
  await cli(['add', 'redis']);
  const config = JSON.parse(await readFile(join(cwd, 'agent-env.json')));
  assert.deepEqual(config.services.postgres.env.POSTGRES_PASSWORD, { secret: 'POSTGRES_PASSWORD' });
  assert.equal(config.services.redis.volumes.data, '/data');
  assert.equal(config.services.redis.port, 56379);
  assert.deepEqual(JSON.parse(await cli(['env', 'list', '--json'])), ['POSTGRES_PASSWORD']);
  await assert.rejects(cli(['add', 'postgres']), /already exists/);
  assert.deepEqual(JSON.parse(await readFile(join(cwd, 'agent-env.json'))), config);
});

for (const provider of ['docker', 'compose']) test(`${provider} service templates remain inside the selected environment`, async t => {
  const cwd = await mkdtemp('/tmp/agent-env-goodies-env-');
  const home = join(cwd, '.agent-env');
  const previous = process.env.AGENT_ENV_HOME;
  process.env.AGENT_ENV_HOME = home;
  t.after(async () => { if (previous === undefined) delete process.env.AGENT_ENV_HOME; else process.env.AGENT_ENV_HOME = previous; await rm(cwd, { recursive: true, force: true }); });
  if (provider === 'compose') {
    try { await run('docker', ['compose', 'version']); } catch { t.skip('Docker Compose is unavailable.'); return; }
    await writeFile(join(cwd, 'compose.yaml'), 'services:\n  web:\n    image: busybox:1.37\n');
  } else await writeFile(join(cwd, 'agent-env.json'), JSON.stringify({ services: { web: { image: 'busybox:1.37', port: 3000 } } }));
  const cli = args => run(process.execPath, [new URL('../bin/agent-env.mjs', import.meta.url).pathname, ...args], { cwd, env: { ...process.env, AGENT_ENV_HOME: home } });
  await cli(['add', 'postgres', '--env', 'review']);
  const base = await loadSpec({ cwd });
  const review = await loadSpec({ cwd, env: 'review' });
  assert.equal(base.services.postgres, undefined);
  assert.ok(review.services.postgres);
  assert.deepEqual(JSON.parse(await cli(['env', 'list', '--json'])), []);
  assert.deepEqual(JSON.parse(await cli(['env', 'list', '--env', 'review', '--json'])), ['POSTGRES_PASSWORD']);
  await assert.rejects(cli(['add', 'postgres', '--env', 'review']), /already exists/);
});
