import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { detectComposeFiles } from './providers/compose.mjs';
import { loadSpec } from './config.mjs';
import { readEnvironmentSecrets, setEnvironmentSecret } from './environments.mjs';

export async function addService(kind, options = {}) {
  if (!['postgres', 'redis'].includes(kind)) throw new Error('Available services: postgres, redis.');
  const cwd = options.cwd ?? process.cwd();
  const filename = resolve(cwd, options.config ?? 'dev-now.json');
  let config, existing = true;
  try { config = JSON.parse(await readFile(filename, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    existing = false;
    const files = await detectComposeFiles(cwd);
    config = files.length ? { provider: 'compose', compose: { files } } : { provider: 'docker', services: {} };
  }
  if (config.provider && !['docker', 'compose'].includes(config.provider)) throw new Error('Service templates support Docker and Compose projects.');
  const port = Number(options.port ?? (kind === 'postgres' ? 55432 : 56379));
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Use a public port between 1024 and 65535.');
  const postgres = kind === 'postgres';
  const service = {
    image: postgres ? 'postgres:16-alpine' : 'redis:7-alpine',
    port, containerPort: postgres ? 5432 : 6379, protocol: 'tcp',
    health: postgres ? 'pg_isready -h 127.0.0.1 -U postgres' : 'redis-cli ping',
    volumes: { data: postgres ? '/var/lib/postgresql/data' : '/data' },
    ...(postgres ? { env: { POSTGRES_DB: 'app', POSTGRES_PASSWORD: { secret: 'POSTGRES_PASSWORD' } } } : { command: 'redis-server --appendonly yes' }),
  };
  if (config.provider === 'compose' || config.compose) {
    const current = await loadSpec({ cwd, config: existing ? options.config : undefined, env: options.environment });
    if (current.compose.model.services[kind]) throw new Error(`Service ${kind} already exists in the Compose project.`);
    if (Object.values(current.services).some(service => service.port === port)) throw new Error(`Port ${port} already belongs to another service.`);
    const addon = resolve(cwd, 'dev-now.addons.json');
    let model;
    try { model = JSON.parse(await readFile(addon, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; model = { services: {}, volumes: {} }; }
    if (model.services[kind]) throw new Error(`Service ${kind} already exists in dev-now.addons.json.`);
    model.services[kind] = {
      image: service.image, ports: [`${port}:${service.containerPort}`],
      volumes: [`${kind}-data:${service.volumes.data}`],
      healthcheck: { test: ['CMD-SHELL', service.health], interval: '2s', timeout: '2s', retries: 30 },
      ...(postgres ? { environment: { POSTGRES_DB: 'app', POSTGRES_PASSWORD: '${POSTGRES_PASSWORD:?Set POSTGRES_PASSWORD with dev-now env set}' } }
        : { command: ['redis-server', '--appendonly', 'yes'] }),
    };
    model.volumes[`${kind}-data`] = {};
    config.provider = 'compose';
    config.compose ??= {};
    config.compose.files = [...new Set([...(config.compose.files ?? await detectComposeFiles(cwd)), 'dev-now.addons.json'])];
    await writeFile(addon, `${JSON.stringify(model, null, 2)}\n`);
  } else {
    config.services ??= {};
    if (config.services[kind]) throw new Error(`Service ${kind} already exists.`);
    if (Object.values(config.services).some(service => service.port === port)) throw new Error(`Port ${port} already belongs to another service.`);
    config.services[kind] = service;
  }
  if (postgres) {
    const secretOptions = { cwd, environment: options.environment ?? 'default' };
    const values = await readEnvironmentSecrets(secretOptions);
    if (!Object.hasOwn(values, 'POSTGRES_PASSWORD')) await setEnvironmentSecret({ ...secretOptions, key: 'POSTGRES_PASSWORD', fromEnv: 'GENERATED', env: { GENERATED: randomBytes(24).toString('base64url') } });
  }
  await writeFile(filename, `${JSON.stringify(config, null, 2)}\n`);
  return { message: `Added ${kind} on localhost:${port}. Run dev-now up.` };
}
