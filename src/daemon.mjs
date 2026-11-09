import http from 'node:http';
import { readFile, mkdir, chmod, mkdtemp, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { snapshotInstance, restoreSnapshot, disposeRestoredVolumes } from './snapshots.mjs';
import { createWorktree, removeOwnedWorktree } from './worktrees.mjs';
import { hostname } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { home, socketPath, statePath } from './paths.mjs';
import { hash, validName, validate } from './config.mjs';
import { providerFor, disposeProviders } from './providers/index.mjs';
import { RuntimeExtras, redact } from './runtime.mjs';
import { prepareCloud, sleepCloud, destroyCloud, commitCloud, disposeFailedCloud, cloudOptions } from './cloud.mjs';
import { createProxy, createTcpProxy } from './proxy.mjs';
import { cloudPeers, cloudCanSleep, maintainInstances, expireCloudMachine } from './maintenance.mjs';
import { checkLocalRuntime } from './prerequisites.mjs';
import { projectCommand } from './commands.mjs';
import { durableJson } from './allocation-command.mjs';
import { acceptUncertainAllocation } from './providers/recovery.mjs';

await mkdir(home, { recursive: true, mode: 0o700 });
await chmod(home, 0o700);
let state;
try { state = JSON.parse(await readFile(statePath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; state = { instances: {}, focus: {} }; }
const routes = new Map();
const connections = new Map();
const errors = new Map();
const owner = state.owner ?? hash(`${hostname()}:${home}`);
state.owner = owner;
const syncPending = new Set();
const retries = new Map();
const activeCommands = new Map();
function activity(name) { if (state.instances[name]) state.instances[name].lastActivity = Date.now(); }
const extras = new RuntimeExtras({
  instances: () => state.instances, connections: () => connections, activity,
  changed: name => {
    if (syncPending.has(name)) return;
    syncPending.add(name);
    enqueue(async () => {
      syncPending.delete(name);
      const handle = state.instances[name];
      if (!handle?.running) return;
      try { await action({ type: 'sync', name }); handle.syncError = null; }
      catch (error) { handle.syncError = redact(handle, error.message); }
    }).catch(error => errors.set(name, error.message));
  },
  status: () => enqueue(() => action({ type: 'list' })),
  logs: async (name, service) => {
    try { return (await enqueue(() => action({ type: 'logs', name, service }))).output; }
    catch (error) { throw new Error(redact(state.instances[name], error.message)); }
  },
});
async function save() {
  await durableJson(statePath, state);
}
async function reserve(spec) {
  for (const service of Object.values(spec.services)) {
    if (!service.port) continue;
    const existing = routes.get(service.port);
    if (existing) {
      if (existing.protocol !== service.protocol) throw new Error(`Port ${service.port} already uses ${existing.protocol}.`);
      continue;
    }
    const route = { protocol: service.protocol, targets: new Map(), selected: state.focus[service.port], listeners: [] };
    routes.set(service.port, route);
    try {
      for (const host of ['127.0.0.1', '::1']) {
        const listener = service.protocol === 'tcp' ? createTcpProxy(() => route, { onRequest: activity }) : createProxy(service.port, () => route, { onRequest: activity });
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
  extras.unwatch(name);
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
    if (!service?.port) continue;
    const route = routes.get(service.port);
    route.targets.set(name, { backendPort: connection.backendPort });
    if (!route.selected || !route.targets.has(route.selected)) route.selected = name;
    state.focus[service.port] = route.selected;
  }
  errors.delete(name);
  retries.delete(name);
  extras.watch(handle);
  await extras.refreshCertificates();
}
function instance(name) {
  const handle = Object.hasOwn(state.instances, name) ? state.instances[name] : undefined;
  if (!handle) throw new Error(`Instance ${name} does not exist. Run agent-env list.`);
  return handle;
}
function summary(handle) {
  const primary = Object.keys(handle.services).find(key => handle.services[key].protocol === 'http' && handle.services[key].port);
  const name = handle.spec.name;
  const connected = connections.has(name) && connections.get(name).every(item => !item.child || (item.child.exitCode === null && item.child.signalCode === null && !item.child.killed));
  return {
    worktree: handle.worktree?.cwd,
    name, provider: handle.spec.provider, host: handle.spec.host ?? (handle.spec.provider === 'e2b' ? 'e2b' : 'local'), running: handle.running, connected,
    commands: Object.keys(handle.spec.commands ?? {}),
    environment: handle.spec.environment ?? handle.spec.environmentName,
    sync: handle.spec.host || handle.spec.provider === 'e2b' ? handle.syncError ?? (handle.spec.watch === false ? 'manual' : 'watching') : 'local files',
    cloud: handle.spec.cloud ? { serverId: handle.spec.cloud.serverId, expiresAt: handle.spec.cloud.expiresAt, sleeping: !!handle.sleeping } : undefined,
    recovery: handle.pending ? 'required' : undefined,
    error: redact(handle, errors.get(name) ?? (handle.pending ? `Startup interrupted. Run agent-env up ${name} to recover or agent-env rm ${name} --purge to remove owned resources.` : undefined)),
    services: Object.fromEntries(Object.entries(handle.services).map(([key, service]) => [key, {
      internal: !!service.internal,
      port: service.port, protocol: service.protocol,
      httpsUrl: service.protocol === 'http' && service.port ? extras.httpsUrl(name, key, primary) : undefined,
      url: !service.port ? null : service.protocol === 'http' ? `http://${name}.localhost:${service.port}` : `tcp://localhost:${service.port}`,
      selected: routes.get(service.port)?.selected === name,
    }])),
  };
}
async function wakeForStorage(handle) {
  if (!handle.sleeping || !handle.spec.cloud) return;
  const prepared = await prepareCloud({ ...handle.spec, name: handle.spec.cloud.name }, handle);
  handle.spec = { ...prepared, name: handle.spec.name };
  for (const peer of cloudPeers(handle, state.instances)) { peer.sleeping = false; peer.spec.cloud = { ...handle.spec.cloud }; }
}
async function sleepUnusedCloud(handle) {
  const cloud = handle.spec.cloud;
  const peers = cloudPeers(handle, state.instances);
  if (!cloudCanSleep(handle, state.instances) || handle.running) return;
  await sleepCloud(handle);
  for (const peer of peers) peer.sleeping = true;
  await save();
}
function storageOptions(message) {
  return { endpointUrl: message.endpoint, region: message.region, awsEnv: message.awsEnv, awsConfig: message.awsConfig, omitUnsupportedMounts: !!message.omitMounts };
}
async function action(message) {
  const { name, type } = message;
  if (message.acceptUncertain && (type !== 'rm' || !name || message.all)) throw new Error('Use --accept-uncertain only with rm and one explicit instance name.');
  if (type === 'resume') {
    const spec = structuredClone(instance(name).spec);
    if (message.startupTimeoutSeconds !== undefined) spec.startupTimeoutSeconds = message.startupTimeoutSeconds;
    return action({ type: 'up', spec });
  }
  if (type === 'expire') {
    const handle = instance(name);
    if (!handle.spec.cloud?.expiresAt || Date.parse(handle.spec.cloud.expiresAt) > Date.now()) throw new Error('This cloud machine has not expired.');
    await expireCloudMachine(handle, { instances: state.instances, destroy: destroyCloud, disconnect, save,
      forget: peer => { errors.delete(peer.spec.name); retries.delete(peer.spec.name); } });
    return { message: 'Expired cloud machine and its instances removed.' };
  }
  if (type === 'up' || type === 'restore') {
    let spec = validate({ ...message.spec, owner });
    const provider = providerFor(spec);
    await checkLocalRuntime(spec);
    let handle = Object.hasOwn(state.instances, spec.name) ? state.instances[spec.name] : undefined;
    const previousHandle = handle;
    if (type === 'restore' && handle) throw new Error('Restore requires a new instance name.');
    if (type === 'restore' && !provider.docker) throw new Error('This provider does not support volume snapshots.');
    let restored;
    const identitySpec = (value, omitEnvironment = false) => {
      const copy = structuredClone(value);
      delete copy.startupTimeoutSeconds;
      delete copy.commands;
      delete copy.storage;
      if (omitEnvironment) {
        delete copy.env; delete copy.envFiles; delete copy.envFile; delete copy.sensitiveValues;
        for (const service of Object.values(copy.services ?? {})) delete service.env;
        if (copy.compose) {
          delete copy.compose.environment;
          for (const service of Object.values(copy.compose.model?.services ?? {})) delete service.environment;
        }
      }
      if (copy.cloud) {
        delete copy.host; delete copy.sshConfig;
        const { idleTimeoutMs, expiresAt, ...identity } = cloudOptions(copy.cloud);
        copy.cloud = identity;
      }
      return copy;
    };
    const changed = handle && !handle.removed && !isDeepStrictEqual(identitySpec(handle.spec), identitySpec(spec));
    const canRecreate = provider.docker || spec.provider === 'e2b' || (spec.provider === 'sandbox' && spec.sandbox?.adapter === 'docker');
    if (changed && (!canRecreate || !isDeepStrictEqual(identitySpec(handle.spec, true), identitySpec(spec, true)))) {
      throw new Error(`Configuration changed for ${spec.name}. Run agent-env rm ${spec.name}, then up. Data remains.`);
    }
    const checkpoint = async pending => {
      pending.pending = true;
      pending.running = false;
      if (handle?.worktree) pending.worktree = handle.worktree;
      state.instances[spec.name] = pending;
      await save();
    };
    try {
      await reserve(spec);
      if (spec.cloud) {
        const cloudName = handle?.spec.cloud?.name ?? spec.name;
        const prepared = await prepareCloud({ ...spec, name: cloudName }, handle);
        spec = { ...prepared, name: spec.name };
        if (handle) handle.spec = spec;
        for (const peer of cloudPeers({ spec }, state.instances)) {
          peer.sleeping = false;
          peer.spec.cloud = { ...spec.cloud };
        }
      }
      if (changed) {
        await disconnect(spec.name);
        await provider.remove(handle, false);
        handle.removed = true;
        delete handle.pending;
        handle.running = false;
        handle.spec = spec;
        await save();
      }
      if (handle?.pending) {
        handle.spec = spec;
        handle = await provider.recover(handle, checkpoint);
        state.instances[spec.name] = handle;
      } else if (handle && !handle.removed) {
        // Keep the public listeners while replacing only this instance's tunnels.
        for (const connection of connections.get(spec.name) ?? []) connection.close();
        connections.delete(spec.name);
        handle.spec = spec;
        await provider.start(handle);
      } else {
        if (type === 'restore') restored = await restoreSnapshot(spec, message.location, provider, storageOptions(message));
        const worktree = handle?.worktree;
        handle = await provider.create(spec, type === 'up' && ['docker', 'compose'].includes(spec.provider) ? checkpoint : undefined);
        if (worktree) handle.worktree = worktree;
        state.instances[spec.name] = handle;
      }
      handle.running = true;
      handle.removed = false;
      handle.sleeping = false;
      activity(handle.spec.name);
      await connect(handle);
      delete handle.pending;
      await save();
      if (spec.cloud) { handle.spec.cloud = await commitCloud(handle); await save(); }
      return { ...summary(handle), ...(restored ? { omittedMounts: restored.manifest.omittedMounts } : {}) };
    } catch (error) {
      errors.set(spec.name, error.message);
      const pending = state.instances[spec.name];
      if (pending?.pending && error.cleanupComplete) {
        if (previousHandle) {
          previousHandle.allocation = pending.allocation;
          state.instances[spec.name] = previousHandle;
        }
        else delete state.instances[spec.name];
        if (handle === pending) handle = previousHandle;
        await save();
      } else if (!handle && pending?.pending) handle = pending;
      if (handle) {
        if (['ALLOCATION_RUNNING', 'ALLOCATION_UNCERTAIN'].includes(error.code)) handle.pending = true;
        await provider.stop(handle).catch(() => {});
        handle.running = false;
        await disconnect(spec.name);
        await save();
      }
      if (!handle && restored) {
        try { await disposeRestoredVolumes(restored, spec, provider); } catch (cleanup) { error.message += ` Volume cleanup failed: ${cleanup.message}`; }
      }
      if (!handle && (spec.cloud?.recordId || error.cloud)) {
        try { await disposeFailedCloud(error.cloud ?? spec); } catch (cleanup) { error.message += ` Cleanup failed: ${cleanup.message}`; }
      }
      await releaseEmpty();
      throw error;
    }
  }
  if (type === 'list') {
    return Promise.all(Object.values(state.instances).map(async handle => ({ ...summary(handle), status: handle.pending ? Object.fromEntries(Object.keys(handle.services).map(key => [key, 'recovery required'])) : handle.removed ? Object.fromEntries(Object.keys(handle.services).map(key => [key, 'data retained'])) : handle.sleeping ? Object.fromEntries(Object.keys(handle.services).map(key => [key, 'sleeping'])) : await providerFor(handle.spec).status(handle) })));
  }
  if (type === 'use') {
    const handle = instance(name);
    if (!summary(handle).connected) throw new Error('This instance has no active connection. Run agent-env up first.');
    for (const service of Object.values(handle.services)) {
      const route = routes.get(service.port);
      if (!route) continue;
      if (route.selected !== name) for (const listener of route.listeners) listener.resetFocus();
      route.selected = name;
      state.focus[service.port] = name;
    }
    await save();
    return summary(handle);
  }
  if (type === 'https') {
    const result = await extras.enableHttps(message.port ?? 8443);
    state.httpsPort = result.port;
    await save();
    return { ...result, message: `HTTPS enabled on port ${result.port}. Trust the CA with agent-env trust.` };
  }
  if (type === 'ui') {
    const result = await extras.enableUi(message.port ?? 4780);
    state.uiPort = Number(new URL(result.url).port);
    await save();
    return result;
  }
  if (type === 'down' || type === 'rm') {
    const handles = message.all ? Object.values(state.instances) : [instance(name)];
    for (const handle of handles) {
      if (state.instances[handle.spec.name] !== handle) continue;
      const provider = providerFor(handle.spec);
      const cloud = handle.spec.cloud;
      if (message.acceptUncertain) {
        if (!handle.allocation || !['docker', 'compose'].includes(handle.spec.provider)) throw new Error('This instance has no Docker or Compose allocation record to acknowledge.');
        await acceptUncertainAllocation(provider, handle);
        handle.pending = true;
        handle.running = false;
        await save();
      }
      const peers = () => cloudPeers(handle, state.instances).filter(other => other !== handle);
      if (type === 'rm' && message.removeWorktree && handle.worktree) await removeOwnedWorktree(handle.worktree, { checkOnly: true, dirty: message.discardWorktree ? 'discard' : undefined });
      if (type === 'rm' && message.purge && cloud?.expiresAt && Date.parse(cloud.expiresAt) <= Date.now()) {
        await action({ type: 'expire', name: handle.spec.name });
        if (message.removeWorktree && handle.worktree) await removeOwnedWorktree(handle.worktree, { dirty: message.discardWorktree ? 'discard' : undefined });
        continue;
      }
      extras.unwatch(handle.spec.name);
      if (type === 'rm' && cloud && message.purge && !peers().length) {
        await disconnect(handle.spec.name);
        await destroyCloud(handle);
      } else {
        if (handle.sleeping && type === 'rm') {
          await wakeForStorage(handle);
        }
        if (!handle.sleeping) {
          if (type === 'rm') { if (!handle.removed || message.purge) await provider.remove(handle, message.purge); }
          else await provider.stop(handle);
        }
        await disconnect(handle.spec.name);
        if (cloudCanSleep(handle, state.instances)) {
          await sleepCloud(handle);
          for (const peer of [handle, ...peers()]) peer.sleeping = true;
        }
      }
      handle.running = false;
      if (type === 'rm' && message.removeWorktree && handle.worktree) {
        await removeOwnedWorktree(handle.worktree, { dirty: message.discardWorktree ? 'discard' : undefined });
        delete handle.worktree;
      }
      if (type === 'rm') {
        if ((cloud || handle.spec.provider === 'e2b') && !message.purge) handle.removed = true;
        else delete state.instances[handle.spec.name];
      }
      await save();
    }
    return { message: type === 'rm' ? (handles.some(handle => handle.removed) ? 'Instance data remains. Use rm --purge to delete retained compute and data.' : 'Instances removed.') : 'Instances stopped. Data remains.' };
  }
  if (type === 'snapshot') {
    const source = instance(name);
    if (source.pending) throw new Error(`Recover interrupted startup with agent-env up ${name} before taking a snapshot.`);
    if (source.running || source.removed) throw new Error('Stop the source containers before a snapshot. Removed containers cannot identify their volumes.');
    const provider = providerFor(source.spec);
    if (!provider.docker) throw new Error('This provider does not support volume snapshots.');
    try {
      await wakeForStorage(source);
      const saved = await snapshotInstance(source, message.location, provider, storageOptions(message));
      return { message: `Saved ${saved.manifest.volumes.length} volumes to ${saved.location}.`, location: saved.location, omittedMounts: saved.manifest.omittedMounts };
    } finally { await sleepUnusedCloud(source); }
  }
  if (type === 'fork') {
    const source = instance(name);
    if (source.pending) throw new Error(`Recover interrupted startup with agent-env up ${name} before creating a fork.`);
    if (['e2b', 'devcontainer'].includes(source.spec.provider)) throw new Error(`Provider ${source.spec.provider} does not support forks.`);
    const destination = validName(message.destination);
    if (Object.hasOwn(state.instances, destination)) throw new Error('The destination instance already exists.');
    if (source.running || source.removed) throw new Error('Stop the source before a fork. The source containers must still exist.');
    const provider = providerFor(source.spec);
    let worktree, temporary, restored, handle;
    let spec = { ...source.spec, name: destination };
    try {
      await wakeForStorage(source);
      const status = await provider.status(source);
      if (Object.values(status).some(value => value !== 'exited' && value !== 'created')) throw new Error('Stop the source before a fork. A running database cannot be copied safely.');
      if (message.worktree || message.branch || message.ref) {
        worktree = await createWorktree(source.spec, destination, { path: message.worktree, branch: message.branch, ref: message.ref });
        spec = provider.relocate ? provider.relocate(spec, worktree.cwd) : { ...spec, cwd: worktree.cwd };
      }
      await reserve(spec);
      if (spec.provider === 'compose') {
        temporary = await mkdtemp(join(home, 'fork-'));
        const location = join(temporary, 'snapshot');
        await snapshotInstance(source, location, provider, storageOptions(message));
        restored = await restoreSnapshot(spec, location, provider);
        handle = await provider.create(spec);
      } else handle = await provider.fork(source, spec);
      if (worktree) handle.worktree = worktree;
      state.instances[destination] = handle;
      handle.running = true;
      activity(destination);
      await connect(handle);
      await save();
      return { ...summary(handle), omittedPaths: worktree?.omittedPaths };
    } catch (error) {
      errors.set(destination, error.message);
      if (handle) {
        await provider.stop(handle).catch(() => {});
        handle.running = false;
        await disconnect(destination);
      } else {
        if (restored) await disposeRestoredVolumes(restored, spec, provider).catch(cleanup => { error.message += ` Volume cleanup failed: ${cleanup.message}`; });
        if (worktree) await removeOwnedWorktree(worktree, { dirty: 'discard' }).catch(cleanup => { error.message += ` Worktree cleanup failed: ${cleanup.message}`; });
      }
      await releaseEmpty();
      await sleepUnusedCloud(source).catch(() => {});
      await save();
      throw error;
    } finally { if (temporary) await rm(temporary, { recursive: true, force: true }); }
  }
  if (['logs', 'sync'].includes(type)) {
    const handle = instance(name);
    const provider = providerFor(handle.spec);
    activity(name);
    if (handle.sleeping) throw new Error('The cloud machine is sleeping. Run agent-env up first.');
    if (type === 'sync') { await provider.sync(handle); return { message: 'Files synchronized.' }; }
    const service = message.service ?? handle.primaryService ?? Object.keys(handle.services)[0];
    if (!handle.services[service]) throw new Error(`Service ${service} does not exist.`);
    const output = await provider.logs(handle, service);
    return { output: redact(handle, output) };
  }
  throw new Error(`Unknown action: ${type}.`);
}
let queue = Promise.resolve();
function enqueue(work) { const pending = queue.then(work); queue = pending.catch(() => {}); return pending; }
function prepareExecution(message) {
  const source = instance(message.name);
  if (!source.running || source.removed || source.sleeping) throw new Error('Start the instance before running a command.');
  // Capture configuration and redaction values before a concurrent lifecycle change.
  const handle = structuredClone(source);
  const provider = providerFor(handle.spec);
  const command = message.type === 'run' ? projectCommand(handle, message.destination, message.service, message.command)
    : { service: message.service ?? handle.primaryService ?? Object.keys(handle.services)[0], argv: message.command };
  if (!handle.services[command.service]) throw new Error(`Service ${command.service} does not exist.`);
  activeCommands.set(source, (activeCommands.get(source) ?? 0) + 1);
  activity(message.name);
  return async () => {
    try { return { output: redact(handle, await provider.exec(handle, command.service, command.argv)) }; }
    catch (error) { error.message = redact(handle, error.message); throw error; }
    finally {
      const count = activeCommands.get(source) - 1;
      if (count) activeCommands.set(source, count); else activeCommands.delete(source);
      if (state.instances[message.name] === source) activity(message.name);
    }
  };
}
let shuttingDown = false;
const control = http.createServer(async (request, response) => {
  let commandMessage;
  try {
    let body = '';
    for await (const part of request) {
      body += part;
      if (body.length > 1024 * 1024) throw new Error('The request is too large.');
    }
    const message = JSON.parse(body);
    commandMessage = message;
    let result;
    if (message.type === 'ping') result = { pid: process.pid };
    else if (message.type === 'shutdown') {
      shuttingDown = true;
      result = { message: 'Routing stopped. Containers remain. Use down to stop containers.' };
      queue = queue.then(async () => { await shutdown(); });
    } else {
      if (shuttingDown) throw new Error('The daemon is stopping.');
      if (['run', 'exec'].includes(message.type)) {
        const execute = await enqueue(() => prepareExecution(message));
        result = await execute();
      } else result = await enqueue(() => action(message));
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(result));
  } catch (error) {
    response.writeHead(400, { 'content-type': 'application/json' });
    if (error.cleanupError) error.message += ` Cleanup needs attention: ${error.cleanupError.message}`;
    if (error.cleanupErrors?.length) error.message += ` Cleanup needs attention: ${error.cleanupErrors.map(item => item.message).join(' ')}`;
    let safeError = redact({ spec: { ...commandMessage?.spec, env: { ...commandMessage?.spec?.env, ...commandMessage?.awsEnv } } }, error.message);
    for (const handle of Object.values(state.instances)) safeError = redact(handle, safeError);
    response.end(JSON.stringify({ error: safeError, exitCode: error.exitCode ?? 1 }));
  }
});
async function shutdown() {
  clearInterval(maintenance);
  try {
    await extras.close();
    for (const opened of connections.values()) for (const item of opened) item.close();
    for (const route of routes.values()) for (const listener of route.listeners) await listener.close();
    await disposeProviders();
  } catch { console.error('Provider cleanup failed during shutdown. Check for remaining provider sessions.'); }
  finally {
    control.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  }
}

for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { shuttingDown = true; queue.finally(shutdown); });
control.listen(socketPath);
await once(control, 'listening');
await chmod(socketPath, 0o600);
queue = (async () => {
  const preferred = { ...state.focus };
  for (const handle of Object.values(state.instances)) {
    if (handle.pending) { handle.running = false; continue; }
    if (!handle.running) continue;
    try { await providerFor(handle.spec).wait(handle); await connect(handle); activity(handle.spec.name); }
    catch (error) {
      if (['ALLOCATION_RUNNING', 'ALLOCATION_UNCERTAIN'].includes(error.code)) { handle.pending = true; handle.running = false; }
      errors.set(handle.spec.name, error.message); await releaseEmpty();
    }
  }
  for (const [port, route] of routes) {
    if (route.targets.has(preferred[port])) route.selected = preferred[port];
    state.focus[port] = route.selected;
  }
  if (state.httpsPort !== undefined) await extras.enableHttps(state.httpsPort);
  if (state.uiPort !== undefined) await extras.enableUi(state.uiPort);
  await save();
})().catch(error => console.error(error.message));

let maintaining = false;
const maintenance = setInterval(() => {
  if (shuttingDown || maintaining) return;
  for (const handle of activeCommands.keys()) if (state.instances[handle.spec.name] === handle) activity(handle.spec.name);
  maintaining = true;
  enqueue(() => maintainInstances({
    instances: state.instances, action, retries, errors, connected: handle => summary(handle).connected,
    reconnect: async handle => {
      for (const connection of connections.get(handle.spec.name) ?? []) connection.close();
      connections.delete(handle.spec.name);
      await providerFor(handle.spec).wait(handle);
      await connect(handle);
      await save();
    },
  })).catch(error => console.error(error.message)).finally(() => { maintaining = false; });
}, 2000);
maintenance.unref();
