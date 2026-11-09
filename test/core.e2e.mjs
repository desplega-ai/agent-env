import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, createCli } from './helpers.mjs';

const test = await fixture('core', { AGENT_ENV_E2E_INPUT: 'private-core-value-$-literal' });
const { cwd, home, cli, invoke } = test;
async function fails(args, pattern, options) {
  const result = await invoke(args, false, options);
  assert.notEqual(result.code, 0, `${args.join(' ')} unexpectedly succeeded.`);
  assert.match(result.stderr, pattern);
  assert.ok(!(result.stdout + result.stderr).includes('private-core-value-$-literal'));
}
async function project(name, files) {
  const directory = join(cwd, name);
  await mkdir(directory);
  for (const [file, content] of Object.entries(files)) await writeFile(join(directory, file), typeof content === 'string' ? content : JSON.stringify(content));
  return directory;
}
try {
  assert.match((await invoke(['--help'])).stdout, /agent-env.*localhost/s);
  const version = (await invoke(['--version'])).stdout.trim();
  assert.match(version, /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/);
  assert.equal((await invoke(['-v'])).stdout.trim(), version);
  assert.deepEqual(await cli(['--version']), { version });
  assert.deepEqual(await cli(['list']), []);
  for (const [args, pattern] of [
    [['invalid-command'], /Unknown command/],
    [['--unknown-flag'], /Unknown option/],
    [['down'], /instance name/],
    [['exec', 'missing'], /command after --/],
    [['run', 'missing'], /run NAME COMMAND/],
    [['fork', 'missing'], /destination/],
    [['snapshot', 'missing'], /destination/],
    [['restore'], /snapshot directory/],
    [['rm', 'missing', '--discard-worktree'], /--remove-worktree/],
    [['up', 'saved', '--name', 'different'], /resume a saved instance/],
    [['env', 'invalid'], /env set/],
    [['env', 'set', 'bad-key'], /variable name/],
    [['env', 'set', 'MISSING', '--from-env', 'AGENT_ENV_E2E_UNSET'], /not defined/],
    [['up', '--name', '../unsafe'], /name/],
    [['up', '--name', 'safe', '--port', '80', '--', 'sleep', '5'], /ports must be integers/],
    [['up', '--name', 'safe', '--idle-minutes', '1'], /cloud/],
  ]) await fails(args, pattern);

  for (const timeout of ['0', '-1', '3601', '1.5', 'invalid']) {
    await fails(['up', '--name', 'timeout-invalid', '--timeout', timeout], /timeout|Timeout|integer|seconds/);
  }
  for (const timeout of [0, -1, 3601, 1.5, 'invalid']) {
    const directory = await project(`timeout-${String(timeout).replaceAll('.', '-')}`, {
      'agent-env.json': { startupTimeoutSeconds: timeout, services: { web: { image: 'busybox:1.37', port: 8123 } } },
    });
    await fails(['up', '--name', 'timeout-invalid'], /timeout|Timeout|integer|seconds/, { cwd: directory });
  }
  const explicit = await project('explicit', {});
  await cli(['init', '--port', '8123', '--image', 'busybox:1.37', '--', 'node', 'some file.js'], { cwd: explicit });
  const explicitConfig = await readFile(join(explicit, 'agent-env.json'), 'utf8');
  const parsed = JSON.parse(explicitConfig);
  assert.equal(parsed.services.web.port, 8123);
  assert.equal(parsed.services.web.image, 'busybox:1.37');
  assert.match(parsed.services.web.command, /'some file.js'/);
  await fails(['init', '--', 'echo', 'replacement'], /EEXIST|exist/, { cwd: explicit });
  assert.equal(await readFile(join(explicit, 'agent-env.json'), 'utf8'), explicitConfig);
  await fails(['init'], /development command|explicit command/, { cwd });

  for (const [name, manifest, lock, port, command, image] of [
    ['npm', { scripts: { start: 'next start' }, dependencies: { next: '*' } }, 'package-lock.json', 3000, /npm ci.*npm run start -- --hostname 0.0.0.0/, 'node:22-bookworm-slim'],
    ['pnpm', { scripts: { dev: 'vite' }, devDependencies: { vite: '*' } }, 'pnpm-lock.yaml', 5173, /corepack pnpm install --frozen-lockfile.*run dev --host 0.0.0.0/, 'node:22-bookworm-slim'],
    ['bun', { packageManager: 'bun@1.3.0', scripts: { dev: 'astro dev' }, dependencies: { astro: '*' } }, 'bun.lock', 4321, /bun install --frozen-lockfile/, 'oven/bun:1'],
    ['yarn', { packageManager: 'yarn@4.0.0', scripts: { dev: 'vite' }, devDependencies: { vite: '*' } }, 'yarn.lock', 5173, /corepack yarn install.*corepack yarn run dev/, 'node:22-bookworm-slim'],
  ]) {
    const directory = await project(name, { 'package.json': manifest, [lock]: '{}' });
    await cli(['init'], { cwd: directory });
    const config = JSON.parse(await readFile(join(directory, 'agent-env.json'), 'utf8'));
    assert.equal(config.services.web.port, port);
    assert.match(config.services.web.command, command);
    assert.equal(config.services.web.image, image);
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')), manifest);
  }
  const conflict = await project('conflict', { 'package.json': { packageManager: 'bun@1' }, 'pnpm-lock.yaml': '{}' });
  await fails(['init'], /conflicts/, { cwd: conflict });
  const compose = await project('compose', { 'compose.yaml': 'services:\n  web:\n    image: busybox:1.37\n', 'compose.override.yaml': 'services: {}\n' });
  await writeFile(join(compose, '.devcontainer.json'), '{"image":"node:22-bookworm-slim"}');
  await cli(['init'], { cwd: compose });
  assert.deepEqual(JSON.parse(await readFile(join(compose, 'agent-env.json'), 'utf8')), { provider: 'compose', compose: { files: ['compose.yaml', 'compose.override.yaml'] } });
  assert.equal(await readFile(join(compose, 'compose.yaml'), 'utf8'), 'services:\n  web:\n    image: busybox:1.37\n');

  const devcontainer = await project('devcontainer-init', { '.devcontainer.json': '{ // existing project\n "image": "node:22-bookworm-slim"\n}' });
  await cli(['init'], { cwd: devcontainer });
  assert.deepEqual(JSON.parse(await readFile(join(devcontainer, 'agent-env.json'), 'utf8')), { provider: 'devcontainer' });
  const e2b = await project('e2b-no-key', {});
  const e2bState = join(test.directory, 'e2b-state');
  const noKey = await createCli(e2b, e2bState, { E2B_API_KEY: '' }).invoke(['up', '--provider', 'e2b', '--port', '3010', '--', 'node', 'server.js'], false);
  assert.notEqual(noKey.code, 0);
  assert.match(noKey.stderr, /E2B_API_KEY/);
  await assert.rejects(stat(e2bState), { code: 'ENOENT' });
  await writeFile(join(e2b, 'agent-env.json'), JSON.stringify({ provider: 'e2b', e2b: { credentials: { apiKey: 'fixture-key-never-use' } } }));
  const publicKey = await createCli(e2b, e2bState).invoke(['up'], false);
  assert.notEqual(publicKey.code, 0);
  assert.match(publicKey.stderr, /Do not put E2B credentials/);
  assert.ok(!(publicKey.stdout + publicKey.stderr).includes('fixture-key-never-use'));
  await assert.rejects(stat(e2bState), { code: 'ENOENT' });
  for (const commands of [{ invalid: [] }, { install: { command: ['echo'], service: 'missing' } }, { install: { command: 'echo ok', unknown: true } }]) {
    await writeFile(join(explicit, 'agent-env.json'), JSON.stringify({ services: { web: { image: 'busybox:1.37', port: 8123 } }, commands }));
    await fails(['up', '--name', 'invalid-command'], /command/i, { cwd: explicit });
  }

  const stored = await invoke(['env', 'set', 'TOKEN', '--env', 'review'], true, { input: 'private-core-value-$-literal\n' });
  assert.ok(!(stored.stdout + stored.stderr).includes('private-core-value-$-literal'));
  await cli(['env', 'set', 'OTHER', '--env', 'review', '--from-env', 'AGENT_ENV_E2E_INPUT']);
  assert.deepEqual(await cli(['env', 'list', '--env', 'review']), ['OTHER', 'TOKEN']);
  assert.deepEqual(await cli(['env', 'list']), []);
  assert.deepEqual(await cli(['env', 'list', '--env', 'review'], { cwd: explicit }), []);
  const stores = await readdir(join(home, 'secrets'));
  for (const store of stores) {
    const directory = join(home, 'secrets', store);
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    for (const file of await readdir(directory)) assert.equal((await stat(join(directory, file))).mode & 0o777, 0o600);
  }
  await cli(['env', 'unset', 'TOKEN', '--env', 'review']);
  assert.deepEqual(await cli(['env', 'list', '--env', 'review']), ['OTHER']);
  await cli(['env', 'unset', 'TOKEN', '--env', 'review']);
  await cli(['env', 'unset', 'OTHER', '--env', 'review']);
  assert.deepEqual(await cli(['env', 'list', '--env', 'review']), []);
  console.log('PASS: CLI version, help, misuse, init detection, source preservation, and isolated private secret commands.');
} finally {
  await test.cleanup();
}
