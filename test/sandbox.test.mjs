import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DockerProvider } from '../src/providers/docker.mjs';
import { SandboxProvider, SANDBOX_CAPABILITIES, validateSandboxAdapter } from '../src/providers/sandbox.mjs';

const spec = (sandbox = { adapter: 'docker' }) => ({
  name: 'demo', owner: 'test-owner', provider: 'sandbox', cwd: '/checkout', sandbox,
  services: { web: { image: 'busybox:1.37', port: 3000, containerPort: 3000, protocol: 'tcp', env: {}, volumes: { data: '/data' } } },
});
const capabilities = overrides => Object.fromEntries(SANDBOX_CAPABILITIES.map(name => [name, ['create', 'wait', 'connect', 'status'].includes(name)]).concat(Object.entries(overrides ?? {})));
const minimum = overrides => ({
  capabilities: capabilities(),
  async create(value) { return { spec: value, services: value.services }; },
  async wait() {}, async connect() { return []; }, async status() { return {}; }, ...overrides,
});

test('local ESM adapter implements create, restart, wait, status, connect, and dispose', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-env-sandbox-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(directory, 'adapter.mjs'), `
export async function createAdapter(options) {
  return {
    capabilities: ${JSON.stringify(capabilities({ start: true, stop: true, remove: true, exec: true, logs: true, sync: true }))},
    async create(spec) { return { spec, services: structuredClone(spec.services), state: 'running', value: options.value }; },
    async start(handle) { handle.state = 'running'; handle.services.web.hostPort = 4567; },
    async stop(handle) { handle.state = 'stopped'; },
    async remove(handle, purge) { handle.state = purge ? 'purged' : 'removed'; },
    async wait(handle) { handle.services.web.hostPort = 4567; },
    async connect() { return [{ name: 'web', backendPort: 4567, close() {} }]; },
    async status(handle) { return { web: handle.state }; },
    async exec(handle, service, argv) { return argv; },
    async logs() { return 'test logs'; },
    async sync(handle) { handle.synced = true; },
    async dispose() {},
  };
}
`);
  const value = { ...spec({ adapter: './adapter.mjs', options: { value: 42 } }), cwd: directory };
  const provider = new SandboxProvider();
  const handle = await provider.create(value);
  assert.equal(handle.runtime.value, 42);
  assert.deepEqual(await provider.status(handle), { web: 'running' });
  await provider.wait(handle);
  assert.equal(handle.services.web.hostPort, 4567);
  const connections = await provider.connect(handle);
  assert.equal(connections[0].backendPort, 4567);
  connections[0].close();
  await provider.stop(handle);
  assert.deepEqual(await provider.status(handle), { web: 'stopped' });
  await provider.dispose();
  const restarted = new SandboxProvider();
  const persisted = JSON.parse(JSON.stringify(handle));
  await restarted.start(persisted);
  assert.deepEqual(await restarted.status(persisted), { web: 'running' });
  await restarted.sync(persisted);
  assert.equal(persisted.runtime.synced, true);
  const argv = ['printf', '$(touch /tmp/never)', 'space and quote'];
  assert.deepEqual(await restarted.exec(persisted, 'web', argv), argv);
  assert.equal(await restarted.logs(persisted, 'web'), 'test logs');
  await restarted.remove(persisted, false);
  assert.equal(persisted.runtime.state, 'removed');
  await restarted.remove(persisted, true);
  assert.equal(persisted.runtime.state, 'purged');
  await restarted.dispose();
});

test('capabilities require explicit booleans and matching methods', () => {
  assert.throws(() => validateSandboxAdapter({}), /explicit capabilities/);
  assert.throws(() => validateSandboxAdapter({ capabilities: { create: true } }), /no create method/);
  const partial = minimum();
  delete partial.capabilities.fork;
  assert.throws(() => validateSandboxAdapter(partial), /declare capability fork/);
  assert.throws(() => validateSandboxAdapter(minimum({ capabilities: capabilities({ exec: true }) })), /no exec method/);
  assert.throws(() => validateSandboxAdapter(minimum({ capabilities: capabilities({ connect: false }) })), /requires capability connect/);
  assert.throws(() => validateSandboxAdapter(minimum({ capabilities: capabilities({ compose: 'yes' }) })), /as a boolean/);
});

test('unsupported operations and required capabilities fail before execution', async () => {
  let calls = 0;
  const adapter = minimum({ async create(value) { calls++; return { spec: value, services: value.services }; } });
  const provider = new SandboxProvider({ load: async () => ({ createAdapter: () => adapter }) });
  const value = spec({ adapter: '/local/adapter.mjs' });
  const handle = await provider.create(value);
  await assert.rejects(provider.stop(handle), /does not support stop/);
  await assert.rejects(provider.exec(handle, 'web', []), /does not support exec/);
  await assert.rejects(provider.fork(handle, { ...value, name: 'other' }), /does not support fork/);
  await assert.rejects(provider.create({ ...value, compose: { file: 'compose.yaml' } }), /does not support compose/);
  await assert.rejects(provider.create(spec({ adapter: '/local/adapter.mjs', requireCapabilities: ['snapshots'] })), /Unknown sandbox capability snapshots/);
  await assert.rejects(provider.create(spec({ adapter: '/local/adapter.mjs', requireCapabilities: ['firecracker'] })), /Unknown sandbox capability/);
  assert.equal(calls, 1);
  await provider.dispose();
});

test('adapter imports accept local files and reject remote or ambiguous locations', async () => {
  const locations = [];
  const provider = new SandboxProvider({ load: async location => { locations.push(location); return { createAdapter: () => minimum() }; } });
  await provider.create(spec({ adapter: './adapter.mjs' }));
  assert.equal(locations[0], 'file:///checkout/adapter.mjs');
  for (const adapter of [undefined, 'https://example.com/adapter.mjs', 'data:text/javascript,throw 1', 'file://remote/path.mjs', 'file:///path.mjs?query']) {
    await assert.rejects(provider.create(spec({ adapter })), /local|Set sandbox.adapter/);
  }
  await assert.rejects(provider.create({ ...spec({ adapter: './adapter.mjs' }), cwd: '.' }), /absolute spec.cwd/);
  await assert.rejects(new SandboxProvider({ load: async () => ({}) }).create(spec({ adapter: '/adapter.mjs' })), /export createAdapter/);
  assert.equal(locations.length, 1);
  await provider.dispose();
});

test('invalid serializable handles trigger cleanup and adapter mismatch prevents execution', async () => {
  let removed = 0;
  const adapter = minimum({
    capabilities: capabilities({ remove: true }),
    async create(value) { return { spec: value, services: value.services, forbidden() {} }; },
    async remove(handle, purge) { assert.equal(purge, true); removed++; },
  });
  const provider = new SandboxProvider({ load: async () => ({ createAdapter: () => adapter }) });
  await assert.rejects(provider.create(spec({ adapter: '/adapter.mjs' })), /only JSON values/);
  assert.equal(removed, 1);
  adapter.create = async value => ({ spec: value, services: value.services });
  const handle = await provider.create(spec({ adapter: '/adapter.mjs' }));
  handle.sandbox.adapter = 'docker';
  await assert.rejects(provider.status(handle), /does not match/);
  await provider.dispose();
});

// Exercise the actual DockerProvider methods with a stateful CLI runner.
// The TCP readiness check uses a real loopback listener.
test('Docker bridge retains volumes on stop and remove, resumes, forks, and purges owned volumes', async t => {
  const server = net.createServer(socket => socket.end());
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const port = server.address().port;
  const docker = new DockerProvider();
  const containers = new Map(), networks = new Set(), volumes = new Map(), calls = [];
  docker.docker = async (value, args) => {
    calls.push(args);
    const [command, action] = args;
    if (command === 'info') return 'test-engine';
    if (command === 'network') {
      if (action === 'create') networks.add(args.at(-1));
      else if (action === 'ls') return networks.has(args.at(-1).replace(/^name=\^|\$$/g, '')) ? 'network-id' : '';
      else if (action === 'rm') networks.delete(args.at(-1));
      return '';
    }
    if (command === 'volume') {
      if (action === 'create') { if (!volumes.has(args.at(-1))) volumes.set(args.at(-1), 'persistent-data'); return args.at(-1); }
      if (action === 'ls') return volumes.has(args.at(-1).replace(/^name=\^|\$$/g, '')) ? 'volume-id' : '';
      if (action === 'rm') { volumes.delete(args.at(-1)); return ''; }
    }
    if (command === 'container' && action === 'ls') return containers.has(args.at(-1).replace(/^name=\^\/|\$$/g, '')) ? 'container-id' : '';
    if (command === 'run') {
      if (args.includes('--rm')) {
        const mounts = args.filter((_, index) => args[index - 1] === '--mount');
        const [source, destination] = mounts.map(mount => mount.match(/src=([^,]+)/)[1]);
        volumes.set(destination, volumes.get(source));
      } else containers.set(args[args.indexOf('--name') + 1], 'running');
      return 'container-id';
    }
    if (command === 'inspect') {
      const state = containers.get(args.at(-1));
      if (args.includes('--format')) return state;
      return JSON.stringify([{ State: { Running: state === 'running' }, NetworkSettings: { Ports: { '3000/tcp': [{ HostPort: String(port) }] } } }]);
    }
    if (command === 'start' || command === 'stop') { containers.set(args.at(-1), command === 'start' ? 'running' : 'exited'); return ''; }
    if (command === 'rm') { containers.delete(args.at(-1)); return ''; }
    if (command === 'logs') return 'container logs';
    if (command === 'exec') return JSON.stringify(args.slice(2));
    assert.fail(`Unexpected docker command: ${args.join(' ')}`);
  };
  const provider = new SandboxProvider({ dockerProvider: docker });
  t.after(() => provider.dispose());
  assert.equal((await provider.capabilities(spec())).compose, false);
  assert.equal((await provider.capabilities(spec())).snapshots, undefined);
  const handle = await provider.create(spec());
  assert.deepEqual(await provider.status(handle), { web: 'running' });
  const connection = (await provider.connect(handle))[0];
  assert.equal(connection.backendPort, port);
  connection.close();
  await provider.stop(handle);
  assert.deepEqual(await provider.status(handle), { web: 'exited' });
  assert.equal(volumes.size, 1);
  await provider.start(handle);
  assert.deepEqual(await provider.status(handle), { web: 'running' });
  assert.equal(await provider.logs(handle, 'web'), 'container logs');
  const argv = ['printf', '$(touch /tmp/never)', 'a b'];
  assert.deepEqual(JSON.parse(await provider.exec(handle, 'web', argv)), argv);
  await provider.stop(handle);
  const fork = await provider.fork(handle, { ...spec(), name: 'fork' });
  assert.equal(volumes.size, 2);
  assert.deepEqual([...volumes.values()], ['persistent-data', 'persistent-data']);
  await assert.rejects(provider.fork(handle, { ...spec(), name: 'fork' }), /already exists/);
  await provider.remove(fork, true);
  await provider.remove(handle, false);
  assert.equal(containers.size, 0);
  assert.equal(networks.size, 0);
  assert.equal(volumes.size, 1);
  await provider.remove(handle, true);
  assert.equal(volumes.size, 0);
  assert.ok(calls.some(args => args[0] === 'run' && args.includes('--rm')));
});
