import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { createProxy, selectTarget } from '../src/proxy.mjs';

test('routing respects explicit names, focus, page origin, and unknown hosts', () => {
  const targets = new Map([['one', { name: 'one' }], ['two', { name: 'two' }]]);
  const choose = headers => selectTarget({ headers }, targets, 'one');
  assert.equal(choose({ host: 'localhost:3000' }).target.name, 'one');
  assert.equal(choose({ host: 'two.localhost:3000' }).target.name, 'two');
  assert.equal(choose({ host: 'localhost:3000', origin: 'http://two.localhost:4000' }).target.name, 'two');
  assert.equal(choose({ host: 'two.localhost:3000', origin: 'http://one.localhost:3000' }).target.name, 'two');
  assert.equal(choose({ host: 'missing.localhost:3000' }).status, 404);
  assert.equal(choose({ host: 'evil.example' }).status, 403);
  assert.equal(choose({ host: 'localhost.evil.example' }).status, 403);
});

test('proxy preserves request bodies, cookies, streaming responses, and WebSocket upgrades', async t => {
  const backend = http.createServer(async (req, res) => {
    let body = '';
    for await (const part of req) body += part;
    res.writeHead(201, { 'set-cookie': ['session=abc; HttpOnly', 'other=def'], 'content-type': 'application/json' });
    res.write(JSON.stringify({ body, host: req.headers.host, origin: req.headers.origin, path: req.url }));
    res.end();
  });
  backend.on('upgrade', (req, socket, head) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    if (head.length) socket.write(head);
    socket.pipe(socket);
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const targets = new Map([['test', { backendPort: backend.address().port }]]);
  const proxy = createProxy(3000, () => ({ targets, selected: 'test' }));
  proxy.server.listen(0, '127.0.0.1');
  await once(proxy.server, 'listening');
  t.after(async () => { await proxy.close(); backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); });
  const proxyPort = proxy.server.address().port;
  const response = await new Promise((resolve, reject) => {
    const req = http.request(`http://127.0.0.1:${proxyPort}/echo?x=1`, {
      method: 'POST', headers: { host: 'test.localhost:3000', origin: 'http://test.localhost:3000' },
    }, async res => {
      let body = '';
      for await (const part of res) body += part;
      resolve({ status: res.statusCode, headers: res.headers, body });
    });
    req.on('error', reject);
    req.end('payload');
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers['set-cookie'].length, 2);
  assert.deepEqual(JSON.parse(response.body), { body: 'payload', host: 'localhost:3000', origin: 'http://localhost:3000', path: '/echo?x=1' });
  const socket = net.connect(proxyPort, '127.0.0.1');
  t.after(() => socket.destroy());
  socket.setTimeout(2000, () => socket.destroy(new Error('Upgrade timed out.')));
  await once(socket, 'connect');
  socket.write('GET /socket HTTP/1.1\r\nHost: test.localhost:3000\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
  const [handshake] = await once(socket, 'data');
  assert.match(handshake.toString(), /101 Switching Protocols/);
  socket.write('websocket bytes');
  const [echo] = await once(socket, 'data');
  assert.equal(echo.toString(), 'websocket bytes');
  socket.destroy();
});

test('streaming responses arrive before the backend finishes', async t => {
  let finish;
  const backend = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: first\n\n');
    finish = () => res.end('data: last\n\n');
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const proxy = createProxy(3000, () => ({ targets: new Map([['one', { backendPort: backend.address().port }]]), selected: 'one' }));
  proxy.server.listen(0, '127.0.0.1');
  await once(proxy.server, 'listening');
  t.after(async () => { await proxy.close(); backend.closeAllConnections(); backend.close(); });
  const response = await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: proxy.server.address().port, headers: { host: 'one.localhost:3000' } }, resolve).on('error', reject);
  });
  const [first] = await once(response, 'data');
  assert.equal(first.toString(), 'data: first\n\n');
  finish();
  await once(response, 'end');
});

test('a selection change closes focused sockets and preserves named sockets', async t => {
  const backend = http.createServer();
  backend.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    socket.pipe(socket);
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const proxy = createProxy(3000, () => ({ targets: new Map([['one', { backendPort: backend.address().port }]]), selected: 'one' }));
  proxy.server.listen(0, '127.0.0.1');
  await once(proxy.server, 'listening');
  t.after(async () => { await proxy.close(); backend.close(); });
  async function connect(host) {
    const socket = net.connect(proxy.server.address().port, '127.0.0.1');
    t.after(() => socket.destroy());
    socket.setTimeout(2000, () => socket.destroy(new Error('Socket test timed out.')));
    await once(socket, 'connect');
    socket.write(`GET / HTTP/1.1\r\nHost: ${host}:3000\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
    await once(socket, 'data');
    return socket;
  }
  const focused = await connect('localhost');
  const named = await connect('one.localhost');
  const closed = once(focused, 'close');
  proxy.resetFocus();
  await closed;
  named.write('still named');
  const [data] = await once(named, 'data');
  assert.equal(data.toString(), 'still named');
  named.destroy();
});
