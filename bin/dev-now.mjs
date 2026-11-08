#!/usr/bin/env node
import { spawn } from 'node:child_process';
import http from 'node:http';
import { mkdir, open, unlink, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { home, socketPath } from '../src/paths.mjs';
import { loadSpec } from '../src/config.mjs';
import { delay } from '../src/system.mjs';

const help = `dev-now: development services with stable localhost addresses

  dev-now init                       Create dev-now.json
  dev-now up [--ssh user@host]        Start the configured stack
  dev-now up --name demo --port 3000 -- node server.js
  dev-now list                       Show services and addresses
  dev-now use NAME                   Select NAME for bare localhost
  dev-now logs NAME [--service web]  Read recent service logs
  dev-now exec NAME [--service db] -- COMMAND [ARGS...]
  dev-now sync NAME                  Copy local changes to an SSH host
  dev-now down NAME | --all          Stop containers and retain data
  dev-now fork SOURCE DESTINATION    Copy stopped volumes and start a fork
  dev-now rm NAME [--purge]          Remove containers, optionally data
  dev-now daemon stop               Stop routing and retain containers

Options: --name NAME, --port PORT, --image IMAGE, --ssh HOST,
         --ssh-config FILE, --local, --config FILE, --service NAME, --json

Requires Node 22+ and Docker. SSH targets require Docker, rsync, and Bash.
HTTP supports named hosts and WebSockets. TCP uses the selected instance.
`;
function request(message, timeout = 600000) {
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
    req.setTimeout(timeout, () => req.destroy(new Error('The daemon request timed out. Check dev-now list before retrying.')));
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
    if (!result.length) console.log('No instances. Run dev-now up.');
    for (const item of result) display(item, false);
  } else if ('output' in result) console.log(result.output);
  else if (result.message) console.log(result.message);
  else if (result.name) {
    console.log(`${result.name} (${result.host}, ${result.connected ? 'connected' : result.running ? 'disconnected' : 'stopped'})`);
    for (const [name, service] of Object.entries(result.services)) {
      console.log(`  ${name.padEnd(12)} ${service.url}${service.selected ? '  [localhost selected]' : ''}${result.status ? `  ${result.status[name]}` : ''}`);
    }
    if (result.error) console.log(`  ${result.error}`);
  }
}
async function main() {
  const args = process.argv.slice(2);
  const separator = args.indexOf('--');
  const command = separator < 0 ? [] : args.splice(separator).slice(1);
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    name: { type: 'string' }, port: { type: 'string' }, image: { type: 'string' }, ssh: { type: 'string' },
    'ssh-config': { type: 'string' }, local: { type: 'boolean' }, config: { type: 'string' }, service: { type: 'string' },
    json: { type: 'boolean' }, all: { type: 'boolean' }, purge: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  } });
  const [type, name, destination] = positionals;
  if (!type || values.help || type === 'help') { console.log(help); return; }
  if (type === 'init') {
    const config = { services: { web: { image: 'node:22-bookworm-slim', port: 3000, command: 'npm install && npm run dev', volumes: { dependencies: '/workspace/node_modules', cache: '/root/.npm' } } } };
    await writeFile('dev-now.json', `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' });
    console.log('Created dev-now.json. Set your command and bind the server to 0.0.0.0.');
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
  if (!['up', 'list', 'use', 'logs', 'exec', 'sync', 'down', 'rm', 'fork'].includes(type)) throw new Error(`Unknown command: ${type}. Run dev-now --help.`);
  if (!['up', 'list'].includes(type) && !name && !(values.all && ['down', 'rm'].includes(type))) throw new Error(`Specify an instance name for ${type}.`);
  if (type === 'fork' && !destination) throw new Error('Specify a destination name.');
  if (type === 'exec' && !command.length) throw new Error('Specify a command after --.');
  const message = { type, name, destination, service: values.service, command, all: values.all, purge: values.purge };
  if (type === 'up') message.spec = await loadSpec(values, command);
  await ensureDaemon();
  if (type === 'up' && !values.json) console.error('Starting services. The first image download can take longer.');
  display(await request(message), values.json);
}
main().catch(error => { console.error(`dev-now: ${error.message}`); process.exitCode = error.exitCode ?? 1; });
