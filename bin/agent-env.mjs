#!/usr/bin/env node
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdir, open, unlink, rm, stat, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { trustTls } from '../src/tls.mjs';
import { parseArgs } from 'node:util';
import { home, socketPath } from '../src/paths.mjs';
import { loadSpec } from '../src/config.mjs';
import { initialize } from '../src/init.mjs';
import { addService } from '../src/goodies.mjs';
import { setEnvironmentSecret, listEnvironmentSecrets, unsetEnvironmentSecret } from '../src/environments.mjs';
import { delay } from '../src/system.mjs';
import { skillCommand } from '../src/skill.mjs';
import { checkLocalRuntime } from '../src/prerequisites.mjs';

const help = `agent-env: development services with stable localhost addresses

  agent-env init                       Create agent-env.json
  agent-env skill [install]            Read or install the bundled agent skill
  agent-env add postgres | redis       Add a persistent service
  agent-env up [--ssh user@host]        Start the configured stack
  agent-env up NAME                    Resume the saved instance from any directory
  agent-env up --name demo --port 3000 -- node server.js
  agent-env list                       Show services and addresses
  agent-env ui                         Open the local status dashboard
  agent-env https [--https-port 8443]   Enable local HTTPS
  agent-env trust                      Trust the local certificate authority
  agent-env use NAME                   Select NAME for bare localhost
  agent-env logs NAME [--service web]  Read recent service logs
  agent-env exec NAME [--service db] -- COMMAND [ARGS...]
  agent-env sync NAME                  Copy local changes to an SSH host
  agent-env env set KEY [--from-env VAR] Store a secret from stdin or a variable
  agent-env env list | unset KEY       Manage secret names for --env NAME
  agent-env snapshot NAME LOCATION     Save stopped volumes locally or to S3
  agent-env restore LOCATION --name NAME  Restore into a new instance
  agent-env down NAME | --all          Stop containers and retain data
  agent-env fork SOURCE DEST [--worktree PATH]  Fork stopped data and optional source files
  agent-env rm NAME [--purge]          Remove containers, optionally data
  agent-env daemon stop               Stop routing and retain containers

Options:
  --name NAME, --port PORT, --image IMAGE, --config FILE, --service NAME, --json
  --ssh HOST, --ssh-config FILE, --local, --provider NAME, --adapter FILE
  --cloud hetzner, --cloud-type TYPE, --location LOCATION
  --idle-minutes MINUTES, --ttl-hours HOURS (require a cloud target)
  --env NAME, --env-file FILE, --no-env-file, --from-env VARIABLE
  --version                         Show the installed package version
  --compose-file FILE, --profile NAME (repeat for multiple files or profiles)
  --https, --https-port PORT, --no-watch, --timeout SECONDS (startup, default 60)
  --worktree PATH, --branch BRANCH, --ref REF
  --endpoint URL, --omit-mounts, --all, --purge
  --remove-worktree, --discard-worktree (requires --remove-worktree)

Requires Node 22+ and Docker. SSH targets require Docker, rsync, and Bash.
HTTP supports named hosts and WebSockets. TCP uses the selected instance.
`;
function request(message, timeout = message.type === 'resume' ? (message.startupTimeoutSeconds ?? 3600) * 1000 + 120000 : Math.max(600000, (message.spec?.startupTimeoutSeconds ?? 0) * 1000 + 120000)) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: '/', method: 'POST', headers: { 'content-type': 'application/json' } }, async response => {
      try {
        let body = '';
        for await (const part of response) body += part;
        const result = JSON.parse(body);
        if (result.error) throw Object.assign(new Error(result.error), { exitCode: result.exitCode });
        resolve(result);
      } catch (error) { reject(error); }
    });
    req.setTimeout(timeout, () => req.destroy(new Error('The daemon request timed out. Check agent-env list before retrying.')));
    req.on('error', reject);
    req.end(JSON.stringify(message));
  });
}
async function ensureDaemon() {
  try { await request({ type: 'ping' }, 1000); return; } catch {}
  await mkdir(home, { recursive: true, mode: 0o700 });
  const lock = join(home, 'start.lock');
  let acquired = false;
  const deadline = Date.now() + 15000;
  while (!acquired) {
    try { await mkdir(lock); acquired = true; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try { await request({ type: 'ping' }, 500); return; } catch {}
      const info = await stat(lock).catch(() => null);
      if (info && Date.now() - info.mtimeMs > 20000) { await rm(lock, { recursive: true, force: true }); continue; }
      if (Date.now() > deadline) throw new Error('The daemon startup lock did not clear. Retry after 20 seconds.');
      await delay(100);
    }
  }
  try {
    try { await request({ type: 'ping' }, 500); return; } catch {}
    await unlink(socketPath).catch(error => { if (error.code !== 'ENOENT') throw error; });
    const log = await open(join(home, 'daemon.log'), 'a', 0o600);
    const child = spawn(process.execPath, [fileURLToPath(new URL('../src/daemon.mjs', import.meta.url))], { detached: true, stdio: ['ignore', log.fd, log.fd] });
    child.unref();
    await log.close();
    while (Date.now() < deadline) {
      try { await request({ type: 'ping' }, 500); return; } catch {}
      if (child.exitCode !== null) break;
      await delay(100);
    }
    throw new Error(`The daemon did not start. Read ${join(home, 'daemon.log')}.`);
  } finally { await rm(lock, { recursive: true, force: true }); }
}
function display(result, json) {
  if (json) { console.log(JSON.stringify(result, null, 2)); return; }
  if (Array.isArray(result)) {
    if (!result.length) console.log('No instances. Run agent-env up.');
    for (const item of result) typeof item === 'string' ? console.log(item) : display(item, false);
  } else if (result.url) console.log(result.url);
  else if ('output' in result) console.log(result.output);
  else if (result.message) console.log(result.message);
  else if (result.name) {
    console.log(`${result.name} (${result.host}, ${result.connected ? 'connected' : result.running ? 'disconnected' : 'stopped'})`);
    for (const [name, service] of Object.entries(result.services)) {
      console.log(`  ${name.padEnd(12)} ${service.httpsUrl ?? service.url ?? 'internal'}${service.selected ? '  [localhost selected]' : ''}${result.status ? `  ${result.status[name]}` : ''}`);
    }
    if (result.worktree) console.log(`  Source: ${result.worktree}`);
    if (result.error) console.log(`  ${result.error}`);
  }
  for (const mount of result.omittedMounts ?? []) console.log(`  Omitted ${mount.service}:${mount.target}: ${mount.reason}`);
  for (const path of result.omittedPaths ?? []) console.log(`  Omitted source file: ${path}`);
}
async function main() {
  const args = process.argv.slice(2);
  const separator = args.indexOf('--');
  const command = separator < 0 ? [] : args.splice(separator).slice(1);
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    agent: { type: 'string', multiple: true }, global: { type: 'boolean', short: 'g' }, yes: { type: 'boolean', short: 'y' },
    'env-file': { type: 'string', multiple: true }, 'no-env-file': { type: 'boolean' }, 'from-env': { type: 'string' },
    version: { type: 'boolean', short: 'v' },
    timeout: { type: 'string' },
    'remove-worktree': { type: 'boolean' }, 'discard-worktree': { type: 'boolean' }, 'omit-mounts': { type: 'boolean' },
    cloud: { type: 'string' }, 'cloud-type': { type: 'string' }, location: { type: 'string' }, 'idle-minutes': { type: 'string' }, 'ttl-hours': { type: 'string' },
    provider: { type: 'string' }, adapter: { type: 'string' }, env: { type: 'string' }, profile: { type: 'string', multiple: true }, 'compose-file': { type: 'string', multiple: true },
    https: { type: 'boolean' }, 'https-port': { type: 'string' }, 'no-watch': { type: 'boolean' },
    worktree: { type: 'string' }, branch: { type: 'string' }, ref: { type: 'string' }, endpoint: { type: 'string' },
    name: { type: 'string' }, port: { type: 'string' }, image: { type: 'string' }, ssh: { type: 'string' },
    'ssh-config': { type: 'string' }, local: { type: 'boolean' }, config: { type: 'string' }, service: { type: 'string' },
    json: { type: 'boolean' }, all: { type: 'boolean' }, purge: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  const [type, name, destination] = positionals;
  if (values.version) {
    const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    console.log(values.json ? JSON.stringify({ version }) : version);
    return;
  }
  if (type === 'skill') { await skillCommand(positionals.slice(1), values, command); return; }
  if (!type || values.help || type === 'help') { console.log(help); return; }
  if (type === 'trust') { display(await trustTls(), values.json); return; }
  if (type === 'add') { display(await addService(name, { config: values.config, port: values.port, environment: values.env }), values.json); return; }
  if (type === 'init') {
    const result = await initialize({ config: values.config, command, port: values.port, image: values.image });
    display({ message: `Created ${result.filename}. Run agent-env up.` }, values.json);
    return;
  }
  if (type === 'env') {
    const options = { cwd: process.cwd(), environment: values.env ?? 'default', key: destination };
    if (name === 'list') display(await listEnvironmentSecrets(options), values.json);
    else if (name === 'unset') display({ message: await unsetEnvironmentSecret(options) ? 'Secret removed.' : 'Secret was not set.' }, values.json);
    else if (name === 'set') {
      if (!values['from-env'] && process.stdin.isTTY) throw new Error('Provide the secret through stdin or --from-env VARIABLE.');
      await setEnvironmentSecret({ ...options, ...(values['from-env'] ? { fromEnv: values['from-env'] } : { stdin: process.stdin }) });
      display({ message: `Stored ${destination} for environment ${options.environment}.` }, values.json);
    } else throw new Error('Use env set KEY, env list, or env unset KEY.');
    return;
  }
  if (type === 'daemon' && name === 'stop') {
    const result = await request({ type: 'shutdown' });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try { await request({ type: 'ping' }, 1000); }
      catch (error) {
        if (['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(error.code)) { display(result, values.json); return; }
        throw error;
      }
      await delay(100);
    }
    throw new Error('The daemon is still stopping. Wait for the current operation to finish.');
  }
  if (!['up', 'list', 'use', 'logs', 'exec', 'sync', 'down', 'rm', 'fork', 'ui', 'https', 'snapshot', 'restore'].includes(type)) throw new Error(`Unknown command: ${type}. Run agent-env --help.`);
  if (!['up', 'list', 'ui', 'https', 'restore'].includes(type) && !name && !(values.all && ['down', 'rm'].includes(type))) throw new Error(`Specify an instance name for ${type}.`);
  if (['fork', 'snapshot'].includes(type) && !destination) throw new Error('Specify a destination name.');
  if (type === 'exec' && !command.length) throw new Error('Specify a command after --.');
  if (type === 'restore' && !name) throw new Error('Specify a snapshot directory or S3 URL.');
  if (values['discard-worktree'] && !values['remove-worktree']) throw new Error('Use --discard-worktree with --remove-worktree.');
  const message = { type, name, destination, service: values.service, command, all: values.all, purge: values.purge, worktree: values.worktree ? resolve(values.worktree) : undefined, branch: values.branch, ref: values.ref, endpoint: values.endpoint, removeWorktree: values['remove-worktree'], discardWorktree: values['discard-worktree'], omitMounts: values['omit-mounts'] };
  if (type === 'snapshot' || type === 'restore') {
    const location = type === 'snapshot' ? destination : name;
    message.location = location.startsWith('s3://') ? location : resolve(location);
    message.awsEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_REGION', 'AWS_DEFAULT_REGION', 'AWS_ENDPOINT_URL_S3', 'AWS_SHARED_CREDENTIALS_FILE', 'AWS_CONFIG_FILE', 'AWS_CA_BUNDLE'].includes(key)));
  }
  if (type === 'https') message.port = Number(values['https-port'] ?? 8443);
  if (type === 'ui') message.port = Number(values.port ?? 4780);
  if (type === 'up' && name) {
    if (destination || command.length || Object.keys(values).some(key => !['https', 'https-port', 'json', 'timeout'].includes(key))) throw new Error('Use up NAME without configuration options to resume a saved instance.');
    message.type = 'resume';
    if (values.timeout !== undefined) message.startupTimeoutSeconds = Number(values.timeout);
  } else if (type === 'up' || type === 'restore') {
    message.spec = await loadSpec(values, command);
    if (values.provider) message.spec.provider = values.provider;
    if (values.adapter) message.spec.sandbox = { ...message.spec.sandbox, adapter: values.adapter };
    if (values['no-watch']) message.spec.watch = false;
  }
  if (message.spec) await checkLocalRuntime(message.spec);
  await ensureDaemon();
  if (type === 'up' && !values.json) console.error('Starting services. The first image download can take longer.');
  const result = await request(message);
  if (type === 'up' && values.https) {
    await request({ type: 'https', port: Number(values['https-port'] ?? 8443) });
    display((await request({ type: 'list' })).find(item => item.name === result.name), values.json);
  } else display(result, values.json);
}
main().catch(error => { console.error(`agent-env: ${error.message}`); process.exitCode = error.exitCode ?? 1; });
