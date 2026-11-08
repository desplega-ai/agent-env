import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';

function hostname(authority) {
  try { return new URL(`http://${authority}`).hostname.toLowerCase(); }
  catch { return ''; }
}

export function selectTarget(request, targets, selected) {
  const host = hostname(request.headers.host ?? '');
  const bare = ['localhost', '127.0.0.1', '[::1]'].includes(host);
  if (!bare && !host.endsWith('.localhost')) return { status: 403, error: 'Use a localhost address.' };
  let focused = bare;
  let id = bare ? selected : host.slice(0, -'.localhost'.length);
  if (bare) {
    for (const value of [request.headers.origin, request.headers.referer]) {
      try {
        const source = new URL(value).hostname;
        if (source.endsWith('.localhost')) {
          const candidate = source.slice(0, -'.localhost'.length);
          if (targets.has(candidate)) { id = candidate; focused = false; break; }
        }
      } catch { /* The header does not contain a URL. */ }
    }
  }
  const target = targets.get(id);
  return target ? { target, focused, id } : { status: 404, error: 'No running service matches this address. Run dev-now list.' };
}

function headersFor(request, port, id, secure = false) {
  const headers = { ...request.headers, host: `localhost:${port}` };
  for (const key of Object.keys(headers)) if (key.startsWith(':')) delete headers[key];
  if (headers.origin) {
    try {
      const origin = new URL(headers.origin);
      if (origin.hostname === hostname(request.headers.host) || origin.hostname === `${id}.localhost`) {
        if (secure && origin.host === request.headers.host) origin.port = String(port);
        origin.hostname = 'localhost';
        headers.origin = origin.origin;
      }
    } catch { /* Preserve an origin that is not a URL. */ }
  }
  headers['x-forwarded-host'] = request.headers.host;
  headers['x-forwarded-proto'] = secure ? 'https' : 'http';
  headers['x-forwarded-for'] = request.socket.remoteAddress;
  return headers;
}

export function createProxy(port, getRoutes, options = {}) {
  const sockets = new Set();
  const focusedSockets = new Set();
  const handler = (request, response) => {
    request.headers.host ??= request.headers[':authority'];
    const { targets, selected } = getRoutes(request);
    const result = selectTarget(request, targets, selected);
    if (!result.target) {
      response.writeHead(result.status, { 'content-type': 'text/plain' });
      response.end(`${result.error}\n`);
      return;
    }
    options.onRequest?.(result.id);
    if (result.focused) focusedSockets.add(request.socket);
    else focusedSockets.delete(request.socket);
    const upstream = http.request({
      hostname: '127.0.0.1', port: result.target.backendPort,
      method: request.method, path: request.url, headers: headersFor(request, result.target.publicPort ?? port, result.id, !!options.tls),
    }, (incoming) => {
      const headers = { ...incoming.headers };
      if (request.httpVersionMajor === 2) for (const key of ['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade']) delete headers[key];
      response.writeHead(incoming.statusCode, headers);
      incoming.pipe(response);
      incoming.on('error', () => response.destroy());
    });
    upstream.on('error', () => {
      if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' });
      response.end('The service did not answer. Run dev-now logs <name>.\n');
    });
    request.on('aborted', () => upstream.destroy());
    response.on('close', () => upstream.destroy());
    request.pipe(upstream);
  };
  const server = options.tls ? http2.createSecureServer({ ...options.tls, allowHTTP1: true }, handler) : http.createServer(handler);
  server.on('upgrade', (request, socket, head) => {
    const { targets, selected } = getRoutes(request);
    const result = selectTarget(request, targets, selected);
    if (!result.target) {
      socket.end(`HTTP/1.1 ${result.status} Not Found\r\nConnection: close\r\n\r\n`);
      return;
    }
    options.onRequest?.(result.id);
    socket.on('data', () => options.onRequest?.(result.id));
    if (result.focused) focusedSockets.add(socket);
    const upstream = net.connect(result.target.backendPort, '127.0.0.1', () => {
      const headers = headersFor(request, result.target.publicPort ?? port, result.id, !!options.tls);
      upstream.write(`${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`);
      for (const [key, value] of Object.entries(headers)) {
        for (const item of Array.isArray(value) ? value : [value]) {
          if (item !== undefined) upstream.write(`${key}: ${item}\r\n`);
        }
      }
      upstream.write('\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('close', () => socket.destroy());
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => { sockets.delete(socket); focusedSockets.delete(socket); });
  });
  return {
    server,
    resetFocus() { for (const socket of focusedSockets) socket.destroy(); },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}

export function createTcpProxy(getRoutes, options = {}) {
  const sockets = new Set();
  const server = net.createServer(socket => {
    const { targets, selected } = getRoutes();
    const target = targets.get(selected);
    if (!target) { socket.destroy(); return; }
    options.onRequest?.(selected);
    socket.on('data', () => options.onRequest?.(selected));
    const upstream = net.connect(target.backendPort, '127.0.0.1');
    sockets.add(socket);
    socket.on('close', () => { sockets.delete(socket); upstream.destroy(); });
    upstream.on('close', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
    socket.pipe(upstream).pipe(socket);
  });
  return {
    server,
    resetFocus() { for (const socket of sockets) socket.destroy(); },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
