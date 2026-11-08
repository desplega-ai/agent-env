import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import { connect as connectTls } from 'node:tls';
import { once } from 'node:events';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ensureTls } from '../src/tls.mjs';
import { createProxy } from '../src/proxy.mjs';
import { startUi } from '../src/ui.mjs';
import { watchSource, shouldSync } from '../src/watch.mjs';
import { RuntimeExtras } from '../src/runtime.mjs';
import { run } from '../src/system.mjs';
import { createPrivateKey, X509Certificate } from 'node:crypto';

test('concurrent TLS processes preserve one matching CA and restrict its signing scope', async t => {
  const directory = await mkdtemp('/tmp/dev-now-tls-race-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const module = new URL('../src/tls.mjs', import.meta.url).href;
  await Promise.all(Array.from({ length: 4 }, (_, index) => run(process.execPath, ['--input-type=module', '-e', `import {ensureTls} from ${JSON.stringify(module)}; await ensureTls(${JSON.stringify(directory)}, ['host${index}.localhost']);`])));
  const result = await ensureTls(directory, ['final.localhost']);
  const authority = new X509Certificate(await readFile(result.caPath));
  assert.equal(authority.checkPrivateKey(createPrivateKey(await readFile(join(directory, 'ca.key')))), true);
  assert.equal(new X509Certificate(result.cert).verify(authority.publicKey), true);
  assert.equal(new X509Certificate(result.cert).checkPrivateKey(createPrivateKey(result.key)), true);
  await writeFile(join(directory, 'outside.cnf'), '[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=outside.example\n[leaf]\nsubjectAltName=DNS:outside.example\n');
  await run('openssl', ['req', '-new', '-key', join(directory, 'server.key'), '-out', join(directory, 'outside.csr'), '-config', join(directory, 'outside.cnf')]);
  await run('openssl', ['x509', '-req', '-in', join(directory, 'outside.csr'), '-CA', result.caPath, '-CAkey', join(directory, 'ca.key'), '-out', join(directory, 'outside.pem'), '-days', '1', '-extfile', join(directory, 'outside.cnf'), '-extensions', 'leaf']);
  await assert.rejects(run('openssl', ['verify', '-CAfile', result.caPath, join(directory, 'outside.pem')]), /permitted subtree violation/);
});

test('HTTPS refuses colliding instance and service aliases', () => {
  const instances = {
    app: { running: true, services: { web: { protocol: 'http', port: 3000 }, admin: { protocol: 'http', port: 3001 } } },
    'app--admin': { running: true, services: { web: { protocol: 'http', port: 3000 } } },
  };
  const extras = new RuntimeExtras({ instances: () => instances, connections: () => new Map([
    ['app', [{ name: 'web', backendPort: 1 }, { name: 'admin', backendPort: 2 }]],
    ['app--admin', [{ name: 'web', backendPort: 3 }]],
  ]) });
  assert.throws(() => extras.routes(), /ambiguous/);
});

test('HTTPS validates the private CA and serves HTTP/1.1 and HTTP/2', async t => {
  const directory = await mkdtemp('/tmp/dev-now-tls-');
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tls = await ensureTls(directory, ['demo.localhost']);
  const backend = http.createServer((req, res) => res.end(req.url === '/origin' ? JSON.stringify({ host: req.headers.host, origin: req.headers.origin }) : req.headers['x-forwarded-proto']));
  backend.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.pipe(socket);
  });
  backend.listen(0, '127.0.0.1'); await once(backend, 'listening');
  const proxy = createProxy(8443, () => ({ targets: new Map([['demo', { backendPort: backend.address().port, publicPort: 3000 }]]), selected: 'demo' }), { tls });
  proxy.server.listen(0, '127.0.0.1'); await once(proxy.server, 'listening');
  t.after(async () => { await proxy.close(); backend.closeAllConnections(); backend.close(); });
  const port = proxy.server.address().port;
  const ca = await readFile(tls.caPath);
  const body = await new Promise((resolve, reject) => https.get({ host: '127.0.0.1', port, servername: 'demo.localhost', ca, headers: { host: `demo.localhost:${port}` } }, async res => { let body = ''; for await (const part of res) body += part; resolve(body); }).on('error', reject));
  assert.equal(body, 'https');
  const origin = await new Promise((resolve, reject) => https.get({ host: '127.0.0.1', port, path: '/origin', servername: 'demo.localhost', ca, headers: { host: `demo.localhost:${port}`, origin: `https://demo.localhost:${port}` } }, async res => {
    let body = ''; for await (const part of res) body += part; resolve(JSON.parse(body));
  }).on('error', reject));
  assert.deepEqual(origin, { host: 'localhost:3000', origin: 'https://localhost:3000' });
  const session = http2.connect(`https://127.0.0.1:${port}`, { ca, servername: 'demo.localhost' });
  t.after(() => session.destroy());
  const request = session.request({ ':path': '/', ':authority': `demo.localhost:${port}` });
  let content = ''; for await (const part of request) content += part;
  assert.equal(content, 'https');
  session.close();
  const socket = connectTls({ host: '127.0.0.1', port, servername: 'demo.localhost', ca, ALPNProtocols: ['http/1.1'] });
  t.after(() => socket.destroy());
  socket.setTimeout(2000, () => socket.destroy(new Error('The secure upgrade timed out.')));
  await once(socket, 'secureConnect');
  socket.write(`GET /socket HTTP/1.1\r\nHost: demo.localhost:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
  const [handshake] = await once(socket, 'data');
  assert.match(handshake.toString(), /101 Switching Protocols/);
  socket.write('secure socket bytes');
  const [echo] = await once(socket, 'data');
  assert.equal(echo.toString(), 'secure socket bytes');
  socket.destroy();
});

test('dashboard denies foreign hosts, origins, and mutations', async t => {
  const ui = await startUi({ port: 0, status: async () => [], logs: async () => 'hello' });
  t.after(() => ui.close());
  assert.match(await (await fetch(ui.url)).text(), /Your development environments/);
  assert.deepEqual(await (await fetch(`${ui.url}/api/status`)).json(), { instances: [] });
  assert.equal((await fetch(`${ui.url}/api/status`, { headers: { origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await fetch(ui.url, { method: 'POST' })).status, 405);
});

test('watcher debounces source edits and excludes credentials and generated paths', async t => {
  assert.equal(shouldSync('apps/web/node_modules/x'), false);
  assert.equal(shouldSync('apps/api/.env.local'), false);
  const directory = await mkdtemp('/tmp/dev-now-watch-');
  let count = 0;
  const stop = watchSource(directory, { changed() { count++; }, debounceMs: 150 });
  t.after(async () => { stop(); await rm(directory, { recursive: true, force: true }); });
  await writeFile(join(directory, '.env'), 'ignored');
  await new Promise(resolve => setTimeout(resolve, 300));
  assert.equal(count, 0);
  await writeFile(join(directory, 'app.js'), 'first');
  await writeFile(join(directory, 'app.js'), 'second');
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(count, 1);
});
