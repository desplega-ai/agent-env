import test from 'node:test';
import assert from 'node:assert/strict';
import { validate } from '../src/config.mjs';
import { quote, run } from '../src/system.mjs';
import { loadSpec } from '../src/config.mjs';
import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const spec = () => ({ name: 'demo', provider: 'docker', services: { web: { image: 'busybox:1.37', port: 3000 } } });
test('cloud lifecycle flags cannot change local or SSH targets into cloud machines', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'dev-now-target-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const filename = join(cwd, 'dev-now.json');
  await writeFile(filename, JSON.stringify(spec()));
  for (const flag of ['idle-minutes', 'ttl-hours', 'location', 'cloud-type']) {
    for (const target of [[], ['--ssh', 'example-host'], ['--local']]) {
      await assert.rejects(run(process.execPath, [new URL('../bin/dev-now.mjs', import.meta.url).pathname, 'up', ...target, `--${flag}`, '5'], { cwd, env: { ...process.env, DEV_NOW_HOME: join(cwd, 'state') } }), /Cloud options require/);
      await assert.rejects(stat(join(cwd, 'state')), { code: 'ENOENT' });
    }
  }
  const cloud = await loadSpec({ cwd, cloud: 'hetzner', 'idle-minutes': '5', 'ttl-hours': '1', location: 'hel1' });
  assert.equal(cloud.cloud.provider, 'hetzner');
  assert.equal(cloud.cloud.idleTimeoutMs, 300000);
  assert.equal(cloud.cloud.location, 'hel1');
  await assert.rejects(loadSpec({ cwd, cloud: 'hetzner', ssh: 'alias' }), /only one target/);
  await writeFile(filename, JSON.stringify({ ...spec(), cloud: { provider: 'hetzner' } }));
  assert.equal((await loadSpec({ cwd, 'idle-minutes': '0' })).cloud.idleTimeoutMs, 0);
  assert.equal((await loadSpec({ cwd, ssh: 'alias' })).cloud, undefined);
  await writeFile(filename, JSON.stringify({ ...spec(), cloud: { idleTimeoutMs: 100 } }));
  await assert.rejects(loadSpec({ cwd }), /explicitly/);
});
test('configuration rejects ambiguous ports and unsafe names before provisioning', () => {
  assert.throws(() => validate({ ...spec(), name: '-option' }), /name/);
  assert.throws(() => validate({ ...spec(), host: 'host; touch /tmp/unwanted' }), /SSH alias/);
  const duplicate = spec();
  duplicate.services.api = { image: 'busybox:1.37', port: 3000 };
  assert.throws(() => validate(duplicate), /more than once/);
  const volume = spec();
  volume.services.web.volumes = { data: '/path,readonly' };
  assert.throws(() => validate(volume), /Volume destinations/);
  const port = spec();
  port.services.web.containerPort = 80;
  assert.equal(validate(port).services.web.containerPort, 80);
});

test('SSH command quoting retains arguments literally', async () => {
  const value = "space ' quote $(printf unsafe) `printf unsafe`\nline";
  assert.equal(await run('sh', ['-c', `printf '%s' ${quote(value)}`]), value);
});

test('Docker configuration retains defaults and merges named environments and explicit env files', async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'dev-now-config-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await writeFile(join(cwd, '.env.review'), 'FILE_ONLY=literal\nOVERRIDE=file\n');
  await writeFile(join(cwd, 'dev-now.json'), JSON.stringify({
    name: 'configured', provider: 'docker', env: { OVERRIDE: 'global', PROCESS: { env: 'PATH' } },
    services: { web: { image: 'node:22', port: 3000, env: { OVERRIDE: 'service' } } },
    environments: { review: { envFiles: '.env.review', services: { web: { port: 4000 } } }, custom: { name: 'custom-instance' } },
  }));
  const original = await loadSpec({ cwd });
  assert.equal(original.name, 'configured');
  assert.equal(original.services.web.containerPort, 3000);
  assert.equal(original.services.web.protocol, 'http');
  const review = await loadSpec({ cwd, env: 'review' });
  assert.notEqual(review.name, original.name);
  assert.equal(review.services.web.port, 4000);
  assert.equal(review.services.web.env.OVERRIDE, 'service');
  assert.equal(review.services.web.env.FILE_ONLY, 'literal');
  assert.ok(review.services.web.env.PROCESS === process.env.PATH);
  assert.equal((await loadSpec({ cwd, env: 'custom' })).name, 'custom-instance');
  assert.equal((await loadSpec({ cwd, env: 'review', name: 'explicit' })).name, 'explicit');
  await assert.rejects(loadSpec({ cwd, profile: 'tools' }), /Compose profiles/);
});
