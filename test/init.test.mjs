import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInitialConfig, initialize } from '../src/init.mjs';

async function fixture(t, manifest) {
  const cwd = await mkdtemp(join(tmpdir(), 'dev-now-init-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  if (manifest) await writeFile(join(cwd, 'package.json'), JSON.stringify(manifest));
  return cwd;
}
test('initialization detects Compose and never changes source files or existing config', async t => {
  const cwd = await fixture(t);
  const source = 'services:\n  web:\n    image: busybox:1.37\n';
  await writeFile(join(cwd, 'compose.yaml'), source);
  await writeFile(join(cwd, 'compose.override.yaml'), 'services: {}\n');
  const { config } = await initialize({ cwd });
  assert.deepEqual(config, { provider: 'compose', compose: { files: ['compose.yaml', 'compose.override.yaml'] } });
  assert.equal(await readFile(join(cwd, 'compose.yaml'), 'utf8'), source);
  await assert.rejects(initialize({ cwd }), { code: 'EEXIST' });
});
test('initialization detects package managers, scripts, and framework ports without editing scripts', async t => {
  const manifest = { scripts: { dev: 'vite' }, devDependencies: { vite: '*' } };
  const cwd = await fixture(t, manifest);
  await writeFile(join(cwd, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  const config = await createInitialConfig({ cwd });
  assert.equal(config.services.web.port, 5173);
  assert.match(config.services.web.command, /corepack pnpm install --frozen-lockfile/);
  assert.match(config.services.web.command, /run dev --host 0.0.0.0/);
  assert.deepEqual(JSON.parse(await readFile(join(cwd, 'package.json'), 'utf8')), manifest);
});
test('npm start and explicit commands work, and unknown projects require a useful command', async t => {
  const cwd = await fixture(t, { scripts: { start: 'node server.js' }, dependencies: { next: '*' } });
  await writeFile(join(cwd, 'package-lock.json'), '{}');
  assert.match((await createInitialConfig({ cwd })).services.web.command, /npm ci && npm run start -- --hostname 0.0.0.0/);
  const empty = await fixture(t);
  await assert.rejects(createInitialConfig({ cwd: empty }), /explicit command after --/);
  const explicit = await createInitialConfig({ cwd: empty, command: ['node', 'some file.js'], port: 8088 });
  assert.equal(explicit.services.web.command, "'node' 'some file.js'");
  assert.equal(explicit.services.web.port, 8088);
});
test('bun and Astro detection select a compatible image and port', async t => {
  const cwd = await fixture(t, { packageManager: 'bun@1.3.0', scripts: { dev: 'astro dev' }, dependencies: { astro: '*' } });
  await writeFile(join(cwd, 'bun.lock'), '{}');
  const config = await createInitialConfig({ cwd });
  assert.equal(config.services.web.image, 'oven/bun:1');
  assert.equal(config.services.web.port, 4321);
  assert.match(config.services.web.command, /bun install --frozen-lockfile/);
});
