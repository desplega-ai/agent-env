import http from 'node:http';
import { readFile, writeFile, rename, mkdir, chmod } from 'node:fs/promises';
import { once } from 'node:events';
import { hostname } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { home, socketPath, statePath } from './paths.mjs';
import { hash, validName, validate } from './config.mjs';
import { providerFor, disposeProviders } from './providers/index.mjs';
import { createProxy, createTcpProxy } from './proxy.mjs';

await mkdir(home, { recursive: true, mode: 0o700 });
await chmod(home, 0o700);
let state;
try { state = JSON.parse(await readFile(statePath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; state = { instances: {}, focus: {} }; }
const routes = new Map();
const connections = new Map();
const errors = new Map();
const owner = hash(`${hostname()}:${home}`);
async function save() {
  await writeFile(`${statePath}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(`${statePath}.tmp`, statePath);
}
async function reserve(spec) {
  for (const service of Object.values(spec.services)) {
    const existing = routes.get(service.port);
    if (existing) {
      if (existing.protocol !== service.protocol) throw new Error(`Port ${service.port} already uses ${existing.protocol}.`);
      continue;
    }
    const route = { protocol: service.protocol, targets: new Map(), selected: state.focus[service.port], listeners: [] };
    routes.set(service.port, route);
    try {
      for (const host of ['127.0.0.1', '::1']) {
        const listener = service.protocol === 'tcp' ? createTcpProxy(() => route) : createProxy(service.port, () => route);
        try {
          listener.server.listen(service.port, host);
          await once(listener.server, 'listening');
          route.listeners.push(listener);
        } catch (error) {
          if (host === '::1' && ['EAFNOSUPPORT', 'EADDRNOTAVAIL'].includes(error.code)) continue;
          throw new Error(`Cannot bind ${host}:${service.port}: ${error.code}. Stop its owner or choose another port.`);
        }
      }
    } catch (error) { await releaseEmpty(); throw error; }
  }
}
async function releaseEmpty() {
  for (const [port, route] of routes) {
    if (route.targets.size) continue;
    for (const listener of route.listeners) await listener.close();
    routes.delete(port);
  }
}
async function disconnect(name) {
  for (const connection of connections.get(name) ?? []) connection.close();
  connections.delete(name);
  for (const [port, route] of routes) {
    route.targets.delete(name);
    if (route.selected === name) route.selected = route.targets.keys().next().value;
    state.focus[port] = route.selected;
  }
  await releaseEmpty();
}
async function connect(handle) {
  const name = handle.spec.name;
  await reserve(handle.spec);
  const opened = await providerFor(handle.spec).connect(handle);
  connections.set(name, opened);
  for (const connection of opened) {
    const service = handle.services[connection.name];
    const route = routes.get(service.port);
    route.targets.set(name, { backendPort: connection.backendPort });
    if (!route.selected || !route.targets.has(route.selected)) route.selected = name;
    state.focus[service.port] = route.selected;
  }
  errors.delete(name);
}
function instance(name) {
  const handle = Object.hasOwn(state.instances, name) ? state.instances[name] : undefined;
  if (!handle) throw new Error(`Instance ${name} does not exist. Run dev-now list.`);
  return handle;
}
function summary(handle) {
  const name = handle.spec.name;
  const connected = connections.has(name) && connections.get(name).every(item => !item.child || (item.child.exitCode === null && item.child.signalCode === null && !item.child.killed));
  return {
    name, provider: handle.spec.provider, host: handle.spec.host ?? 'local', running: handle.running, connected,
    error: errors.get(name),
    services: Object.fromEntries(Object.entries(handle.services).map(([key, service]) => [key, {
      port: service.port, protocol: service.protocol,
      url: service.protocol === 'http' ? `http://${name}.localhost:${service.port}` : `tcp://localhost:${service.port}`,
      selected: routes.get(service.port)?.selected === name,
    }])),
  };
}
async function action(message) {
  const { name, type } = message;
  if (type === 'up') {
    const spec = validate({ ...message.spec, owner });
    const provider = providerFor(spec);
    let handle = Object.hasOwn(state.instances, spec.name) ? state.instances[spec.name] : undefined;
    if (handle && !isDeepStrictEqual(handle.spec, spec)) {
      throw new Error(`Configuration changed for ${spec.name}. Run dev-now rm ${spec.name}, then up. Volumes remain.`);
    }
    try {
      await reserve(spec);
      if (handle) {
        // Keep the public listeners while replacing only this instance's tunnels.
        for (const connection of connections.get(spec.name) ?? []) connection.close();
        connections.delete(spec.name);
        await provider.start(handle);
      } else {
        handle = await provider.create(spec);
        state.instances[spec.name] = handle;
      }
      handle.running = true;
      await connect(handle);
      await save();
      return summary(handle);
    } catch (error) {
      errors.set(spec.name, error.message);
      if (handle) {
        await provider.stop(handle).catch(() => {});
        handle.running = false;
        await disconnect(spec.name);
        await save();
      }
      await releaseEmpty();
      throw error;
    }
  }
  if (type === 'list') {
    return Promise.all(Object.values(state.instances).map(async handle => ({ ...summary(handle), status: await providerFor(handle.spec).status(handle) })));
  }
  if (type === 'use') {
    const handle = instance(name);
    if (!summary(handle).connected) throw new Error('This instance has no active connection. Run dev-now up first.');
    for (const service of Object.values(handle.services)) {
      const route = routes.get(service.port);
      if (route.selected !== name) for (const listener of route.listeners) listener.resetFocus();
      route.selected = name;
      state.focus[service.port] = name;
    }
    await save();
    return summary(handle);
  }
  if (type === 'down' || type === 'rm') {
    const handles = message.all ? Object.values(state.instances) : [instance(name)];
    for (const handle of handles) {
      const provider = providerFor(handle.spec);
      if (type === 'rm') await provider.remove(handle, message.purge);
      else await provider.stop(handle);
      await disconnect(handle.spec.name);
      handle.running = false;
      if (type === 'rm') delete state.instances[handle.spec.name];
      await save();
    }
    return { message: type === 'rm' ? 'Instances removed.' : 'Instances stopped. Volumes remain.' };
  }
  if (type === 'fork') {
    const source = instance(name);
    const destination = validName(message.destination);
    if (Object.hasOwn(state.instances, destination)) throw new Error('The destination instance already exists.');
    const provider = providerFor(source.spec);
    const status = await provider.status(source);
    if (Object.values(status).some(value => value !== 'exited' && value !== 'created')) throw new Error('Stop the source before a fork. A running database cannot be copied safely.');
    const spec = { ...source.spec, name: destination };
    let handle;
    try {
      await reserve(spec);
      handle = await provider.fork(source, spec);
      state.instances[destination] = handle;
      handle.running = true;
      await connect(handle);
      await save();
      return summary(handle);
    } catch (error) {
      errors.set(destination, error.message);
      if (handle) {
        await provider.stop(handle).catch(() => {});
        handle.running = false;
        await disconnect(destination);
      }
      await releaseEmpty();
      await save();
      throw error;
    }
  }
  if (['logs', 'exec', 'sync'].includes(type)) {
    const handle = instance(name);
    const provider = providerFor(handle.spec);
    if (type === 'sync') { await provider.sync(handle); return { message: 'Files synchronized.' }; }
    const service = message.service ?? Object.keys(handle.services)[0];
    if (!handle.services[service]) throw new Error(`Service ${service} does not exist.`);
    const output = type === 'logs' ? await provider.logs(handle, service) : await provider.exec(handle, service, message.command);
    return { output };
  }
  throw new Error(`Unknown action: ${type}.`);
}
let queue = Promise.resolve();
let shuttingDown = false;
const control = http.createServer(async (request, response) => {
  try {
    let body = '';
    for await (const part of request) {
      body += part;
      if (body.length > 1024 * 1024) throw new Error('The request is too large.');
    }
    const message = JSON.parse(body);
    let result;
    if (message.type === 'ping') result = { pid: process.pid };
    else if (message.type === 'shutdown') {
      shuttingDown = true;
      result = { message: 'Routing stopped. Containers remain. Use down to stop containers.' };
      queue = queue.then(async () => { await shutdown(); });
    } else {
      if (shuttingDown) throw new Error('The daemon is stopping.');
      const work = queue.then(() => action(message));
      queue = work.catch(() => {});
      result = await work;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result));
  } catch (error) {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: error.message, exitCode: error.exitCode ?? 1 }));
  }
});
async function shutdown() {
  for (const opened of connections.values()) for (const item of opened) item.close();
  for (const route of routes.values()) for (const listener of route.listeners) await listener.close();
  await disposeProviders();
  control.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { shuttingDown = true; queue.finally(shutdown); });
control.listen(socketPath);
await once(control, 'listening');
await chmod(socketPath, 0o600);
queue = (async () => {
  const preferred = { ...state.focus };
  for (const handle of Object.values(state.instances)) {
    if (!handle.running) continue;
    try { await providerFor(handle.spec).wait(handle); await connect(handle); }
    catch (error) { errors.set(handle.spec.name, error.message); await releaseEmpty(); }
  }
  for (const [port, route] of routes) {
    if (route.targets.has(preferred[port])) route.selected = preferred[port];
    state.focus[port] = route.selected;
  }
  await save();
})().catch(error => console.error(error.message));
