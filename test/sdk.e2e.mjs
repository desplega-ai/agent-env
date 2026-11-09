import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inspect } from 'node:util';

async function processResult(binary, args, options = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(binary, args, { ...options, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 600000);
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('close', code => { clearTimeout(timer); resolveResult({ code, stdout, stderr }); });
  });
}
async function run(binary, args, options) {
  const result = await processResult(binary, args, options);
  assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout.trimEnd();
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolveResult, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolveResult); });
  const port = server.address().port;
  await new Promise(resolveResult => server.close(resolveResult));
  return port;
}
async function request(port, host) {
  return new Promise((resolveResult, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, headers: { host } }, async response => {
      try {
        let body = '';
        for await (const chunk of response) body += chunk;
        resolveResult({ status: response.statusCode, body });
      } catch (error) { reject(error); }
    });
    req.setTimeout(5000, () => req.destroy(new Error('The SDK HTTP check timed out.')));
    req.once('error', reject);
  });
}

if (process.argv[2] !== '--installed') {
  assert.ok(!process.env.AGENT_ENV_CLI || process.env.AGENT_ENV_SDK_TARBALL, 'Set AGENT_ENV_SDK_TARBALL with AGENT_ENV_CLI so SDK and CLI tests use the same package.');
  const root = resolve(import.meta.dirname, '..');
  const directory = await mkdtemp(join(tmpdir(), 'agent-env-sdk-'));
  const prefix = join(directory, 'install');
  let artifact;
  let preserveState = false;
  try {
    await mkdir(prefix);
    if (process.env.AGENT_ENV_SDK_TARBALL) artifact = resolve(process.env.AGENT_ENV_SDK_TARBALL);
    else {
      await run(process.execPath, ['scripts/pack.mjs', directory], { cwd: root });
      const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
      artifact = join(directory, `desplega.ai-agent-env-${version}.tgz`);
    }
    await run('npm', ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', artifact]);
    await writeFile(join(prefix, 'consumer.mts'), `
import { createClient, AgentEnvError } from '@desplega.ai/agent-env';
import type { Provider, OmittedMount } from '@desplega.ai/agent-env';
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;
const client = createClient({ cwd: '.', home: './state', env: { TOKEN: undefined }, includeErrorOutput: true });
async function consumer() {
  const instance = await client.up({ provider: 'docker', name: 'typed', envFiles: false, startupTimeoutSeconds: 30 });
  type ProviderCheck = Expect<Equal<typeof instance.provider, Provider>>;
  type RunningCheck = Expect<Equal<typeof instance.running, boolean>>;
  const recovery: 'required' | undefined = instance.recovery;
  const url: string | null | undefined = instance.services.web?.url;
  const list = await client.list();
  const status: string | undefined = list[0]?.status.web;
  const command = await client.exec('typed', ['printf', '%s', 'literal'] as const);
  type OutputCheck = Expect<Equal<typeof command.output, string>>;
  const named: string = (await client.run('typed', 'test', ['argument'], { service: 'web' })).output;
  const logs: string = (await client.logs('typed')).output;
  const message: string = (await client.sync('typed')).message;
  const snapshot = await client.snapshot('typed', 'storage://backups/typed');
  type MountCheck = Expect<Equal<typeof snapshot.omittedMounts, OmittedMount[]>>;
  const restored = await client.restore('./backup', { name: 'restored', provider: 'compose', composeFiles: ['compose.yaml'], profiles: ['test'], environment: 'ci', envFiles: ['ci.env'], watch: false });
  const mounts: OmittedMount[] = restored.omittedMounts;
  await client.up({ ssh: 'test-host', sshConfig: './ssh.config' });
  await client.up({ cloud: 'hetzner', cloudType: 'cx23', location: 'fsn1', ttlHours: 1, idleMinutes: 5 });
  await client.up({ provider: 'sandbox', adapter: 'docker', local: true });
  const fork = await client.fork('typed', 'forked');
  const paths: string[] | undefined = fork.omittedPaths;
  await client.down('typed');
  await client.resume('typed', { startupTimeoutSeconds: 120 });
  await client.remove('typed', { purge: true });
  await client.remove('typed', { acceptUncertain: true });
  await client.stopDaemon();
  // @ts-expect-error Successful command results have no exitCode.
  command.exitCode;
  // @ts-expect-error Successful command results have no stdout stream.
  command.stdout;
  // @ts-expect-error Successful command results have no stderr stream.
  command.stderr;
  // @ts-expect-error The SDK requires a directory.
  createClient({});
  // @ts-expect-error Provider names use the supported union.
  client.up({ provider: 'imaginary' });
  // @ts-expect-error Environment values must be strings or undefined.
  createClient({ cwd: '.', env: { TOKEN: true } });
  // @ts-expect-error Purge must be a boolean.
  client.remove('typed', { purge: 'false' });
  // @ts-expect-error Error output requires a boolean.
  createClient({ cwd: '.', includeErrorOutput: 'true' });
  // @ts-expect-error Removal requires an explicit name.
  client.remove();
  // @ts-expect-error Exec requires an argument array.
  client.exec('typed', 'rm -rf /data');
  // @ts-expect-error Restore requires an explicit new name.
  client.restore('./backup', {});
  // @ts-expect-error Environment file selection requires an array or false.
  client.up({ envFiles: true });
  // @ts-expect-error Startup timeouts use seconds as numbers.
  client.resume('typed', { startupTimeoutSeconds: '60' });
  // @ts-expect-error Commands use strings for every argument.
  client.run('typed', 'test', [true]);
  // @ts-expect-error The SDK does not expose an all-instances switch.
  client.down('typed', { all: true });
  try { await client.list(); } catch (error) {
    if (error instanceof AgentEnvError) {
      const exitCode: number | undefined = error.exitCode;
      const code: string = error.code;
      const stderr: string | undefined = error.stderr;
    }
  }
}
`);
    await run(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '--strict', '--exactOptionalPropertyTypes', '--noUncheckedIndexedAccess', '--noEmit', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022', 'consumer.mts'], { cwd: prefix });
    console.log('PASS: strict TypeScript consumer imports the installed public export.');
    await copyFile(new URL(import.meta.url), join(prefix, 'sdk.e2e.mjs'));
    const result = await processResult(process.execPath, [join(prefix, 'sdk.e2e.mjs'), '--installed'], { cwd: prefix });
    preserveState = !result.stdout.includes('PASS: SDK resource cleanup.');
    console.log(result.stdout.trimEnd());
    assert.equal(result.code, 0, result.stderr);
    console.log('PASS: SDK verified the selected package archive.');
  } finally {
    if (preserveState) console.error(`SDK cleanup needs attention. Recovery directory: ${directory}`);
    else await rm(directory, { recursive: true, force: true });
  }
} else {
  // This copy executes beside its task-owned node_modules installation.
  const { createClient, AgentEnvError } = await import('@desplega.ai/agent-env');
  const directory = resolve(import.meta.dirname, '..');
  const installedCli = join(import.meta.dirname, 'node_modules/.bin/agent-env');
  const cwdBefore = process.cwd(), envBefore = { ...process.env };
  const id = `sdk-${randomUUID().slice(0, 8)}`;
  const primary = id, restoredName = `${id}-restored`, forkName = `${id}-fork`;
  const tokenA = `private-a-${randomUUID()}`, tokenB = `private-b-${randomUUID()}`;
  const contexts = [];
  const invalid = error => error instanceof AgentEnvError && error.code === 'INVALID_ARGUMENT';
  const failure = (exitCode, secrets = []) => error => {
    assert.ok(error instanceof AgentEnvError);
    assert.equal(error.code, 'CLI_FAILED');
    assert.equal(error.exitCode, exitCode);
    const exposed = inspect(error, { showHidden: true }) + JSON.stringify(error);
    for (const secret of secrets) assert.ok(!exposed.includes(secret), 'An SDK error exposed a private value.');
    assert.ok(!('cause' in error) && !('stdout' in error) && !('stderr' in error) && !('spawnargs' in error));
    return true;
  };
  const cli = async (context, args) => JSON.parse(await run(process.execPath, [installedCli, '--json', ...args], { cwd: context.cwd, env: { ...process.env, AGENT_ENV_HOME: context.home } }));
  try {
    await run('docker', ['info', '--format', '{{.ServerVersion}}']);
    for (const [index, token] of [tokenA, tokenB].entries()) {
      const cwd = join(directory, `checkout ${index}`), home = join(directory, `state-${index}`);
      await mkdir(cwd);
      await mkdir(join(directory, `snapshots-${index}`));
      const port = await freePort();
      const context = { cwd, home, port, names: new Set([primary, restoredName, forkName]) };
      const env = { SDK_TOKEN: token, AGENT_ENV_HOME: home, SDK_UNRELATED_PRIVATE: `unrelated-${token}` };
      context.client = createClient({ cwd, ...(index === 0 ? { home } : {}), env });
      contexts.push(context);
      await writeFile(join(cwd, 'index.html'), `sdk-http-${index}`);
      await writeFile(join(cwd, 'marker'), `checkout-${index}`);
      await writeFile(join(cwd, 'fixture.env'), `FIXTURE_VALUE=fixture-${index}\n`);
      await writeFile(join(cwd, 'stack.json'), JSON.stringify({
        env: { TOKEN: { env: 'SDK_TOKEN' }, INHERITED_HOME: { env: 'HOME' } },
        services: { web: { image: 'busybox:1.37', port, containerPort: 8080, command: 'echo sdk-started; echo "$TOKEN"; exec httpd -f -p 8080 -h /workspace', volumes: { data: '/data' } } },
        commands: { args: ['printf', '<%s>\n'], fail: 'printf "%s" "$TOKEN"; printf failure >&2; exit 23' },
        environments: { ci: {} },
        storage: { disk: { provider: 'local', root: join(directory, `snapshots-${index}`) } },
      }));
    }
    const [a, b] = contexts, client = a.client;
    for (const value of [undefined, null, '', '--all', true, ['--all']]) {
      await assert.rejects(() => client.down(value), invalid);
      await assert.rejects(() => client.remove(value, { purge: true }), invalid);
    }
    for (const options of [{ purge: 'false' }, { purge: 1 }, { acceptUncertain: 'true' }, { all: true }, null]) await assert.rejects(() => client.remove(primary, options), invalid);
    for (const options of [{ watch: 'false' }, { local: '--all' }, { envFiles: true }, { envFiles: [] }, { profiles: 'test' }, { startupTimeoutSeconds: 0 }, { startupTimeoutSeconds: 1.2 }, { startupTimeoutSeconds: 3601 }, { ssh: 'test', cloud: 'hetzner' }, { provider: 'fake' }, { unknown: true }]) await assert.rejects(() => client.up(options), invalid);
    await assert.rejects(() => client.exec(primary, 'echo unsafe'), invalid);
    await assert.rejects(() => client.exec(primary, [true]), invalid);
    await assert.rejects(() => client.restore('./backup', {}), invalid);
    assert.throws(() => createClient({ cwd: a.cwd, env: { PRIVATE: tokenA, BAD: true } }), invalid);
    assert.throws(() => createClient({ cwd: a.cwd, maxOutputBytes: 0 }), invalid);
    assert.throws(() => createClient({ cwd: a.cwd, includeErrorOutput: 'true' }), invalid);
    const startup = { name: primary, provider: 'docker', local: true, config: 'stack.json', environment: 'ci', envFiles: ['fixture.env'], watch: false, startupTimeoutSeconds: 120 };
    const started = await Promise.all(contexts.map(context => context.client.up(startup)));
    assert.deepEqual(started.map(value => value.name), [primary, primary]);
    assert.ok(started.every(value => value.connected && value.running && value.provider === 'docker'));
    for (const [index, context] of contexts.entries()) {
      const response = await request(context.port, `${primary}.localhost:${context.port}`);
      assert.equal(response.status, 200);
      assert.equal(response.body, `sdk-http-${index}`);
      assert.equal((await context.client.exec(primary, ['cat', '/workspace/marker'])).output, `checkout-${index}`);
      assert.equal((await context.client.exec(primary, ['printenv', 'FIXTURE_VALUE'])).output, `fixture-${index}`);
      assert.equal((await context.client.exec(primary, ['sh', '-c', 'test -n "$INHERITED_HOME" && printf inherited'])).output, 'inherited');
      assert.deepEqual((await context.client.list()).map(instance => instance.name), [primary]);
      assert.deepEqual((await cli(context, ['list'])).map(instance => instance.name), [primary]);
    }
    console.log('PASS: SDK validation, concurrent clients, HTTP, environment selection, and shared CLI state.');
    const args = ['space value', '$(touch /data/unsafe)', '; touch /data/unsafe', '"quoted"', '--purge', '-n', '', 'unicode-λ'];
    const expected = args.map(value => `<${value}>`).join('\n');
    assert.equal((await client.exec(primary, ['printf', '<%s>\n', ...args], { service: 'web' })).output, expected);
    assert.equal((await client.run(primary, 'args', args, { service: 'web' })).output, expected);
    assert.equal((await client.exec(primary, ['sh', '-c', 'test ! -e /data/unsafe && printf safe'])).output, 'safe');
    const combined = (await client.exec(primary, ['sh', '-c', 'printf stdout-proof; printf stderr-proof >&2'])).output;
    assert.ok(combined.includes('stdout-proof') && combined.includes('stderr-proof'));
    await assert.rejects(() => client.exec(primary, ['sh', '-c', `printf '%s' '${tokenA}'; printf '%s' 'unrelated-${tokenA}' >&2; exit 17`]), failure(17, [tokenA, `unrelated-${tokenA}`]));
    await assert.rejects(() => client.run(primary, 'fail'), failure(23, [tokenA]));
    const diagnostic = createClient({ cwd: a.cwd, home: a.home, includeErrorOutput: true });
    await assert.rejects(() => diagnostic.run(primary, 'fail'), error => {
      assert.ok(error instanceof AgentEnvError);
      assert.equal(error.exitCode, 23);
      assert.match(error.stderr, /failure/);
      assert.match(error.stderr, /\[redacted\]/);
      assert.ok(!error.stderr.includes(tokenA));
      return true;
    });
    await assert.rejects(() => diagnostic.exec(primary, ['sh', '-c', 'printf unregistered-output >&2; exit 19']), error => {
      assert.equal(error.exitCode, 19);
      assert.match(error.stderr, /unregistered-output/);
      return true;
    });
    const large = await client.exec(primary, ['sh', '-c', 'head -c 1200000 /dev/zero | tr "\\000" x']);
    assert.equal(large.output.length, 1200000);
    assert.match(large.output, /^x+$/);
    const limited = createClient({ cwd: a.cwd, home: a.home, maxOutputBytes: 1024 });
    await assert.rejects(() => limited.exec(primary, ['sh', '-c', 'head -c 8192 /dev/zero | tr "\\000" x']), error => error instanceof AgentEnvError && error.code === 'OUTPUT_LIMIT');
    const logs = await client.logs(primary, { service: 'web' });
    assert.match(logs.output, /sdk-started/);
    assert.ok(!logs.output.includes(tokenA));
    assert.match(logs.output, /\[redacted\]/);
    assert.match((await client.sync(primary)).message, /synchronized/);
    console.log('PASS: SDK commands, failures, private errors, large output, logs, and synchronization.');
    await client.exec(primary, ['sh', '-c', 'printf volume-proof > /data/proof']);
    await cli(a, ['exec', primary, '--', 'sh', '-c', 'printf cli-proof > /data/cli']);
    assert.equal((await client.exec(primary, ['cat', '/data/cli'])).output, 'cli-proof');
    await client.down(primary);
    assert.equal((await client.list())[0].running, false);
    const saved = await client.snapshot(primary, 'storage://disk/public-sdk', { config: 'stack.json' });
    assert.equal(saved.storageProfile.name, 'disk');
    assert.equal(saved.storageProfile.source, 'project');
    assert.ok(Array.isArray(saved.omittedMounts));
    console.log('PASS: SDK local storage profile snapshot.');
    const restored = await client.restore('storage://disk/public-sdk', { ...startup, name: restoredName, envFiles: false });
    assert.ok(restored.connected && Array.isArray(restored.omittedMounts));
    assert.deepEqual(restored.storageProfile, { name: 'disk', source: 'project' });
    assert.equal((await client.exec(restoredName, ['cat', '/data/proof'])).output, 'volume-proof');
    await client.remove(restoredName, { purge: true });
    const localSnapshot = await client.snapshot(primary, join(directory, 'local-snapshot'));
    assert.equal(localSnapshot.location, join(directory, 'local-snapshot'));
    await client.restore(localSnapshot.location, { ...startup, name: restoredName, envFiles: false });
    assert.equal((await client.exec(restoredName, ['cat', '/data/proof'])).output, 'volume-proof');
    await client.remove(restoredName, { purge: true });
    const forked = await client.fork(primary, forkName);
    assert.equal(forked.name, forkName);
    assert.equal((await client.exec(forkName, ['cat', '/data/proof'])).output, 'volume-proof');
    await client.remove(forkName, { purge: true });
    console.log('PASS: SDK volume restore, local path snapshot, and fork.');
    await client.resume(primary, { startupTimeoutSeconds: 120 });
    assert.equal((await client.exec(primary, ['cat', '/data/proof'])).output, 'volume-proof');
    await cli(a, ['down', primary]);
    assert.equal((await client.list())[0].running, false);
    await client.resume(primary);
    await client.stopDaemon();
    assert.equal((await client.list())[0].connected, true);
    const removedHome = createClient({ cwd: a.cwd, home: a.home, env: { HOME: undefined, SDK_TOKEN: tokenA } });
    await assert.rejects(() => removedHome.up({ ...startup, name: `${id}-missing-env` }), failure(1, [tokenA]));
    const invalidConfig = join(a.cwd, 'invalid.json');
    await writeFile(invalidConfig, `{ "private": "${tokenA}"`);
    await assert.rejects(() => client.up({ config: 'invalid.json' }), failure(1, [tokenA]));
    const missingCwd = createClient({ cwd: join(directory, tokenA), env: { PRIVATE: tokenA } });
    await assert.rejects(() => missingCwd.list(), error => {
      assert.ok(error instanceof AgentEnvError && error.code === 'TRANSPORT_ERROR');
      assert.ok(!inspect(error, { showHidden: true }).includes(tokenA));
      return true;
    });
    await client.remove(primary, { purge: true });
    assert.deepEqual(await client.list(), []);
    assert.equal((await b.client.list())[0].running, true);
    assert.equal((await b.client.exec(primary, ['cat', '/workspace/marker'])).output, 'checkout-1');
    assert.equal(process.cwd(), cwdBefore);
    assert.deepEqual({ ...process.env }, envBefore);
    console.log('PASS: installed SDK Docker lifecycle, HTTP, commands, CLI interoperability, isolation, validation, errors, output limits, snapshots, restore, and fork.');
  } finally {
    const cleanup = await Promise.allSettled(contexts.map(async context => {
      try {
        const instances = await cli(context, ['list']);
        const removed = await Promise.allSettled(instances.map(async instance => {
          assert.ok(context.names.has(instance.name), 'Cleanup refused an unexpected instance.');
          await cli(context, ['rm', instance.name, '--purge']);
        }));
        for (const result of removed) if (result.status === 'rejected') throw result.reason;
        const state = JSON.parse(await readFile(join(context.home, 'state.json'), 'utf8'));
        for (const resource of [['container', 'ls', '-aq'], ['volume', 'ls', '-q'], ['network', 'ls', '-q']]) {
          assert.equal(await run('docker', [...resource, '--filter', `label=agent-env.owner=${state.owner}`]), '', 'The SDK test left an owned Docker resource.');
        }
      } finally { await cli(context, ['daemon', 'stop']); }
    }));
    for (const result of cleanup) if (result.status === 'rejected') throw result.reason;
  }
  await run(process.execPath, [join(import.meta.dirname, 'node_modules/@desplega.ai/agent-env/examples/sdk/ci.mjs')]);
  console.log('PASS: installed SDK CI example.');
  console.log('PASS: SDK resource cleanup.');
}
