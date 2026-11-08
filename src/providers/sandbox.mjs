import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DockerProvider } from './docker.mjs';

export const SANDBOX_OPERATIONS = Object.freeze(['create', 'start', 'wait', 'connect', 'stop', 'remove', 'status', 'sync', 'logs', 'exec', 'fork']);
export const SANDBOX_CAPABILITIES = Object.freeze([...SANDBOX_OPERATIONS, 'compose', 'snapshots']);
const required = ['create', 'wait', 'connect', 'status'];

export function validateSandboxAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object' || !adapter.capabilities || typeof adapter.capabilities !== 'object') {
    throw new Error('Sandbox adapter must declare explicit capabilities.');
  }
  for (const capability of SANDBOX_CAPABILITIES) {
    if (typeof adapter.capabilities[capability] !== 'boolean') throw new Error(`Sandbox adapter must declare capability ${capability} as a boolean.`);
    if (SANDBOX_OPERATIONS.includes(capability) && adapter.capabilities[capability] && typeof adapter[capability] !== 'function') {
      throw new Error(`Sandbox adapter declares ${capability} but has no ${capability} method.`);
    }
  }
  for (const capability of required) {
    if (!adapter.capabilities[capability]) throw new Error(`Sandbox adapter requires capability ${capability}.`);
  }
  return adapter;
}

export function requireSandboxCapabilities(adapter, spec) {
  const requested = spec.sandbox?.requireCapabilities ?? [];
  if (!Array.isArray(requested) || requested.some(value => typeof value !== 'string')) throw new Error('Sandbox requireCapabilities must be an array of capability names.');
  for (const capability of [...requested, ...(spec.compose ? ['compose'] : [])]) {
    if (!SANDBOX_CAPABILITIES.includes(capability)) throw new Error(`Unknown sandbox capability ${capability}.`);
    if (!adapter.capabilities[capability]) throw new Error(`Sandbox adapter does not support ${capability}.`);
  }
}

// This bridge uses the existing container lifecycle and transport implementation.
export function createDockerSandboxAdapter(provider = new DockerProvider()) {
  const adapter = {
    capabilities: Object.freeze(Object.fromEntries(SANDBOX_CAPABILITIES.map(name => [name, SANDBOX_OPERATIONS.includes(name)]))),
    dispose: () => provider.dispose?.(),
  };
  for (const method of SANDBOX_OPERATIONS) adapter[method] = (...args) => provider[method](...args);
  return adapter;
}

function adapterLocation(spec) {
  const value = spec.sandbox?.adapter;
  if (value === 'docker') return 'docker';
  if (typeof value !== 'string' || !value) throw new Error('Set sandbox.adapter to docker or a local ESM module path.');
  if (value.startsWith('file:')) {
    const url = new URL(value);
    if (url.search || url.hash || url.host) throw new Error('Sandbox adapter must use a local file URL without query or fragment.');
    return pathToFileURL(fileURLToPath(url)).href;
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) throw new Error('Sandbox adapter must use a local ESM module.');
  if (!isAbsolute(value) && !isAbsolute(spec.cwd ?? '')) throw new Error('Relative sandbox adapters require an absolute spec.cwd.');
  return pathToFileURL(resolve(spec.cwd ?? '.', value)).href;
}

function serializableHandle(handle) {
  if (!handle || typeof handle !== 'object' || !handle.spec || !handle.services || typeof handle.services !== 'object' || Array.isArray(handle.services)) {
    throw new Error('Sandbox adapter must return a handle with spec and services.');
  }
  const seen = new Set();
  const visit = value => {
    if (value === null || ['string', 'boolean'].includes(typeof value)) return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value !== 'object' || seen.has(value) || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) {
      throw new Error('Sandbox adapter handle must contain only JSON values.');
    }
    seen.add(value);
    for (const item of Object.values(value)) visit(item);
    seen.delete(value);
  };
  visit(handle);
  for (const service of Object.values(handle.services)) {
    if (!Number.isInteger(service?.port) || service.port < 1 || service.port > 65535 || !['http', 'tcp'].includes(service.protocol)) {
      throw new Error('Sandbox services must declare a valid public port and protocol.');
    }
  }
  return handle;
}

export class SandboxProvider {
  constructor({ dockerProvider, load = specifier => import(specifier) } = {}) {
    this.dockerProvider = dockerProvider;
    this.load = load;
    this.adapters = new Map();
  }
  async adapterFor(spec) {
    const location = adapterLocation(spec);
    const options = spec.sandbox?.options ?? {};
    if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Sandbox options must be an object.');
    const key = JSON.stringify([location, options]);
    if (!this.adapters.has(key)) {
      const pending = (async () => {
        if (location === 'docker') return validateSandboxAdapter(createDockerSandboxAdapter(this.dockerProvider));
        const module = await this.load(location);
        if (typeof module.createAdapter !== 'function') throw new Error('Sandbox ESM module must export createAdapter(options).');
        return validateSandboxAdapter(await module.createAdapter(options));
      })();
      this.adapters.set(key, pending);
      pending.catch(() => { if (this.adapters.get(key) === pending) this.adapters.delete(key); });
    }
    const adapter = await this.adapters.get(key);
    requireSandboxCapabilities(adapter, spec);
    return { adapter, location };
  }
  async capabilities(spec) { return { ...(await this.adapterFor(spec)).adapter.capabilities }; }
  async invoke(operation, spec, args) {
    const { adapter } = await this.adapterFor(spec);
    if (!adapter.capabilities[operation]) throw new Error(`Sandbox adapter does not support ${operation}.`);
    return adapter[operation](...args);
  }
  async wrap(spec, runtime, location) {
    serializableHandle(runtime);
    return { spec, services: runtime.services, sandbox: { adapter: location }, runtime };
  }
  async create(spec) {
    const { adapter, location } = await this.adapterFor(spec);
    const runtime = await adapter.create(spec);
    try { return await this.wrap(spec, runtime, location); }
    catch (error) {
      // An adapter must also clean partial allocation when create itself rejects.
      if (adapter.capabilities.remove) await Promise.resolve().then(() => adapter.remove(runtime, true)).catch(() => {});
      throw error;
    }
  }
  async validateHandle(handle) {
    serializableHandle(handle.runtime);
    const { adapter, location } = await this.adapterFor(handle.spec);
    if (handle.sandbox?.adapter !== location) throw new Error('Sandbox handle adapter does not match its specification.');
    if (handle.runtime.spec.owner !== handle.spec.owner || handle.runtime.spec.name !== handle.spec.name) throw new Error('Sandbox runtime belongs to a different instance.');
    return { adapter, location };
  }
  async operation(operation, handle, ...args) {
    await this.validateHandle(handle);
    const result = await this.invoke(operation, handle.spec, [handle.runtime, ...args]);
    serializableHandle(handle.runtime);
    handle.services = handle.runtime.services;
    return result;
  }
  start(handle) { return this.operation('start', handle); }
  wait(handle) { return this.operation('wait', handle); }
  connect(handle) { return this.operation('connect', handle); }
  stop(handle) { return this.operation('stop', handle); }
  remove(handle, purge = false) { return this.operation('remove', handle, purge); }
  status(handle) { return this.operation('status', handle); }
  sync(handle) { return this.operation('sync', handle); }
  logs(handle, service) { return this.operation('logs', handle, service); }
  exec(handle, service, argv) { return this.operation('exec', handle, service, argv); }
  async fork(handle, destinationSpec) {
    const source = await this.validateHandle(handle);
    const destination = await this.adapterFor(destinationSpec);
    if (source.adapter !== destination.adapter) throw new Error('Sandbox fork requires the same adapter and options.');
    if (!source.adapter.capabilities.fork) throw new Error('Sandbox adapter does not support fork.');
    const runtime = await this.invoke('fork', handle.spec, [handle.runtime, destinationSpec]);
    try { return await this.wrap(destinationSpec, runtime, destination.location); }
    catch (error) {
      if (source.adapter.capabilities.remove) await Promise.resolve().then(() => source.adapter.remove(runtime, true)).catch(() => {});
      throw error;
    }
  }
  async dispose() {
    const adapters = await Promise.allSettled(this.adapters.values());
    this.adapters.clear();
    const results = await Promise.allSettled(adapters.filter(item => item.status === 'fulfilled').map(item => Promise.resolve().then(() => item.value.dispose?.())));
    const errors = results.filter(item => item.status === 'rejected').map(item => item.reason);
    if (errors.length) throw new AggregateError(errors, 'Sandbox adapter disposal failed.');
  }
}
