import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { once } from 'node:events';

export async function startUi({ port = 4780, status, logs }) {
  const [html, script, icon] = await Promise.all(['ui.html', 'ui-client.js', '../assets/icon.svg'].map(file => readFile(new URL(file, import.meta.url))));
  const server = http.createServer(async (request, response) => {
    const send = (code, data, type = 'application/json') => {
      response.writeHead(code, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'" });
      response.end(type === 'application/json' ? JSON.stringify(data) : data);
    };
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) return send(403, { error: 'Local access only.' });
    const address = server.address();
    const allowed = new Set([`127.0.0.1:${address.port}`, `localhost:${address.port}`, `[::1]:${address.port}`]);
    if (!allowed.has(request.headers.host)) return send(403, { error: 'Use the local dashboard address.' });
    if (request.headers.origin && ![`http://${request.headers.host}`].includes(request.headers.origin)) return send(403, { error: 'Cross-origin requests are not allowed.' });
    if (request.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'Cross-site requests are not allowed.' });
    if (request.method !== 'GET') return send(405, { error: 'This dashboard is read-only.' });
    const url = new URL(request.url, 'http://localhost');
    try {
      if (url.pathname === '/') return send(200, html, 'text/html');
      if (url.pathname === '/ui.js') return send(200, script, 'text/javascript');
      if (url.pathname === '/icon.svg') return send(200, icon, 'image/svg+xml');
      if (url.pathname === '/api/status') return send(200, { instances: await status() });
      if (url.pathname === '/api/logs') return send(200, { output: await logs(url.searchParams.get('name'), url.searchParams.get('service')) });
      send(404, { error: 'Not found.' });
    } catch (error) { send(400, { error: error.message }); }
  });
  server.listen(port, '127.0.0.1');
  await once(server, 'listening');
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }) };
}
