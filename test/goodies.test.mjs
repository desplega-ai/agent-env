import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { run } from '../src/system.mjs';

test('service templates retain secret references and reject collisions', async t => {
  const cwd = await mkdtemp('/tmp/dev-now-goodies-');
  const home = join(cwd, '.dev-now');
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const cli = args => run(process.execPath, [new URL('../bin/dev-now.mjs', import.meta.url).pathname, ...args], { cwd, env: { ...process.env, DEV_NOW_HOME: home } });
  await cli(['add', 'postgres']);
  await cli(['add', 'redis']);
  const config = JSON.parse(await readFile(join(cwd, 'dev-now.json')));
  assert.deepEqual(config.services.postgres.env.POSTGRES_PASSWORD, { secret: 'POSTGRES_PASSWORD' });
  assert.equal(config.services.redis.volumes.data, '/data');
  assert.equal(config.services.redis.port, 56379);
  assert.deepEqual(JSON.parse(await cli(['env', 'list', '--json'])), ['POSTGRES_PASSWORD']);
  await assert.rejects(cli(['add', 'postgres']), /already exists/);
  assert.deepEqual(JSON.parse(await readFile(join(cwd, 'dev-now.json'))), config);
});
