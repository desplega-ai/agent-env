import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { freePort, createCli, sshOptions } from './helpers.mjs';
const cwd = await mkdtemp(join(tmpdir(), 'agent-env-goodies-live-'));
const { cli } = createCli(cwd, join(cwd, '.agent-env'));

try {
  if (process.env.AGENT_ENV_TEST_COMPOSE_GOODIES) await writeFile(join(cwd, 'compose.yaml'), 'services:\n  worker:\n    image: busybox:1.37\n    command: [sleep, "3600"]\n');
  await cli(['add', 'postgres', '--port', String(await freePort())]);
  await cli(['add', 'redis', '--port', String(await freePort())]);
  await cli(['up', '--name', 'goodies', ...sshOptions()]);
  assert.equal((await cli(['exec', 'goodies', '--service', 'postgres', '--', 'psql', '-U', 'postgres', '-d', 'app', '-Atc', 'select 1'])).output, '1');
  await cli(['exec', 'goodies', '--service', 'redis', '--', 'redis-cli', 'SET', 'evidence', 'durable']);
  assert.match((await cli(['exec', 'goodies', '--service', 'redis', '--', 'redis-cli', 'CONFIG', 'GET', 'dir'])).output, /(?:^|\n)\/data$/);
  await assert.rejects(stat(join(cwd, 'appendonlydir')), { code: 'ENOENT' });
  await cli(['down', 'goodies']);
  await cli(['up', '--name', 'goodies', ...sshOptions()]);
  assert.equal((await cli(['exec', 'goodies', '--service', 'redis', '--', 'redis-cli', 'GET', 'evidence'])).output, 'durable');
  await cli(['rm', 'goodies']);
  await cli(['up', '--name', 'goodies', ...sshOptions()]);
  assert.equal((await cli(['exec', 'goodies', '--service', 'redis', '--', 'redis-cli', 'GET', 'evidence'])).output, 'durable');
  console.log('PASS: generated Postgres credentials, Redis, and persistent service templates.');
} finally {
  await cli(['rm', '--all', '--purge']);
  await cli(['daemon', 'stop']);
  await rm(cwd, { recursive: true, force: true });
}
