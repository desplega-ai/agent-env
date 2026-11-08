import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCloudManager, cloudOptions, cloudInit } from '../src/cloud.mjs';
import { run as realRun } from '../src/system.mjs';

const spec = (cloud = {}) => ({ owner: 'test-owner', name: 'demo', cwd: '/checkout', provider: 'docker', services: {}, cloud: { provider: 'hetzner', ...cloud } });
async function setup(t, settings = {}) {
  const home = await mkdtemp(join(tmpdir(), 'dev-now-cloud-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const resources = { server: [], 'primary-ip': [], 'ssh-key': [] };
  const calls = [];
  let nextId = 100, failure, clock = 0, sshFailures = 0;
  const runner = async (binary, args) => {
    calls.push({ binary, args });
    if (binary === 'ssh-keygen') return realRun(binary, args);
    if (binary === 'ssh') {
      if (sshFailures-- > 0) throw new Error('PRIVATE SECRET MUST NOT ESCAPE');
      return '';
    }
    assert.equal(binary, 'hcloud');
    const [kind, action] = args;
    const value = flag => args[args.indexOf(flag) + 1];
    const list = resources[kind];
    assert.ok(list, kind);
    if (failure?.kind === kind && failure.action === action && !failure.after) {
      failure = null;
      throw new Error('PRIVATE SECRET MUST NOT ESCAPE');
    }
    let result;
    if (action === 'list') result = list;
    else if (action === 'create') {
      const labels = Object.fromEntries(args.flatMap((item, i) => item === '--label' ? [args[i + 1].split('=')] : []));
      const resource = { id: ++nextId, name: value('--name'), labels };
      if (kind === 'ssh-key') resource.public_key = (await readFile(value('--public-key-from-file'), 'utf8')).trim();
      if (kind === 'primary-ip') { resource.ip = '203.0.113.8'; resource.assignee_id = null; }
      if (kind === 'server') {
        const ipId = Number(value('--primary-ipv4'));
        const ip = resources['primary-ip'].find(item => item.id === ipId);
        assert.ok(ip);
        ip.assignee_id = resource.id;
        resource.status = 'running';
        resource.public_net = { ipv4: { id: ipId, ip: ip.ip } };
        const data = await readFile(value('--user-data-from-file'), 'utf8');
        assert.match(data, /^#cloud-config/);
        assert.match(data, /docker-compose-plugin/);
        assert.match(data, /rsync/);
        assert.match(data, /ed25519_private/);
      }
      list.push(resource);
      result = { [kind.replaceAll('-', '_')]: resource };
    } else if (action === 'delete') {
      const id = Number(args[2]);
      const index = list.findIndex(item => item.id === id);
      assert.ok(index >= 0);
      list.splice(index, 1);
      if (kind === 'server') for (const ip of resources['primary-ip']) if (ip.assignee_id === id) ip.assignee_id = null;
      result = '';
    } else if (['poweron', 'shutdown'].includes(action)) {
      const resource = list.find(item => item.id === Number(args.at(-1)));
      assert.ok(resource);
      resource.status = action === 'poweron' ? 'running' : 'off';
      result = '';
    } else assert.fail(`Unexpected command: ${kind} ${action}`);
    if (failure?.kind === kind && failure.action === action && failure.after) {
      failure = null;
      throw new Error('PRIVATE SECRET MUST NOT ESCAPE');
    }
    return args.includes('--output') ? JSON.stringify(result) : result;
  };
  const options = { home, run: runner, now: () => clock, delay: async ms => { clock += ms; }, readinessTimeoutMs: 2000, ...settings };
  return {
    home, resources, calls, manager: createCloudManager(options), restart: () => createCloudManager(options),
    fail(kind, action, after = false) { failure = { kind, action, after }; },
    failSSH(count) { sshFailures = count; },
    async record() {
      const name = (await readdir(join(home, 'cloud'))).find(item => !item.endsWith('.lock'));
      return { directory: join(home, 'cloud', name), data: JSON.parse(await readFile(join(home, 'cloud', name, 'record.json'), 'utf8')) };
    },
  };
}

test('create, restart, commit, sleep, resume, and purge retain stable owned IDs', async t => {
  const f = await setup(t);
  const first = await f.manager.prepareCloud(spec({ type: 'cpx22', location: 'nbg1', image: 'debian-12', idleTimeoutMs: 5000, expiresAt: '2030-01-01T00:00:00Z' }));
  assert.equal(first.cloud.createdForStart, true);
  assert.equal(first.cloud.type, 'cpx22');
  assert.equal(first.cloud.idleTimeoutMs, 5000);
  const second = await f.restart().prepareCloud(spec());
  assert.deepEqual(second.cloud, first.cloud);
  assert.equal(f.calls.filter(call => call.args[1] === 'create').length, 3);
  await f.manager.commitCloud({ spec: first });
  assert.deepEqual(await f.manager.disposeFailedCloud(first), { destroyed: false, reason: 'committed' });
  await f.manager.sleepCloud(first);
  assert.equal((await f.manager.cloudStatus(first.cloud)).status, 'off');
  assert.equal(f.resources.server.length, 1);
  assert.equal(f.resources['primary-ip'].length, 1);
  const resumed = await f.restart().prepareCloud(spec(), { spec: first });
  assert.equal(resumed.cloud.serverId, first.cloud.serverId);
  assert.equal(resumed.cloud.createdForStart, false);
  assert.ok(f.calls.some(call => call.args[1] === 'poweron'));
  assert.ok(!f.calls.some(call => call.args.includes('poweroff')));
  await f.manager.destroyCloud(resumed);
  assert.deepEqual(Object.values(f.resources).map(items => items.length), [0, 0, 0]);
  assert.deepEqual(await readdir(join(f.home, 'cloud')), []);
});

test('SSH uses pinned host identity, isolated credentials, and private files', async t => {
  const f = await setup(t);
  f.failSSH(1);
  const result = await f.manager.prepareCloud(spec());
  const { directory } = await f.record();
  for (const path of ['record.json', 'identity', 'host-key', 'ssh_config', 'known_hosts']) {
    assert.equal((await stat(join(directory, path))).mode & 0o777, 0o600, path);
  }
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  const config = await readFile(result.sshConfig, 'utf8');
  assert.match(config, /StrictHostKeyChecking yes/);
  assert.match(config, /IdentityAgent none/);
  assert.match(config, /GlobalKnownHostsFile \/dev\/null/);
  assert.match(config, /HostKeyAlias dev-now-/);
  const effective = await realRun('ssh', ['-G', '-F', result.sshConfig, result.host]);
  assert.match(effective, /stricthostkeychecking true/);
  assert.match(effective, /hostname 203\.0\.113\.8/);
  const hostPublic = (await readFile(join(directory, 'host-key.pub'), 'utf8')).trim().split(/\s+/).slice(0, 2).join(' ');
  assert.equal(await readFile(join(directory, 'known_hosts'), 'utf8'), `${result.host} ${hostPublic}\n`);
  assert.ok(f.calls.filter(call => call.binary === 'ssh').every(call => call.args.includes(result.sshConfig) && call.args.includes('--')));
  await assert.rejects(readFile(join(directory, 'cloud-init.yaml')), { code: 'ENOENT' });
  assert.doesNotMatch(JSON.stringify(result.cloud), /PRIVATE KEY|privateKey/);
});

test('resume recovers transient power-on failures and lost responses without replacement', async t => {
  for (const after of [false, true]) {
    const f = await setup(t);
    const first = await f.manager.prepareCloud(spec());
    await f.manager.commitCloud(first);
    await f.manager.sleepCloud(first);
    f.fail('server', 'poweron', after);
    const resumed = await f.manager.prepareCloud(spec(), first);
    assert.equal(resumed.cloud.serverId, first.cloud.serverId);
    assert.equal(f.resources.server.length, 1);
    assert.equal(f.calls.filter(call => call.args[1] === 'poweron').length, after ? 1 : 2);
    await f.manager.destroyCloud(resumed);
  }
});

test('lost server creation response reconciles without a second VPS', async t => {
  const f = await setup(t);
  f.fail('server', 'create', true);
  let failure;
  try { await f.manager.prepareCloud(spec()); } catch (error) { failure = error; }
  assert.ok(failure.cloud.recordId);
  assert.doesNotMatch(failure.message, /PRIVATE SECRET/);
  assert.equal(f.resources.server.length, 1);
  const recovered = await f.restart().prepareCloud(spec(), failure.cloud);
  assert.equal(recovered.cloud.serverId, f.resources.server[0].id);
  assert.equal(f.calls.filter(call => call.args[0] === 'server' && call.args[1] === 'create').length, 1);
  await f.manager.disposeFailedCloud(recovered);
  assert.deepEqual(Object.values(f.resources).map(items => items.length), [0, 0, 0]);
});

test('lost key or IP response remains recoverable after restart', async t => {
  for (const kind of ['ssh-key', 'primary-ip']) {
    const f = await setup(t);
    f.fail(kind, 'create', true);
    await assert.rejects(f.manager.prepareCloud(spec()), /failed/);
    const recovered = await f.restart().prepareCloud(spec());
    assert.equal(f.resources[kind].length, 1);
    await f.manager.disposeFailedCloud(recovered);
  }
});

test('uncertain creation without a visible resource refuses replacement and supports disposal', async t => {
  const f = await setup(t);
  f.fail('server', 'create');
  let failure;
  try { await f.manager.prepareCloud(spec()); } catch (error) { failure = error; }
  await assert.rejects(f.restart().prepareCloud(spec()), /uncertain result/);
  await f.manager.disposeFailedCloud(failure.cloud);
  assert.deepEqual(Object.values(f.resources).map(items => items.length), [0, 0, 0]);
  await f.restart().prepareCloud(spec());
  assert.equal(f.resources.server.length, 1);
});

test('readiness failure exposes a safe cleanup handle and retains records', async t => {
  const f = await setup(t);
  f.failSSH(100);
  let failure;
  try { await f.manager.prepareCloud(spec()); } catch (error) { failure = error; }
  assert.match(failure.message, /SSH readiness/);
  assert.ok(failure.cloud.serverId);
  assert.equal((await f.record()).data.serverId, failure.cloud.serverId);
  await f.manager.disposeFailedCloud(failure.cloud);
  assert.equal(f.resources.server.length, 0);
});

test('purge rejects changed labels or names before deleting any resources', async t => {
  for (const kind of ['server', 'primary-ip', 'ssh-key']) {
    const f = await setup(t);
    const result = await f.manager.prepareCloud(spec());
    f.resources[kind][0].labels['dev-now.owner'] = 'someone-else';
    await assert.rejects(f.manager.destroyCloud(result), /ownership check/);
    await assert.rejects(f.manager.disposeFailedCloud(result), /ownership check/);
    assert.equal(f.calls.filter(call => call.args[1] === 'delete').length, 0);
    assert.deepEqual(Object.values(f.resources).map(items => items.length), [1, 1, 1]);
  }
});

test('stored IDs, handle IDs, foreign IP assignments, and missing records prevent unsafe deletion', async t => {
  const f = await setup(t);
  const result = await f.manager.prepareCloud(spec());
  await assert.rejects(f.manager.destroyCloud({ ...result.cloud, serverId: 999 }), /does not match/);
  await assert.rejects(f.manager.destroyCloud({ ...result.cloud, recordId: 'f'.repeat(32) }), /matching cloud ownership/);
  f.resources['primary-ip'][0].assignee_id = 999;
  await assert.rejects(f.manager.destroyCloud(result), /different server/);
  f.resources['primary-ip'][0].assignee_id = result.cloud.serverId;
  const { directory, data } = await f.record();
  data.serverId = 999;
  await writeFile(join(directory, 'record.json'), JSON.stringify(data));
  await assert.rejects(f.manager.destroyCloud({ ...result.cloud, serverId: null }), /ID conflicts/);
  assert.equal(f.calls.filter(call => call.args[1] === 'delete').length, 0);
});

test('cleanup retries after partial deletion and lost deletion responses without losing unrelated resources', async t => {
  for (const after of [false, true]) {
    const f = await setup(t);
    const result = await f.manager.prepareCloud(spec());
    f.resources.server.push({ id: 900, name: 'unrelated', labels: {} });
    f.resources['primary-ip'].push({ id: 901, name: 'unrelated-ip', labels: {} });
    f.resources['ssh-key'].push({ id: 902, name: 'unrelated-key', labels: {} });
    f.fail('primary-ip', 'delete', after);
    await assert.rejects(f.manager.destroyCloud(result), /failed/);
    const { data } = await f.record();
    assert.equal(data.destroying, true);
    assert.equal(data.serverId, undefined);
    assert.ok(data.keyId);
    await assert.rejects(f.manager.prepareCloud(spec()), /cleanup is incomplete/);
    await f.restart().destroyCloud(result);
    assert.deepEqual(Object.values(f.resources).map(items => items.map(item => item.id)), [[900], [901], [902]]);
  }
});

test('missing committed server cannot silently create another VPS', async t => {
  const f = await setup(t);
  const result = await f.manager.prepareCloud(spec());
  await f.manager.commitCloud(result);
  f.resources.server.length = 0;
  assert.equal((await f.manager.cloudStatus(result)).status, 'missing');
  await assert.rejects(f.restart().prepareCloud(spec()), /missing resource/);
  assert.equal(f.calls.filter(call => call.args[0] === 'server' && call.args[1] === 'create').length, 1);
});

test('validation prevents external commands for invalid options, foreign handles, and elapsed expiry', async t => {
  const f = await setup(t);
  await assert.rejects(f.manager.prepareCloud(spec({ type: '--help' })), /resource name/);
  await assert.rejects(f.manager.prepareCloud(spec({ idleTimeoutMs: -1 })), /idleTimeoutMs/);
  await assert.rejects(f.manager.prepareCloud(spec({ expiresAt: '1969-01-01' })), /expiry has elapsed/);
  await assert.rejects(f.manager.prepareCloud(spec(), { owner: 'test-owner', name: 'another', recordId: 'f'.repeat(32) }), /ownership record/);
  assert.equal(f.calls.length, 0);
  const result = await f.manager.prepareCloud(spec());
  await assert.rejects(f.manager.prepareCloud(spec({ image: 'ubuntu-22.04' }), result), /machine options differ/);
});

test('concurrent prepare calls do not allocate duplicate infrastructure', async t => {
  const f = await setup(t);
  const results = await Promise.allSettled([f.manager.prepareCloud(spec()), f.restart().prepareCloud(spec())]);
  assert.equal(results.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(results.filter(item => item.status === 'rejected').length, 1);
  assert.equal(f.resources.server.length, 1);
});

test('restart recovers a dead process lock and refuses malformed locks', async t => {
  const f = await setup(t);
  const prepared = await f.manager.prepareCloud(spec());
  const { directory } = await f.record();
  const lock = `${directory}.lock`;
  await writeFile(lock, '2147483647');
  const recovered = await f.restart().prepareCloud(spec());
  assert.equal(recovered.cloud.serverId, prepared.cloud.serverId);
  await writeFile(lock, '');
  await assert.rejects(f.restart().prepareCloud(spec()), /locked/);
  await rm(lock);
  await f.manager.disposeFailedCloud(prepared);
});

test('elapsed expiry still exposes cleanup metadata and can be extended without replacement', async t => {
  const f = await setup(t);
  const prepared = await f.manager.prepareCloud(spec());
  let failure;
  try { await f.restart().prepareCloud(spec({ expiresAt: '1969-01-01' })); } catch (error) { failure = error; }
  assert.match(failure.message, /expiry has elapsed/);
  assert.equal(failure.cloud.recordId, prepared.cloud.recordId);
  const extended = await f.manager.prepareCloud(spec({ expiresAt: '2030-01-01T00:00:00Z', idleTimeoutMs: 0 }));
  assert.equal(extended.cloud.serverId, prepared.cloud.serverId);
  assert.equal(extended.cloud.idleTimeoutMs, 0);
  await f.manager.disposeFailedCloud(failure.cloud);
});

test('purge refuses an untracked IPv6 address and still supports retry', async t => {
  const f = await setup(t);
  const result = await f.manager.prepareCloud(spec());
  f.resources.server[0].public_net.ipv6 = { id: 999, ip: '2001:db8::/64' };
  await assert.rejects(f.manager.destroyCloud(result), /untracked IPv6/);
  assert.equal(f.calls.filter(call => call.args[1] === 'delete').length, 0);
  delete f.resources.server[0].public_net.ipv6;
  await f.manager.destroyCloud(result);
});

test('cloud options and bootstrap specify Docker repository packages without scheduling', () => {
  assert.equal(cloudOptions('hetzner').idleTimeoutMs, 1800000);
  assert.equal(cloudOptions({ provider: 'hetzner', idleTimeoutMs: 0 }).idleTimeoutMs, 0);
  assert.throws(() => cloudOptions(), /explicitly/);
  assert.throws(() => cloudOptions({ idleTimeoutMs: 100 }), /explicitly/);
  assert.throws(() => cloudOptions('unknown'), /hetzner/);
  assert.throws(() => cloudOptions({ provider: 'hetzner', expiresAt: 'not-a-date' }), /ISO date/);
  const init = cloudInit('private\nkey', 'ssh-ed25519 public');
  assert.match(init, /download.docker.com/);
  assert.match(init, /docker-compose-plugin/);
  assert.doesNotMatch(init, /shutdown|poweroff|cron/);
});
