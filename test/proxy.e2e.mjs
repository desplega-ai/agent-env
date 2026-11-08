import assert from 'node:assert/strict';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { join } from 'node:path';
import { fixture, freePort, targetOptions } from './helpers.mjs';

const test = await fixture('proxy');
const { cwd, cli } = test;
const port = await freePort();
const sockets = new Set();
function request(path, { host = 'alpha.localhost', method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolveResult, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { host: `${host}:${port}`, ...headers } }, async res => {
      try {
        let text = '';
        for await (const part of res) text += part;
        resolveResult({ status: res.statusCode, headers: res.headers, body: text });
      } catch (error) { reject(error); }
    });
    req.setTimeout(5000, () => req.destroy(new Error('The HTTP route timed out.')));
    req.once('error', reject);
    req.end(body);
  });
}
async function websocket(host) {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  sockets.add(socket);
  socket.setTimeout(5000, () => socket.destroy(new Error('The WebSocket route timed out.')));
  await once(socket, 'connect');
  const response = once(socket, 'data');
  socket.write(`GET /socket HTTP/1.1\r\nHost: ${host}:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  assert.match((await response)[0].toString(), /^HTTP\/1.1 101/);
  return socket;
}
try {
  await writeFile(join(cwd, 'server.mjs'), `import http from 'node:http';
import { createHash } from 'node:crypto';
const server = http.createServer(async (req, res) => {
  if (req.url === '/stream') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('first');
    setTimeout(() => res.end('last'), 1000);
    return;
  }
  let body = '';
  for await (const part of req) body += part;
  res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': ['first=1; HttpOnly', 'second=2; SameSite=Lax'] });
  res.end(JSON.stringify({ label: process.env.LABEL, body, cookie: req.headers.cookie, method: req.method }));
});
server.on('upgrade', (req, socket) => {
  const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');
  socket.on('data', () => {
    const payload = Buffer.from(process.env.LABEL);
    socket.write(Buffer.concat([Buffer.from([0x81, payload.length]), payload]));
  });
});
server.listen(3000, '0.0.0.0');
`);
  for (const label of ['alpha', 'beta']) {
    await writeFile(join(cwd, `${label}.json`), JSON.stringify({ services: { web: { image: 'node:22-alpine', port, containerPort: 3000, command: 'node server.mjs', env: { LABEL: label } } } }));
    await cli(['up', '--name', label, '--config', `${label}.json`, '--no-watch', ...targetOptions()]);
  }
  const echoed = await request('/echo', { method: 'POST', headers: { cookie: 'session=real-e2e', 'content-type': 'text/plain' }, body: 'body with spaces and Unicode: café' });
  assert.deepEqual(JSON.parse(echoed.body), { label: 'alpha', body: 'body with spaces and Unicode: café', cookie: 'session=real-e2e', method: 'POST' });
  assert.deepEqual(echoed.headers['set-cookie'], ['first=1; HttpOnly', 'second=2; SameSite=Lax']);
  assert.equal((await request('/', { host: 'attacker.example' })).status, 403);
  assert.equal((await request('/', { host: 'missing.localhost' })).status, 404);
  const focused = await websocket('localhost');
  const named = await websocket('alpha.localhost');
  const closed = once(focused, 'close');
  await cli(['use', 'beta']);
  await closed;
  assert.equal(JSON.parse((await request('/', { host: 'localhost' })).body).label, 'beta');
  const reply = once(named, 'data');
  named.write(Buffer.from([0x81, 0x81, 0, 0, 0, 0, 120]));
  assert.equal((await reply)[0].subarray(2).toString(), 'alpha');
  const streaming = await new Promise((resolveResult, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/stream', headers: { host: `alpha.localhost:${port}` } }, res => {
      const parts = [];
      res.once('data', part => {
        try { assert.equal(part.toString(), 'first'); assert.equal(res.complete, false); }
        catch (error) { reject(error); }
      });
      res.on('data', part => parts.push(part));
      res.once('end', () => resolveResult(Buffer.concat(parts).toString()));
      res.once('error', reject);
    });
    req.setTimeout(5000, () => req.destroy(new Error('The streaming route timed out.')));
    req.once('error', reject);
  });
  assert.equal(streaming, 'firstlast');
  console.log('PASS: real HTTP bodies, cookies, streaming, host rejection, WebSocket upgrades, and selection changes.');
} finally {
  for (const socket of sockets) socket.destroy();
  await test.cleanup();
}
