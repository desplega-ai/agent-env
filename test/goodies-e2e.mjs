import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { run, freePort } from '../src/system.mjs';
const cwd = await mkdtemp('/tmp/agent-env-goodies-live-');
const cli = async args => JSON.parse(await run(process.execPath, [new URL('../bin/agent-env.mjs', import.meta.url).pathname, '--json', ...args], { cwd, env: { ...process.env, AGENT_ENV_HOME: join(cwd, '.agent-env') } }));
try {
  if (process.env.AGENT_ENV_TEST_COMPOSE_GOODIES) await writeFile(join(cwd, 'compose.yaml'), 'services:\n  worker:\n    image: busybox:1.37\n    command: [sleep, "3600"]\n');
  await cli(['add', 'postgres', '--port', String(await freePort())]);
  await cli(['add', 'redis', '--port', String(await freePort())]);
  await cli(['up', '--name', 'goodies']);
  assert.equal((await cli(['exec', 'goodies', '--service', 'postgres', '--', 'psql', '-U', 'postgres', '-d', 'app', '-Atc', 'select 1'])).output, '1');
  await cli(['exec', 'goodies', '--service', 'redis', '--', 'redis-cli', 'SET', 'evidence', 'durable']);
  await cli(['down', 'goodies']);
  await cli(['up', '--name', 'goodies']);
  assert.equal((await cli(['exec', 'goodies', '--service', 'redis', '--', 'redis-cli', 'GET', 'evidence'])).output, 'durable');
  console.log('PASS: generated Postgres credentials, Redis, and persistent service templates.');
} finally {
  await cli(['rm', '--all', '--purge']);
  await cli(['daemon', 'stop']);
  await rm(cwd, { recursive: true, force: true });
}
