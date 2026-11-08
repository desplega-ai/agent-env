import { redact } from './runtime.mjs';

export function cloudPeers(handle, instances) {
  const recordId = handle.spec.cloud?.recordId;
  return recordId ? Object.values(instances).filter(peer => peer.spec.cloud?.recordId === recordId) : [];
}

export function cloudCanSleep(handle, instances) {
  return !!handle.spec.cloud?.recordId && !cloudPeers(handle, instances).some(peer => peer !== handle && peer.running);
}

export async function maintainInstances({ instances, action, connected, reconnect, retries, errors, now = Date.now }) {
  const started = now();
  for (const handle of Object.values(instances)) {
    const name = handle.spec.name;
    if (instances[name] !== handle) continue;
    const cloud = handle.spec.cloud;
    if (cloud?.expiresAt && Date.parse(cloud.expiresAt) <= started) {
      try { await action({ type: 'rm', name, purge: true }); }
      catch (error) { errors.set(name, redact(handle, error.message)); }
      continue;
    }
    if (!handle.running) continue;
    const lastActivity = Math.max(handle.lastActivity ?? started, ...cloudPeers(handle, instances).map(peer => peer.lastActivity ?? started));
    if (cloud?.idleTimeoutMs && started - lastActivity >= cloud.idleTimeoutMs) {
      try { await action({ type: 'down', name }); }
      catch (error) { errors.set(name, redact(handle, error.message)); }
      continue;
    }
    if (!handle.spec.host || connected(handle)) continue;
    const retry = retries.get(name) ?? { next: 0, count: 0 };
    if (started < retry.next) continue;
    try {
      await reconnect(handle);
      retries.delete(name);
      errors.delete(name);
    } catch (error) {
      retry.count++;
      retry.next = now() + Math.min(60000, 1000 * 2 ** Math.min(retry.count, 6));
      retries.set(name, retry);
      errors.set(name, redact(handle, `Reconnecting: ${error.message}`));
    }
  }
}
