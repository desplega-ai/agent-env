import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createClient } from '@desplega.ai/agent-env';

const execute = promisify(execFile);
const run = async (file, args, options = {}) => (await execute(file, args, {
  timeout: 900000, maxBuffer: 16 * 1024 * 1024, ...options,
})).stdout.trim();
const source = resolve(process.argv[2] ?? process.env.AGENT_ENV_AGENT_FS_SOURCE ?? '');
assert.ok(process.argv[2] || process.env.AGENT_ENV_AGENT_FS_SOURCE, 'Provide the agent-fs source checkout path.');
const commit = await run('git', ['-C', source, 'rev-parse', 'HEAD']);
const before = await run('git', ['-C', source, 'status', '--porcelain=v1', '--untracked-files=all']);
const diskBefore = await run('df', ['-h', '/']);
const directory = await mkdtemp(join(tmpdir(), 'agent-env-agent-fs-'));
const cwd = join(directory, 'source');
const home = join(directory, 'state');
const name = `agent-fs-${randomBytes(6).toString('hex')}`;
const secrets = [randomBytes(12).toString('hex'), randomBytes(32).toString('hex')];
// This standalone process can receive npm metadata names that the SDK does not accept.
for (const key of Object.keys(process.env)) if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) delete process.env[key];
const env = Object.fromEntries(Object.keys(process.env).map(key => [key, undefined]));
for (const key of ['PATH', 'HOME', 'TMPDIR', 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'XDG_RUNTIME_DIR']) env[key] = process.env[key];
let client;
let attempted = false;
let stage = 'export';
let cleaned = false;

function request(port, path, options = {}) {
  return new Promise((resolveResult, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path, method: options.body ? 'POST' : 'GET',
      headers: { host: `${name}.localhost:${port}`, ...options.headers },
    }, async response => {
      try {
        let text = '';
        for await (const chunk of response) text += chunk;
        resolveResult({ status: response.statusCode, text });
      } catch (error) { reject(error); }
    });
    req.setTimeout(5000, () => req.destroy(new Error('The fixture HTTP request timed out.')));
    req.once('error', reject);
    req.end(options.body);
  });
}
async function resources(kind) {
  return run('docker', [kind, 'ls', ...(kind === 'container' ? ['-a'] : []), '-q', '--filter', `label=agent-env.instance=${name}`]);
}
try {
  client = createClient({ cwd, home, env, includeErrorOutput: true });
  await mkdir(cwd);
  // Export committed files only. Never copy the checkout's ignored files or environment files.
  const archive = join(directory, 'source.tar');
  await run('git', ['-C', source, 'archive', '--format=tar', '-o', archive, commit, '--', '.',
    ':!**/.env*', ':!.env*', ':!**/.npmrc', ':!.npmrc', ':!**/.mcp.json', ':!.mcp.json']);
  await run('tar', ['-xf', archive, '-C', cwd]);
  await rm(archive);
  for (const file of ['checks.mjs', 'compose.agent-env.yaml']) {
    await copyFile(new URL(file, import.meta.url), join(cwd, file === 'checks.mjs' ? 'packages/core/agent-env-checks.mjs' : file));
  }
  const config = JSON.parse(await readFile(new URL('agent-env.json', import.meta.url), 'utf8'));
  const listener = net.createServer();
  await new Promise((resolveResult, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', resolveResult); });
  const port = listener.address().port;
  await new Promise(resolveResult => listener.close(resolveResult));
  config.compose.routes.api.port = port;
  await writeFile(join(cwd, 'agent-env.json'), JSON.stringify(config));
  await writeFile(join(cwd, 'fixture.env'), `AGENT_FS_TEST_ACCESS_KEY=${secrets[0]}\nAGENT_FS_TEST_SECRET_KEY=${secrets[1]}\nAGENT_FS_TEST_PORT=${port}\n`, { mode: 0o600 });
  const appPath = join(cwd, 'packages/server/src/app.ts');
  const app = await readFile(appPath, 'utf8');
  const health = 'ok: true, version: VERSION';
  assert.equal(app.split(health).length, 2, 'The upstream health route changed. Review the source edit before retrying.');
  const marked = app.replace(health, 'ok: true, agentEnvAcceptance: "before", version: VERSION');
  await writeFile(appPath, marked);
  console.log(`agent-fs source: ${commit}`);
  stage = 'SDK Compose startup';
  console.log(stage);
  attempted = true;
  const instance = await client.up({ name, config: 'agent-env.json', envFiles: ['fixture.env'], watch: false });
  assert.equal(instance.provider, 'compose');
  assert.equal((await request(port, '/health')).status, 200);
  assert.equal(JSON.parse((await request(port, '/health')).text).agentEnvAcceptance, 'before');
  assert.equal((await request(port, '/auth/me')).status, 401);
  assert.equal((await request(port, '/auth/me', { headers: { Authorization: 'Bearer invalid-fixture-key' } })).status, 401);
  const registration = await request(port, '/auth/register', {
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: `${name}@acceptance.invalid` }),
  });
  assert.equal(registration.status, 200);
  const { apiKey } = JSON.parse(registration.text);
  secrets.push(apiKey);
  assert.equal((await request(port, '/auth/me', { headers: { Authorization: `Bearer ${apiKey}` } })).status, 200);
  stage = 'SDK run acceptance tests';
  console.log((await client.run(name, 'test', ['write'])).output);
  stage = 'copied source update';
  await writeFile(appPath, marked.replace('agentEnvAcceptance: "before"', 'agentEnvAcceptance: "after"'));
  let updated = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { updated = JSON.parse((await request(port, '/health')).text).agentEnvAcceptance === 'after'; } catch {}
    if (updated) break;
    await new Promise(resolveResult => setTimeout(resolveResult, 500));
  }
  assert.ok(updated, 'The real server must serve the edited source.');
  assert.match((await client.exec(name, ['cat', 'packages/server/src/app.ts'], { service: 'api' })).output, /agentEnvAcceptance: "after"/);
  console.log('PASS: the copied source edit changed the running HTTP response.');
  stage = 'SDK down and resume';
  const volumes = await resources('volume');
  assert.ok(volumes);
  await client.down(name);
  assert.equal((await client.list()).find(row => row.name === name).running, false);
  assert.equal(await resources('volume'), volumes);
  await client.resume(name, { startupTimeoutSeconds: 900 });
  assert.equal(JSON.parse((await request(port, '/health')).text).agentEnvAcceptance, 'after');
  console.log((await client.exec(name, ['bun', '--no-env-file', 'packages/core/agent-env-checks.mjs', 'persist'], { service: 'api' })).output);
  stage = 'SDK purge';
  await client.remove(name, { purge: true });
  assert.ok(!(await client.list()).some(row => row.name === name));
} catch (error) {
  let detail = error.stderr ?? error.message;
  for (const secret of secrets) detail = detail.replaceAll(secret, '[redacted]');
  const failure = new Error(`agent-fs acceptance failed during ${stage}: ${detail}`);
  console.error(failure.message);
  throw failure;
} finally {
  try {
    if (attempted && (await client.list()).some(row => row.name === name)) await client.remove(name, { purge: true });
    for (const kind of ['container', 'volume', 'network']) assert.equal(await resources(kind), '', `Owned ${kind} resources remain.`);
    if (attempted) await client.stopDaemon();
    assert.equal(await run('git', ['-C', source, 'rev-parse', 'HEAD']), commit);
    assert.equal(await run('git', ['-C', source, 'status', '--porcelain=v1', '--untracked-files=all']), before);
    cleaned = true;
  } finally {
    if (cleaned) await rm(directory, { recursive: true, force: true });
    else console.error(`Fixture cleanup needs attention: ${directory}`);
    console.log(`Disk before:\n${diskBefore}\nDisk after:\n${await run('df', ['-h', '/'])}`);
  }
  console.log('PASS: purge removed owned containers, volumes, and networks. The source checkout remained unchanged.');
}
