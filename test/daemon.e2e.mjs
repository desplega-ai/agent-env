import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import https from 'node:https';
import { join } from 'node:path';
import { fixture, requestHttp } from './lifecycle-helpers.mjs';

const test = await fixture('daemon');
try {
  const results = await Promise.all(Array.from({ length: 8 }, () => test.cli(['list'])));
  for (const result of results) assert.deepEqual(result, []);
  const pid = await test.daemonPid();
  assert.equal((await stat(test.home)).mode & 0o777, 0o700);
  const human = await test.invoke(['list']);
  assert.equal(human.stdout.trim(), 'No instances. Run agent-env up.');
  assert.equal(human.stderr, '');
  assert.equal(await test.daemonPid(), pid);
  console.log('PASS: eight concurrent empty lists, one socket owner, and human list output.');

  const tls = await test.cli(['https', '--https-port', '0']);
  assert.ok(tls.port > 0);
  assert.equal(tls.caPath, join(test.home, 'tls', 'ca.pem'));
  const ca = await readFile(tls.caPath);
  const secure = await new Promise((resolveResult, reject) => {
    // Validate the explicit localhost certificate. The HTTP Host selects the unknown route.
    const request = https.get({ hostname: '127.0.0.1', port: tls.port, servername: 'localhost', ca, rejectUnauthorized: true, headers: { host: `unknown.localhost:${tls.port}` } }, async response => {
      try {
        const authorized = response.socket.authorized;
        let body = '';
        for await (const chunk of response) body += chunk;
        resolveResult({ status: response.statusCode, authorized, body });
      } catch (error) { reject(error); }
    });
    request.setTimeout(5000, () => request.destroy(new Error('The HTTPS request timed out.')));
    request.on('error', reject);
  });
  assert.equal(secure.authorized, true);
  assert.equal(secure.status, 404);
  console.log('PASS: standalone HTTPS validates the generated CA and returns 404 for an unknown route.');

  const ui = await test.cli(['ui', '--port', '0']);
  assert.equal(new URL(ui.url).hostname, '127.0.0.1');
  assert.ok(Number(new URL(ui.url).port) > 0);
  const status = await requestHttp(`${ui.url}/api/status`);
  assert.equal(status.status, 200);
  assert.deepEqual(JSON.parse(status.body), { instances: [] });
  for (const [path, type, content] of [['/', /text\/html/, /<script[^>]+src="\/ui.js"/], ['/ui.js', /text\/javascript/, /\/api\/status/], ['/icon.svg', /image\/svg\+xml/, /<svg/]]) {
    const result = await requestHttp(`${ui.url}${path}`);
    assert.equal(result.status, 200, path);
    assert.match(result.headers['content-type'], type);
    assert.match(result.body, content);
    assert.equal(result.headers['x-content-type-options'], 'nosniff');
    assert.match(result.headers['content-security-policy'], /frame-ancestors 'none'/);
  }
  assert.equal((await requestHttp(`${ui.url}/api/status`, { headers: { origin: ui.url } })).status, 200);
  assert.equal((await requestHttp(`${ui.url}/api/status`, { headers: { origin: 'https://attacker.example' } })).status, 403);
  assert.equal(await test.daemonPid(), pid);
  console.log('PASS: ephemeral UI port, empty status, static assets, and cross-origin rejection.');
} finally {
  await test.cleanup();
}
