import { lstat, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { detectComposeFiles } from './providers/compose.mjs';
import { detectDevcontainerConfig } from './providers/devcontainer.mjs';
import { quote } from './system.mjs';

async function exists(filename) {
  try { return (await lstat(filename)).isFile(); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// Return public configuration only. This function never reads environment values.
export async function createInitialConfig(options = {}) {
  const cwd = await realpath(options.cwd ?? process.cwd());
  const files = await detectComposeFiles(cwd);
  if (files.length && !options.command?.length) return { provider: 'compose', compose: { files } };
  if (!options.command?.length && await detectDevcontainerConfig(cwd)) return { provider: 'devcontainer' };
  let manifest = {};
  try { manifest = JSON.parse(await readFile(resolve(cwd, 'package.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let manager = manifest.packageManager?.split('@')[0];
  const locks = [['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['package-lock.json', 'npm'], ['npm-shrinkwrap.json', 'npm']];
  let locked = false;
  for (const [filename, candidate] of locks) {
    if (await exists(resolve(cwd, filename))) {
      if (manager && manager !== candidate) throw new Error('The packageManager field conflicts with a lockfile. Select one package manager before initialization.');
      manager = candidate;
      locked = true;
    }
  }
  manager ??= 'npm';
  if (!['npm', 'pnpm', 'yarn', 'bun'].includes(manager)) throw new Error('Use npm, pnpm, yarn, or bun, or specify an explicit initialization command.');
  const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
  const frameworkPort = dependencies.astro ? 4321
    : dependencies.vite || dependencies['@sveltejs/kit'] ? 5173
      : dependencies['@angular/core'] ? 4200
        : dependencies['webpack-dev-server'] ? 8080 : 3000;
  const script = manifest.scripts?.dev ? 'dev' : manifest.scripts?.start ? 'start' : undefined;
  const port = Number(options.port ?? frameworkPort);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Public ports must be integers between 1024 and 65535.');
  let command;
  if (Array.isArray(options.command) && options.command.length) command = options.command.map(quote).join(' ');
  else if (typeof options.command === 'string' && options.command.trim()) command = options.command;
  else if (script) {
    const executable = ['pnpm', 'yarn'].includes(manager) ? `corepack ${manager}` : manager;
    const install = manager === 'npm' ? locked ? 'npm ci' : 'npm install'
      : `${executable} install${locked && ['pnpm', 'bun'].includes(manager) ? ' --frozen-lockfile' : ''}`;
    const host = dependencies.vite || dependencies.astro || dependencies.nuxt || dependencies['@sveltejs/kit'] || dependencies['webpack-dev-server'] ? ' --host 0.0.0.0'
      : dependencies.next ? ' --hostname 0.0.0.0' : dependencies['@angular/core'] ? ' --host 0.0.0.0' : '';
    const separator = manager === 'npm' && host ? ' --' : '';
    command = `${install} && ${executable} run ${script}${separator}${host}${host ? ` --port ${port}` : ''}`;
  } else throw new Error('Cannot detect a development command. Add a dev or start script, or initialize with an explicit command after --.');
  return {
    provider: 'docker',
    services: { web: {
      image: options.image ?? (manager === 'bun' ? 'oven/bun:1' : 'node:22-bookworm-slim'),
      port, command,
      env: { HOST: '0.0.0.0', PORT: String(port) },
      volumes: { dependencies: '/workspace/node_modules', cache: manager === 'bun' ? '/root/.bun' : manager === 'pnpm' ? '/root/.local/share/pnpm/store' : manager === 'yarn' ? '/usr/local/share/.cache/yarn' : '/root/.npm' },
    } },
  };
}

export async function initialize(options = {}) {
  const cwd = await realpath(options.cwd ?? process.cwd());
  const config = await createInitialConfig({ ...options, cwd });
  const filename = resolve(cwd, options.config ?? 'agent-env.json');
  await writeFile(filename, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' });
  return { filename, config };
}
