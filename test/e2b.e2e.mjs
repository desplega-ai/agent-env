import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, stat, symlink, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createCli, freePort, until, delay } from './helpers.mjs';

if (process.env.AGENT_ENV_TEST_E2B !== '1') {
  console.log('SKIP: Set AGENT_ENV_TEST_E2B=1 to authorize a paid E2B test.');
  process.exit(0);
}
if (!process.env.E2B_API_KEY) throw new Error('The paid E2B test requires E2B_API_KEY in the calling process.');
if (!isAbsolute(process.env.AGENT_ENV_CLI ?? '')) throw new Error('Set AGENT_ENV_CLI to an absolute installed agent-env executable.');
const { Sandbox } = createRequire(await realpath(process.env.AGENT_ENV_CLI))('e2b');
const directory = await mkdtemp(join(tmpdir(), 'agent-env-e2b-test-'));
const cwd = join(directory, 'checkout'), home = join(directory, 'state');
await mkdir(cwd);
const { cli, invoke } = createCli(cwd, home);
const port = await freePort(), pythonPort = await freePort();
const name = `e2b-${Date.now().toString(36)}`;
const failedName = `${name}-failed`;
const configPath = join(cwd, 'agent-env.json'), statePath = join(home, 'state.json');
const config = { name, provider: 'e2b', startupTimeoutSeconds: 90,
  e2b: { timeoutSeconds: 600 }, env: { E2B_API_KEY: { env: 'E2B_API_KEY' } },
  commands: {
    label: 'printf "%s" "$APP_LABEL"',
    argument: 'printf "%s" "$1"',
    literal: ['node', '-e', 'process.stdout.write(process.argv[1])'],
    'python-port': { service: 'python', command: ['python3', '-c', 'import os; print(os.environ["PORT"], end="")'] },
    failure: { service: 'web', command: ['sh', '-c', 'echo run-stdout; echo run-stderr >&2; exit 31'] },
    slow: ['sh', '-c', 'touch long-running.txt; sleep 65; printf long-complete'],
  },
  services: {
    web: { command: 'node server.cjs', port, containerPort: 3000, env: { APP_LABEL: 'e2b-test', APP_TOKEN: 'dummy-e2b-private-first' } },
    python: { command: 'python3 -m http.server 3001 --bind 0.0.0.0', port: pythonPort, containerPort: 3001 },
  } };
const readState = async () => JSON.parse(await readFile(statePath, 'utf8'));
const recordFiles = async () => {
  try { return (await readdir(join(home, 'e2b'))).filter(file => file.endsWith('.json')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};
let handle;
const options = { apiKey: process.env.E2B_API_KEY, debug: false, domain: 'e2b.app', apiUrl: 'https://api.e2b.app' };
const info = () => Sandbox.getInfo(handle.e2b.sandboxId, options);
async function matchingSandboxes(instanceName) {
  const paginator = Sandbox.list({ ...options, query: { metadata: {
    'agent-env.provider': 'e2b', 'agent-env.owner': handle.spec.owner, 'agent-env.name': instanceName,
  }, state: ['running', 'paused'] } });
  const result = [];
  while (paginator.hasNext) result.push(...await paginator.nextItems());
  return result;
}
async function json(path = '/') {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(10000) });
  assert.equal(response.status, 200);
  return response.json();
}
async function pythonFile(path) {
  const response = await fetch(`http://127.0.0.1:${pythonPort}/${path}`, { signal: AbortSignal.timeout(10000) });
  return { status: response.status, body: await response.text() };
}
async function websocket() {
  await new Promise((resolveMessage, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/socket`);
    const timer = setTimeout(() => { socket.close(); reject(new Error('The E2B WebSocket test timed out.')); }, 10000);
    socket.addEventListener('open', () => socket.send('e2b-websocket'));
    socket.addEventListener('message', event => {
      clearTimeout(timer);
      socket.close();
      try { assert.equal(event.data, 'e2b-websocket'); resolveMessage(); } catch (error) { reject(error); }
    });
    socket.addEventListener('error', () => { clearTimeout(timer); socket.close(); reject(new Error('The E2B WebSocket request failed.')); });
  });
}

try {
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(join(cwd, 'source.txt'), 'initial source');
  await mkdir(join(cwd, 'src/build'), { recursive: true });
  await writeFile(join(cwd, 'src/build/nested.txt'), 'nested source');
  for (const path of ['.git', 'node_modules', 'dist', '.ssh']) await mkdir(join(cwd, path));
  for (const path of ['.git/private', 'node_modules/private', 'dist/private', '.ssh/private', '.env', '.npmrc', 'credentials.json', 'private.pem']) {
    await writeFile(join(cwd, path), path === '.env' ? 'UNRELATED_DOTENV=excluded-test-fixture\n' : 'excluded test fixture');
  }
  await writeFile(join(directory, 'outside.txt'), 'outside checkout');
  await symlink(join(directory, 'outside.txt'), join(cwd, 'outside-link'));
  await writeFile(join(cwd, 'server.cjs'), `
const http = require('node:http');
const fs = require('node:fs');
const crypto = require('node:crypto');
let counter = 0;
const server = http.createServer((req, res) => {
  if (req.url === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\\n\\n');
    const timer = setTimeout(() => res.end('data: after-idle\\n\\n'), 32000);
    res.on('close', () => clearTimeout(timer));
    return;
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ source: fs.readFileSync('source.txt', 'utf8'), pid: process.pid,
    counter: ++counter, label: process.env.APP_LABEL, providerCredentialPresent: Object.keys(process.env).some(key => key.startsWith('E2B_')) }));
});
server.on('upgrade', (req, socket, head) => {
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');
  let buffered = head;
  const receive = data => {
    buffered = Buffer.concat([buffered, data]);
    while (buffered.length >= 6) {
      const size = buffered[1] & 127;
      if (size > 125) return socket.destroy();
      if (buffered.length < 6 + size) return;
      const opcode = buffered[0] & 15, mask = buffered.subarray(2, 6), payload = Buffer.from(buffered.subarray(6, 6 + size));
      for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % 4];
      buffered = buffered.subarray(6 + size);
      socket.write(Buffer.concat([Buffer.from([opcode === 8 ? 0x88 : 0x81, payload.length]), payload]));
      if (opcode === 8) return socket.end();
    }
  };
  socket.on('data', receive);
  socket.on('error', () => {});
  receive(Buffer.alloc(0));
});
server.listen(Number(process.env.PORT), '0.0.0.0', () => {
  console.log('e2b-service-stdout');
  console.log(process.env.APP_TOKEN);
  console.error('e2b-service-stderr');
});
`);

  for (const patch of [
    { services: { web: { ...config.services.web, image: 'node:22' } } },
    { services: { web: { ...config.services.web, volumes: { data: '/data' } } } },
    { services: { web: { ...config.services.web, protocol: 'tcp' } } },
    { services: { web: { port } } },
    { host: 'unsupported-host' }, { cloud: { provider: 'hetzner' } },
    { env: { E2B_APPLICATION_VALUE: 'reserved-fixture' } },
  ]) {
    await writeFile(configPath, JSON.stringify({ ...config, ...patch, commands: {} }));
    const rejected = await invoke(['up'], false);
    assert.notEqual(rejected.code, 0, 'E2B accepted an unsupported configuration.');
    assert.ok(!`${rejected.stdout}${rejected.stderr}`.includes(process.env.E2B_API_KEY), 'The CLI exposed its provider credential.');
    assert.equal((await recordFiles()).length, 0, 'Validation allocated an E2B ownership record.');
  }
  await writeFile(configPath, JSON.stringify(config));
  const started = await cli(['up']);
  console.log('E2B services started.');
  assert.equal(started.provider, 'e2b');
  assert.equal(started.sync, 'watching');
  handle = (await readState()).instances[name];
  assert.ok(handle.e2b?.sandboxId, 'The daemon did not persist an E2B sandbox handle.');
  assert.ok(handle.spec.e2b.credentials.apiKey === process.env.E2B_API_KEY, 'The provider credential was not captured in private state.');
  assert.ok(handle.spec.sensitiveValues.includes(process.env.E2B_API_KEY), 'The provider credential lacks redaction metadata.');
  assert.ok(!Object.hasOwn(handle.spec.env, 'E2B_API_KEY'), 'The provider credential remains in the service environment.');
  assert.ok(Object.values(handle.services).every(service => !Object.hasOwn(service.env, 'E2B_API_KEY')));
  const records = await recordFiles();
  assert.equal(records.length, 1);
  const ownership = await readFile(join(home, 'e2b', records[0]), 'utf8');
  assert.deepEqual(Object.keys(JSON.parse(ownership)).sort(), ['e2b', 'workspace']);
  assert.ok(!ownership.includes(process.env.E2B_API_KEY));
  assert.ok(!ownership.includes('e2b-test'));
  assert.equal((await stat(join(home, 'e2b', records[0]))).mode & 0o777, 0o600);
  assert.equal((await info()).network.allowPublicTraffic, false);
  assert.equal((await matchingSandboxes(name)).length, 1, 'Services did not share one sandbox.');
  const remote = await info();
  const publicHost = `${3000}-${handle.e2b.sandboxId}.${remote.sandboxDomain || 'e2b.app'}`;
  const denied = await fetch(`https://${publicHost}/`, { signal: AbortSignal.timeout(10000), redirect: 'manual' });
  assert.equal(denied.status, 403, 'The E2B service allowed unauthenticated ingress.');
  await denied.body?.cancel();
  const initial = await json();
  assert.equal(initial.source, 'initial source');
  assert.equal(initial.label, 'e2b-test');
  assert.equal(initial.providerCredentialPresent, false);
  assert.equal(await (await fetch(`http://127.0.0.1:${pythonPort}/src/build/nested.txt`)).text(), 'nested source');
  await websocket();
  const events = await fetch(`http://127.0.0.1:${port}/events`, { signal: AbortSignal.timeout(45000) });
  assert.equal(await events.text(), 'data: first\n\ndata: after-idle\n\n');
  console.log('E2B private HTTP and WebSockets passed.');
  const exec = async argv => (await cli(['exec', name, '--service', 'web', '--', ...argv])).output;
  assert.equal((await exec(['node', '-e', 'process.stdout.write(process.argv[1])', 'literal $HOME; $(false)'])).trim(), 'literal $HOME; $(false)');
  const failure = await invoke(['exec', name, '--service', 'web', '--', 'sh', '-c', 'echo exec-stdout; echo exec-stderr >&2; exit 23'], false);
  assert.equal(failure.code, 23);
  assert.match(failure.stderr, /exec-stdout/);
  assert.match(failure.stderr, /exec-stderr/);
  const literal = 'literal $HOME; $(false)';
  assert.equal((await cli(['run', name, 'label'])).output.trim(), 'e2b-test');
  assert.equal((await cli(['run', name, 'argument', '--', literal])).output.trim(), literal);
  assert.equal((await cli(['run', name, 'literal', '--', literal])).output.trim(), literal);
  assert.equal((await cli(['run', name, 'python-port'])).output.trim(), '3001');
  const runFailure = await invoke(['run', name, 'failure'], false);
  assert.equal(runFailure.code, 31);
  assert.match(runFailure.stderr, /run-stdout/);
  assert.match(runFailure.stderr, /run-stderr/);
  const logs = (await cli(['logs', name, '--service', 'web'])).output;
  assert.match(logs, /e2b-service-stdout/);
  assert.match(logs, /e2b-service-stderr/);
  const excluded = ['.git', 'node_modules', 'dist', '.ssh', '.env', '.npmrc', 'credentials.json', 'private.pem', 'outside-link'];
  const checkExcluded = `const fs=require('node:fs');if(${JSON.stringify(excluded)}.some(path=>fs.existsSync(path)))process.exit(41)`;
  await exec(['node', '-e', checkExcluded]);
  await writeFile(join(cwd, 'source.txt'), 'automatic source');
  await writeFile(join(cwd, 'delete-me.txt'), 'temporary source');
  await writeFile(join(cwd, 'src/build/nested.txt'), 'automatic nested source');
  await until(async () => (await json()).source === 'automatic source', 60000);
  await until(async () => (await pythonFile('src/build/nested.txt')).body === 'automatic nested source', 60000);
  await until(async () => (await pythonFile('delete-me.txt')).body === 'temporary source', 60000);
  await rm(join(cwd, 'delete-me.txt'));
  await until(async () => (await pythonFile('delete-me.txt')).status === 404, 60000);
  console.log('E2B automatic source updates and deletion passed.');
  const longCommand = invoke(['run', name, 'slow'], false);
  await until(async () => (await pythonFile('long-running.txt')).status === 200, 20000);
  const responsive = await invoke(['list'], false, { timeout: 10000 });
  assert.equal(responsive.code, 0, 'A long E2B command blocked instance status.');
  await writeFile(join(cwd, 'source.txt'), 'during-long-command');
  await until(async () => (await json()).source === 'during-long-command', 20000);
  const completed = await longCommand;
  assert.equal(completed.code, 0, `The E2B command failed after its previous 60-second limit: ${completed.stderr}`);
  assert.match(completed.stdout, /long-complete/);
  await writeFile(join(cwd, 'source.txt'), 'automatic source');
  await until(async () => (await json()).source === 'automatic source', 20000);
  console.log('E2B command exceeded 60 seconds while status and automatic sync remained responsive.');
  await exec(['node', '-e', "if(require('node:fs').existsSync('delete-me.txt'))process.exit(42)"]);
  await exec(['sh', '-c', 'printf durable > ../persisted.txt']);
  const beforePause = await json();
  await cli(['down', name]);
  assert.equal((await info()).state, 'paused');
  assert.equal((await cli(['list'])).find(instance => instance.name === name).status.web, 'paused');
  await cli(['daemon', 'stop']);
  assert.equal((await info()).state, 'paused');
  await cli(['up']);
  const resumed = await json();
  assert.equal(resumed.pid, beforePause.pid, 'Resume replaced the service process.');
  assert.ok(resumed.counter > beforePause.counter, 'Resume lost service memory.');
  assert.equal((await exec(['cat', '../persisted.txt'])).trim(), 'durable');
  console.log('E2B pause/resume retained process memory and data.');
  await cli(['daemon', 'stop']);
  const reconnected = (await cli(['list'])).find(instance => instance.name === name);
  assert.equal(reconnected.connected, true);
  assert.equal(reconnected.sync, 'watching');
  assert.equal((await json()).pid, beforePause.pid);
  await websocket();
  await writeFile(join(cwd, 'src/build/nested.txt'), 'watcher after daemon reconnection');
  await until(async () => (await pythonFile('src/build/nested.txt')).body === 'watcher after daemon reconnection', 60000);

  for (let attempt = 0; attempt < 3; attempt++) {
    await cli(['up']);
    assert.equal((await json()).pid, beforePause.pid, 'Repeated up replaced a running service.');
  }
  config.services.web.env.APP_LABEL = 'changed-label';
  config.services.web.env.APP_TOKEN = 'dummy-e2b-private-second';
  await writeFile(configPath, JSON.stringify(config));
  await cli(['up']);
  const refreshed = await json();
  assert.equal(refreshed.label, 'changed-label');
  assert.notEqual(refreshed.pid, beforePause.pid, 'The changed environment did not restart its service.');
  const refreshedLogs = (await cli(['logs', name, '--service', 'web'])).output;
  assert.ok(!refreshedLogs.includes('dummy-e2b-private-first'), 'Retained logs exposed a previous secret.');
  assert.ok(!refreshedLogs.includes('dummy-e2b-private-second'), 'Current logs exposed a secret.');
  assert.equal((await readState()).instances[name].e2b.sandboxId, handle.e2b.sandboxId);
  assert.equal((await exec(['cat', '../persisted.txt'])).trim(), 'durable');
  await cli(['rm', name]);
  config.services.web.command = 'exec node server.cjs';
  config.services.web.env.APP_LABEL = 'retained-label';
  await writeFile(configPath, JSON.stringify(config));
  await cli(['up']);
  assert.equal((await json()).label, 'retained-label');
  assert.equal((await readState()).instances[name].e2b.sandboxId, handle.e2b.sandboxId);
  assert.equal((await exec(['cat', '../persisted.txt'])).trim(), 'durable');
  console.log('E2B repeated starts, environment refresh, and retained configuration changes passed.');

  await cli(['daemon', 'stop']);
  const originalState = await readFile(statePath, 'utf8');
  try {
    const altered = JSON.parse(originalState);
    altered.instances[name].e2b.recordId = '00000000-0000-4000-8000-000000000000';
    await writeFile(statePath, JSON.stringify(altered), { mode: 0o600 });
    const rejected = await invoke(['rm', name, '--purge'], false);
    assert.notEqual(rejected.code, 0, 'Purge accepted a handle with different ownership.');
    assert.match(rejected.stderr, /ownership/);
    assert.equal((await info()).state, 'running');
  } finally {
    await cli(['daemon', 'stop']);
    await writeFile(statePath, originalState, { mode: 0o600 });
  }
  const recordPath = join(home, 'e2b', records[0]);
  const originalRecord = await readFile(recordPath, 'utf8');
  try {
    const altered = JSON.parse(originalState), record = JSON.parse(originalRecord);
    for (const target of [altered.instances[name], record]) {
      target.e2b.recordId = '00000000-0000-4000-8000-000000000000';
      target.workspace = '/home/user/.agent-env/00000000-0000-4000-8000-000000000000/workspace';
    }
    await writeFile(statePath, JSON.stringify(altered), { mode: 0o600 });
    await writeFile(recordPath, JSON.stringify(record), { mode: 0o600 });
    const rejected = await invoke(['rm', name, '--purge'], false);
    assert.notEqual(rejected.code, 0, 'Purge accepted remote metadata with different ownership.');
    assert.match(rejected.stderr, /metadata.*ownership/);
    assert.equal((await info()).state, 'running');
  } finally {
    await cli(['daemon', 'stop']);
    await writeFile(statePath, originalState, { mode: 0o600 });
    await writeFile(recordPath, originalRecord, { mode: 0o600 });
  }
  await cli(['rm', name]);
  assert.equal((await info()).state, 'paused');
  assert.equal((await recordFiles()).length, 1, 'Nonpurge removal lost its ownership record.');
  await cli(['up', '--no-watch']);
  assert.equal((await readState()).instances[name].e2b.sandboxId, handle.e2b.sandboxId);
  assert.equal((await cli(['list'])).find(instance => instance.name === name).sync, 'manual');
  assert.equal((await exec(['cat', '../persisted.txt'])).trim(), 'durable');
  await writeFile(join(cwd, 'source.txt'), 'manual source');
  await writeFile(join(cwd, 'manual.txt'), 'manual file');
  const unchangedDeadline = Date.now() + 2500;
  do {
    assert.equal((await json()).source, 'automatic source', 'The disabled watcher propagated a source edit.');
    assert.equal((await pythonFile('manual.txt')).status, 404, 'The disabled watcher propagated a new file.');
    await delay(250);
  } while (Date.now() < unchangedDeadline);
  await cli(['sync', name]);
  assert.equal((await json()).source, 'manual source');
  assert.equal((await pythonFile('manual.txt')).body, 'manual file');
  await rm(join(cwd, 'manual.txt'));
  await delay(1000);
  assert.equal((await pythonFile('manual.txt')).body, 'manual file', 'The disabled watcher propagated a deletion.');
  await cli(['sync', name]);
  assert.equal((await pythonFile('manual.txt')).status, 404);

  await writeFile(configPath, JSON.stringify({ ...config, commands: {}, services: { web: { ...config.services.web, command: 'echo failed-start-stdout; echo failed-start-stderr >&2; exit 29' } } }));
  const failedStart = await invoke(['up', '--name', failedName], false);
  assert.equal(failedStart.code, 29);
  assert.match(failedStart.stderr, /failed-start-stdout/);
  assert.match(failedStart.stderr, /failed-start-stderr/);
  await until(async () => (await matchingSandboxes(failedName)).length === 0, 60000);
  assert.equal((await recordFiles()).length, 1, 'Failed creation left an ownership record.');
  await writeFile(configPath, JSON.stringify(config));
  await cli(['rm', name, '--purge']);
  await until(async () => (await matchingSandboxes(name)).length === 0, 60000);
  assert.equal((await recordFiles()).length, 0);
  assert.equal((await cli(['list'])).length, 0);
  const leaseName = `${name}-lease`;
  await writeFile(configPath, JSON.stringify({ ...config, e2b: { timeoutSeconds: 30 }, commands: {}, services: { web: config.services.web } }));
  await cli(['up', '--name', leaseName, '--no-watch']);
  const leaseHandle = (await readState()).instances[leaseName];
  await until(async () => {
    await delay(1000);
    return (await Sandbox.getInfo(leaseHandle.e2b.sandboxId, options)).state === 'paused';
  }, 60000);
  assert.equal((await cli(['list'])).find(instance => instance.name === leaseName).status.web, 'paused');
  const pausedExec = await invoke(['exec', leaseName, '--', 'true'], false);
  assert.notEqual(pausedExec.code, 0);
  assert.match(pausedExec.stderr, /paused/);
  await cli(['up', leaseName]);
  assert.equal((await readState()).instances[leaseName].e2b.sandboxId, leaseHandle.e2b.sandboxId);
  await cli(['rm', leaseName, '--purge']);
  assert.equal((await matchingSandboxes(leaseName)).length, 0);
  assert.equal((await recordFiles()).length, 0);
  console.log('E2B automatic lease expiry, explicit resume, and purge passed.');
  const output = JSON.stringify(started) + JSON.stringify(reconnected) + failure.stderr + runFailure.stderr + failedStart.stderr + await readFile(join(home, 'daemon.log'), 'utf8');
  assert.ok(!output.includes(process.env.E2B_API_KEY), 'Public output exposed an E2B credential.');
  assert.ok(!/trafficAccessToken|envdAccessToken/.test(JSON.stringify(await readState())), 'The daemon persisted a private transport token.');
} finally {
  try {
    await cli(['rm', '--all', '--purge']);
    if (handle) assert.equal((await matchingSandboxes(name)).length, 0, 'The paid sandbox remains after cleanup.');
    assert.equal((await recordFiles()).length, 0, 'E2B recovery records remain. Keep the recovery directory.');
    await cli(['daemon', 'stop']);
    await rm(directory, { recursive: true, force: true });
  } catch {
    await invoke(['daemon', 'stop'], false);
    throw new Error(`E2B cleanup is incomplete. Recovery files remain at ${directory}. Purge the owned sandbox before deleting these files.`);
  }
}
console.log('PASS: installed CLI E2B lifecycle, private HTTP, WebSockets, automatic sync, manual sync, project commands, exec, logs, ownership, and purge.');
