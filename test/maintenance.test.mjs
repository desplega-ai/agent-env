import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudCanSleep, maintainInstances } from '../src/maintenance.mjs';

function fixture() {
  let clock = 10000, failure = false;
  const instances = {}, actions = [], reconnections = [], sleeps = [];
  const retries = new Map(), errors = new Map();
  const add = (name, cloud, extra = {}) => instances[name] = { spec: { name, host: 'ssh-host', cloud }, running: true, lastActivity: 0, ...extra };
  const options = {
    instances, retries, errors, now: () => clock, connected: handle => !!handle.connected,
    action: async message => {
      actions.push(message);
      const handle = instances[message.name];
      if (message.type === 'down') {
        handle.running = false;
        if (cloudCanSleep(handle, instances)) sleeps.push(handle.spec.cloud.recordId);
      } else delete instances[message.name];
    },
    reconnect: async handle => { reconnections.push(handle.spec.name); if (failure) throw new Error('private-failure'); handle.connected = true; },
  };
  return { instances, add, actions, reconnections, sleeps, retries, errors, tick: () => maintainInstances(options), clock: value => { clock = value; }, fail: value => { failure = value; } };
}

test('idle shutdown waits for all peers and sleeps only after the final running peer', async () => {
  const f = fixture();
  const cloud = { recordId: 'shared', idleTimeoutMs: 5000 };
  const alpha = f.add('alpha', cloud);
  const beta = f.add('beta', cloud, { lastActivity: 9000 });
  f.add('other', { recordId: 'other', idleTimeoutMs: 0 });
  assert.equal(cloudCanSleep(alpha, f.instances), false);
  await f.tick();
  assert.deepEqual(f.actions, []);
  f.clock(14000);
  await f.tick();
  assert.deepEqual(f.actions, [{ type: 'down', name: 'alpha' }, { type: 'down', name: 'beta' }]);
  assert.deepEqual(f.sleeps, ['shared']);
  assert.equal(alpha.running, false);
  assert.equal(beta.running, false);
});

test('expiry purges running and sleeping peers before idle or reconnect work', async () => {
  const f = fixture();
  const cloud = { recordId: 'shared', idleTimeoutMs: 1, expiresAt: new Date(10000).toISOString() };
  f.add('alpha', cloud);
  f.add('beta', cloud, { running: false, sleeping: true });
  await f.tick();
  assert.deepEqual(f.actions, [{ type: 'rm', name: 'alpha', purge: true }, { type: 'rm', name: 'beta', purge: true }]);
  assert.deepEqual(f.instances, {});
  assert.deepEqual(f.reconnections, []);
});

test('idle zero disables shutdown and stopped instances never reconnect', async () => {
  const f = fixture();
  f.add('cloud', { recordId: 'cloud', idleTimeoutMs: 0 });
  f.add('stopped', undefined, { running: false });
  f.add('local', undefined, { spec: { name: 'local' } });
  await f.tick();
  assert.deepEqual(f.actions, []);
  assert.deepEqual(f.reconnections, ['cloud']);
});

test('reconnect uses bounded backoff and clears errors after recovery', async () => {
  const f = fixture();
  const handle = f.add('ssh');
  handle.spec.sensitiveValues = ['private-failure'];
  f.fail(true);
  await f.tick();
  assert.deepEqual(f.retries.get('ssh'), { count: 1, next: 12000 });
  assert.equal(f.errors.get('ssh'), 'Reconnecting: [redacted]');
  await f.tick();
  assert.equal(f.reconnections.length, 1);
  let last = 10000;
  for (let count = 2; count <= 8; count++) {
    last = f.retries.get('ssh').next;
    f.clock(last);
    await f.tick();
    assert.equal(f.retries.get('ssh').next - last, Math.min(60000, 1000 * 2 ** count));
  }
  f.clock(f.retries.get('ssh').next);
  f.fail(false);
  await f.tick();
  assert.equal(f.retries.size, 0);
  assert.equal(f.errors.size, 0);
  assert.equal(handle.connected, true);
});

test('one failed expiry does not prevent another instance from reconnecting', async () => {
  const instances = {
    expired: { spec: { name: 'expired', cloud: { expiresAt: new Date(1).toISOString() }, sensitiveValues: ['hidden'] } },
    ssh: { spec: { name: 'ssh', host: 'host' }, running: true },
  };
  const errors = new Map(), names = [];
  await maintainInstances({ instances, errors, retries: new Map(), now: () => 100, connected: () => false,
    action: async () => { throw new Error('hidden'); }, reconnect: async handle => names.push(handle.spec.name) });
  assert.equal(errors.get('expired'), '[redacted]');
  assert.deepEqual(names, ['ssh']);
});
