import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { run, freePort, delay } from '../src/system.mjs';

const root = resolve(import.meta.dirname, '..');
const cwd = await mkdtemp('/tmp/dev-now-runtime-');
const home = join(cwd, '.dev-now');
const port = await freePort(), tlsPort = await freePort();
const host = process.env.DEV_NOW_TEST_SSH;
const options = [...(host ? ['--ssh', host, '--ssh-config', process.env.DEV_NOW_TEST_SSH_CONFIG] : []), ...(process.env.DEV_NOW_TEST_SANDBOX ? ['--provider', 'sandbox', '--adapter', 'docker'] : [])];
const cli = async args => JSON.parse(await run(process.execPath, [join(root, 'bin/dev-now.mjs'), '--json', ...args], { cwd, env: { ...process.env, DEV_NOW_HOME: home } }));
await writeFile(join(cwd, 'dev-now.json'), JSON.stringify({ services: { web: { image: 'busybox:1.37', port, containerPort: 3000, command: 'httpd -f -p 3000 -h /workspace', env: { EXAMPLE_SECRET: 'never-show-this-value' } } } }));
await writeFile(join(cwd, 'index.html'), 'before');
async function readHttp() {
  const response = await fetch(`http://127.0.0.1:${port}`, { headers: { host: `runtime.localhost:${port}` } });
  return response.text();
}
async function until(check, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check().catch(() => false)) return; await delay(250); }
  throw new Error('The runtime condition did not become true.');
}
try {
  const started = await cli(['up', '--name', 'runtime', '--https', '--https-port', String(tlsPort), ...options]);
  assert.equal(started.connected, true);
  const ca = await readFile(join(home, 'tls/ca.pem'));
  const secure = await new Promise((resolve, reject) => https.get({ host: '127.0.0.1', port: tlsPort, ca, servername: 'runtime.localhost', headers: { host: `runtime.localhost:${tlsPort}` } }, async res => {
    let text = ''; for await (const part of res) text += part; resolve(text);
  }).on('error', reject));
  assert.equal(secure, 'before');
  const ui = await cli(['ui', '--port', '0']);
  assert.equal((await (await fetch(`${ui.url}/api/status`)).json()).instances[0].name, 'runtime');
  const secret = await cli(['exec', 'runtime', '--', 'sh', '-c', 'echo "$EXAMPLE_SECRET"']);
  assert.equal(secret.output, '[redacted]');
  await writeFile(join(cwd, 'index.html'), 'after');
  await until(async () => await readHttp() === 'after');
  if (host) {
    const daemon = await new Promise((resolve, reject) => {
      const req = http.request({ socketPath: join(home, 'control.sock'), method: 'POST' }, async res => { let text = ''; for await (const part of res) text += part; resolve(JSON.parse(text)); });
      req.on('error', reject); req.end(JSON.stringify({ type: 'ping' }));
    });
    const lines = (await run('ps', ['-axo', 'pid=,ppid=,command='])).split('\n');
    const tunnels = lines.filter(line => { const parts = line.trim().split(/\s+/); return Number(parts[1]) === daemon.pid && line.includes(' -L ') && line.includes(host); });
    assert.equal(tunnels.length, 1);
    process.kill(Number(tunnels[0].trim().split(/\s+/)[0]), 'SIGKILL');
    await delay(250);
    await until(async () => (await cli(['list']))[0].connected && await readHttp() === 'after');
  }
  await cli(['daemon', 'stop']);
  const restored = await cli(['list']);
  assert.equal(restored[0].services.web.httpsUrl, `https://runtime.localhost:${tlsPort}`);
  assert.equal((await fetch(ui.url)).status, 200);
  console.log(`PASS: ${host ? 'SSH automatic sync and tunnel recovery, ' : ''}HTTPS, dashboard, redaction, and daemon restart.`);
} finally {
  await cli(['rm', '--all', '--purge']);
  await cli(['daemon', 'stop']);
  await rm(cwd, { recursive: true, force: true });
}
