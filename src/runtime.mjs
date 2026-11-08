import { once } from 'node:events';
import { join } from 'node:path';
import { createProxy } from './proxy.mjs';
import { ensureTls } from './tls.mjs';
import { startUi } from './ui.mjs';
import { watchSource } from './watch.mjs';
import { hash } from './config.mjs';
import { home } from './paths.mjs';
import { redactEnvironment } from './environments.mjs';

export function serviceAlias(name, service, primary) {
  if (service === primary) return name;
  const alias = `${name}--${service}`;
  return alias.length <= 63 ? alias : `${alias.slice(0, 54)}-${hash(alias)}`;
}
export function redact(handle, text) {
  const spec = handle?.spec ?? {};
  const values = [...Object.values(spec.env ?? {}), ...Object.values(spec.compose?.environment ?? {}),
    ...Object.values(spec.services ?? {}).flatMap(service => Object.values(service.env ?? {})),
    ...Object.values(spec.compose?.model?.services ?? {}).flatMap(service => Object.values(service.environment ?? {}))];
  return redactEnvironment(String(text ?? ''), values);
}
export class RuntimeExtras {
  constructor({ instances, connections, changed, status, logs, activity }) {
    Object.assign(this, { instances, connections, changed, status, logs, activity });
    this.watchers = new Map(); this.tls = null; this.ui = null;
  }
  routes() {
    const targets = new Map();
    for (const [name, opened] of this.connections()) {
      const handle = this.instances()[name];
      if (!handle?.running) continue;
      const http = Object.keys(handle.services).filter(key => handle.services[key].protocol === 'http' && handle.services[key].port);
      for (const connection of opened) {
        if (!http.includes(connection.name)) continue;
        const service = handle.services[connection.name];
        const alias = serviceAlias(name, connection.name, http[0]);
        if (targets.has(alias)) throw new Error(`HTTPS name ${alias}.localhost is ambiguous. Rename one instance.`);
        targets.set(alias, { backendPort: connection.backendPort, publicPort: service.port, instance: name });
      }
    }
    return { targets, selected: undefined };
  }
  async enableHttps(port = 8443) {
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Specify a valid HTTPS port.');
    if (this.tls) return { port: this.tls.port, caPath: this.tls.caPath };
    const credentials = await ensureTls(join(home, 'tls'), [...this.routes().targets.keys()].map(name => `${name}.localhost`));
    const proxy = createProxy(port, () => this.routes(), { tls: credentials, onRequest: alias => this.activity(this.routes().targets.get(alias)?.instance) });
    try { proxy.server.listen(port, '127.0.0.1'); await once(proxy.server, 'listening'); }
    catch (error) { throw new Error(`Cannot bind HTTPS port ${port}: ${error.code}. Choose --https-port with an available port.`); }
    this.tls = { ...proxy, port: proxy.server.address().port, caPath: credentials.caPath };
    return { port: this.tls.port, caPath: this.tls.caPath };
  }
  async refreshCertificates() {
    if (!this.tls) return;
    const credentials = await ensureTls(join(home, 'tls'), [...this.routes().targets.keys()].map(name => `${name}.localhost`));
    this.tls.server.setSecureContext(credentials);
  }
  httpsUrl(name, service, primary) {
    return this.tls ? `https://${serviceAlias(name, service, primary)}.localhost:${this.tls.port}` : undefined;
  }
  async enableUi(port = 4780) {
    if (!this.ui) this.ui = await startUi({ port, status: this.status, logs: this.logs });
    return { url: this.ui.url };
  }
  watch(handle) {
    this.unwatch(handle.spec.name);
    if (!handle.spec.host || handle.spec.watch === false || !handle.running) return;
    const name = handle.spec.name;
    try {
      this.watchers.set(name, watchSource(handle.spec.cwd, {
        stateDirectory: home,
        changed: () => this.changed(name),
        error: error => { handle.syncError = error.message; },
      }));
      handle.syncError = null;
    } catch (error) { handle.syncError = error.message; }
  }
  unwatch(name) { this.watchers.get(name)?.(); this.watchers.delete(name); }
  async close() {
    for (const stop of this.watchers.values()) stop();
    this.watchers.clear();
    await this.ui?.close();
    await this.tls?.close();
  }
}
