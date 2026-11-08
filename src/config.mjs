import { readFile, realpath } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 8);
export function validName(value) {
  if (!/^[a-z][a-z0-9-]{0,47}$/.test(value)) throw new Error('Use a name with 1 to 48 lowercase letters, digits, or hyphens. Start with a letter.');
  return value;
}
export function validate(spec) {
  validName(spec.name);
  if (typeof spec.provider !== 'string' || !spec.provider) throw new Error('Specify a provider name.');
  if (spec.host && !/^[a-zA-Z0-9_][a-zA-Z0-9_.@-]*$/.test(spec.host)) throw new Error('Use an SSH alias or user@host. Configure ports and keys in SSH config.');
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
export async function loadSpec(options, command) {
  const cwd = await realpath(process.cwd());
  let config = {};
  try { config = JSON.parse(await readFile(resolve(cwd, options.config ?? 'dev-now.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT' || options.config) throw error; }
  const base = basename(cwd).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 30);
  const spec = { ...config, cwd, name: options.name ?? config.name ?? `dev-${base}-${hash(cwd)}`, provider: config.provider ?? 'docker' };
  if (options.ssh) spec.host = options.ssh;
  if (options.local) delete spec.host;
  if (options['ssh-config']) spec.sshConfig = resolve(options['ssh-config']);
  if (command.length) {
    spec.services = { web: { image: options.image ?? 'node:22-bookworm-slim', port: Number(options.port ?? 3000), command: command.map(value => `'${value.replaceAll("'", "'\\''")}'`).join(' '), volumes: { dependencies: '/workspace/node_modules', cache: '/root/.npm' } } };
  }
  return validate(spec);
}
