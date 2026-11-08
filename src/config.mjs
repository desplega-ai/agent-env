import { readFile, realpath } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { loadEnvironment, resolveEnvironment, stringList } from './environments.mjs';
import { cloudOptions } from './cloud.mjs';

export const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 8);
export function validName(value) {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{0,47}$/.test(value)) throw new Error('Use a name with 1 to 48 lowercase letters, digits, or hyphens. Start with a letter.');
  return value;
}
export function validate(spec) {
  validName(spec.name);
  if (typeof spec.provider !== 'string' || !spec.provider) throw new Error('Specify a provider name.');
  if (spec.host && !/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$/.test(spec.host)) throw new Error('Use an SSH alias or user@host. Configure ports and keys in SSH config.');
  if (spec.provider === 'compose') {
    if (!spec.compose || !stringList(spec.compose.files, 'compose-file').length) throw new Error('Specify at least one Compose file.');
    if (!spec.services || !Object.keys(spec.services).length) throw new Error('Enable at least one Compose service.');
    const ports = new Set();
    for (const [name, service] of Object.entries(spec.services)) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name) || !service.composeService) throw new Error('Compose services require valid names and source service metadata.');
      if (service.internal) continue;
      validName(name);
      if (!Number.isInteger(service.port) || service.port < 1 || service.port > 65535) throw new Error('Compose public ports must be integers between 1 and 65535.');
      if (!Number.isInteger(service.containerPort) || service.containerPort < 1 || service.containerPort > 65535) throw new Error('Container ports must be integers between 1 and 65535.');
      if (!['http', 'tcp'].includes(service.protocol)) throw new Error('The protocol must be http or tcp.');
      if (ports.has(service.port)) throw new Error(`Port ${service.port} appears more than once in this stack.`);
      ports.add(service.port);
    }
    return spec;
  }
  if (!spec.services || !Object.keys(spec.services).length) throw new Error('Define at least one service.');
  const ports = new Set();
  for (const [name, service] of Object.entries(spec.services)) {
    validName(name);
    if (!service.image || typeof service.image !== 'string') throw new Error(`Set an image for ${name}.`);
    service.containerPort ??= service.port;
    service.protocol ??= 'http';
    if (!Number.isInteger(service.port) || service.port < 1024 || service.port > 65535) throw new Error('Public ports must be integers between 1024 and 65535.');
    if (!Number.isInteger(service.containerPort) || service.containerPort < 1 || service.containerPort > 65535) throw new Error('Container ports must be integers between 1 and 65535.');
    if (ports.has(service.port)) throw new Error(`Port ${service.port} appears more than once in this stack.`);
    ports.add(service.port);
    if (!['http', 'tcp'].includes(service.protocol)) throw new Error('The protocol must be http or tcp.');
    if (service.health !== undefined && typeof service.health !== 'string') throw new Error('The health command must be a string.');
    if (service.command !== undefined && typeof service.command !== 'string') throw new Error('The service command must be a string.');
    for (const [key, value] of Object.entries(service.env ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string') throw new Error('Environment variables must have valid names and string values.');
    }
    for (const [volume, target] of Object.entries(service.volumes ?? {})) {
      validName(volume);
      if (typeof target !== 'string' || !target.startsWith('/') || /[:,\n]/.test(target)) throw new Error('Volume destinations must be absolute paths without commas or colons.');
    }
  }
  return spec;
}
// env accepts one name. profile, compose-file, and env-file accept strings or arrays.
export async function loadSpec(options = {}, command = []) {
  const cwd = await realpath(options.cwd ?? process.cwd());
  let config = {};
  try { config = JSON.parse(await readFile(resolve(cwd, options.config ?? 'dev-now.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT' || options.config) throw error; }
  if (options.provider) config.provider = options.provider;
  const names = stringList(options.env, 'env');
  if (names.length > 1) throw new Error('Select one named environment per instance.');
  const environment = names[0] ?? 'default';
  const environmentName = config.environments?.[environment]?.name;
  config = resolveEnvironment(config, environment);
  const base = basename(cwd).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, environment === 'default' ? 30 : 24);
  const suffix = environment === 'default' ? '' : `-${hash(environment)}`;
  const configuredName = environmentName ?? (config.name ? environment === 'default' ? config.name : `${config.name.slice(0, 39)}${suffix}` : undefined);
  const spec = { ...config, cwd, environment, name: options.name ?? configuredName ?? `dev-${base}-${hash(cwd)}${suffix}`, provider: config.provider ?? 'docker' };
  if ([options.ssh, options.local, options.cloud].filter(Boolean).length > 1) throw new Error('Select only one target: --ssh, --local, or --cloud.');
  if (options.ssh) { spec.host = options.ssh; delete spec.cloud; }
  if (options.local) { delete spec.host; delete spec.cloud; delete spec.sshConfig; }
  if (options.cloud) spec.cloud = { ...(typeof spec.cloud === 'object' ? spec.cloud : {}), provider: options.cloud };
  const cloudFlags = ['cloud-type', 'location', 'idle-minutes', 'ttl-hours'];
  if (!spec.cloud && cloudFlags.some(key => options[key] !== undefined)) throw new Error('Cloud options require --cloud hetzner or an explicit cloud provider in configuration.');
  if (spec.cloud) {
    const cloud = typeof spec.cloud === 'string' ? { provider: spec.cloud } : { ...spec.cloud };
    if (options['cloud-type'] !== undefined) cloud.type = options['cloud-type'];
    if (options.location !== undefined) cloud.location = options.location;
    if (options['idle-minutes'] !== undefined) cloud.idleTimeoutMs = Number(options['idle-minutes']) * 60000;
    if (options['ttl-hours'] !== undefined) {
      const expires = Date.now() + Number(options['ttl-hours']) * 3600000;
      if (!Number.isFinite(expires) || expires <= Date.now() || expires > 8640000000000000) throw new Error('TTL hours must be a positive number within the supported date range.');
      cloud.expiresAt = new Date(expires).toISOString();
    }
    spec.cloud = cloudOptions(cloud);
  }
  if (options['ssh-config']) spec.sshConfig = resolve(cwd, options['ssh-config']);
  spec.envFiles = stringList(options['env-file'] ?? config.envFiles ?? config.envFile, 'env-file').map(file => resolve(cwd, file));
  // These values remain in memory and private daemon state. Initialization never writes them.
  spec.sensitiveValues = [];
  spec.env = await loadEnvironment({ cwd, environment, files: spec.envFiles, values: config.env, sensitiveValues: spec.sensitiveValues });
  const { detectComposeFiles, resolveComposeSpec } = await import('./providers/compose.mjs');
  const composeFiles = stringList(options['compose-file'] ?? config.compose?.files ?? config.composeFiles, 'compose-file');
  const detected = !config.provider && !config.services && !command.length ? await detectComposeFiles(cwd) : [];
  if (!command.length && (spec.provider === 'compose' || composeFiles.length || detected.length)) {
    if (config.services) throw new Error('Use Compose override files for service configuration. Use env and compose.routes in dev-now.json.');
    spec.provider = 'compose';
    spec.compose = {
      ...config.compose,
      files: (composeFiles.length ? composeFiles : detected.length ? detected : await detectComposeFiles(cwd)).map(file => resolve(cwd, file)),
      profiles: stringList(options.profile ?? config.compose?.profiles ?? config.profiles, 'profile'),
    };
    return validate(await resolveComposeSpec(spec));
  }
  if (options.profile !== undefined || composeFiles.length) throw new Error('Compose profiles and files require the Compose provider without a command override.');
  if (command.length) {
    spec.provider = 'docker';
    spec.services = { web: { image: options.image ?? 'node:22-bookworm-slim', port: Number(options.port ?? 3000), command: command.map(value => `'${value.replaceAll("'", "'\\''")}'`).join(' '), volumes: { dependencies: '/workspace/node_modules', cache: '/root/.npm' } } };
  }
  for (const service of Object.values(spec.services ?? {})) {
    service.env = { ...spec.env, ...await loadEnvironment({ cwd, environment, values: service.env, includeStored: false, sensitiveValues: spec.sensitiveValues }) };
  }
  spec.sensitiveValues = [...new Set(spec.sensitiveValues)].sort();
  return validate(spec);
}
