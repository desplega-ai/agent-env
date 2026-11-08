import assert from 'node:assert/strict';
import http from 'node:http';

const instance = process.env.AGENT_SWARM_INSTANCE ?? 'swarm-example';
const apiKey = process.env.AGENT_SWARM_API_KEY;
assert.ok(apiKey, 'Provide a test-only AGENT_SWARM_API_KEY.');
const readOnly = process.argv.includes('--read-only');
const path = '/api/kv/_/agent-env-example/persistence';
const value = 'agent-env-local-persistence-check';

function request(port, path, { method = 'GET', authenticated = false, body, named = true } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1', port, path, method,
      headers: {
        host: `${named ? `${instance}.localhost` : 'localhost'}:${port}`,
        ...(authenticated ? { authorization: `Bearer ${apiKey}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
    }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, text, headers: response.headers }));
    });
    req.setTimeout(15000, () => req.destroy(new Error('The local HTTP request timed out.')));
    req.on('error', reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

for (const named of [true, false]) {
  const health = await request(4313, '/health', { named });
  assert.equal(health.status, 200, 'The API health request must succeed.');
  assert.equal(JSON.parse(health.text).status, 'ok');
}
assert.equal((await request(4313, path)).status, 401, 'The API must require authentication.');
if (!readOnly) {
  const write = await request(4313, path, { method: 'PUT', authenticated: true, body: { value } });
  assert.equal(write.status, 200, 'The API write must succeed.');
  assert.equal(JSON.parse(write.text).value, value);
}
for (const port of [4313, 4574]) {
  const read = await request(port, path, { authenticated: true });
  assert.equal(read.status, 200, 'The direct or proxied API read must succeed.');
  assert.equal(JSON.parse(read.text).value, value);
}
const ui = await request(4574, '/');
assert.equal(ui.status, 200, 'The dashboard document must load.');
assert.match(ui.text, /\/src\/main\.tsx/);
const module = await request(4574, '/src/main.tsx');
assert.equal(module.status, 200, 'Vite must transform the real application entry.');
assert.match(module.headers['content-type'], /javascript/);
assert.equal((await request(4574, '/health')).status, 200, 'The dashboard proxy must reach the API.');
console.log(`PASS: ${readOnly ? 'retained KV value' : 'KV write/read'}, authentication, named and selected localhost API routes, dashboard HTML, transformed entry, and dashboard API proxy.`);
