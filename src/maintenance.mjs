import { redact } from './runtime.mjs';

export function cloudPeers(handle, instances) {
  const recordId = handle.spec.cloud?.recordId;
  return recordId ? Object.values(instances).filter(peer => peer.spec.cloud?.recordId === recordId) : [];
}

export function cloudCanSleep(handle, instances) {
  return !!handle.spec.cloud?.recordId && !cloudPeers(handle, instances).some(peer => peer !== handle && peer.running);
}

export async function expireCloudMachine(handle, { instances, destroy, disconnect, save, forget = () => {} }) {
  const peers = cloudPeers(handle, instances);
  if (!peers.length) throw new Error('No owned cloud machine exists for this instance.');
  for (const peer of peers) await disconnect(peer.spec.name);
  await destroy(handle);
  for (const peer of peers) {
    delete instances[peer.spec.name];
    forget(peer);
  }
  await save();
}

export async function maintainInstances({ instances, action, connected, reconnect, retries, errors, now = Date.now }) {
  const started = now();
  const handled = new Set();
  const attemptLifecycle = async (key, peers, work) => {
    if (handled.has(key)) return;
    handled.add(key);
    const retry = retries.get(key) ?? { next: 0, count: 0 };
    if (started < retry.next) return;
    try {
      await work();
      retries.delete(key);
      for (const peer of peers) errors.delete(peer.spec.name);
    } catch (error) {
      retry.count++;
      retry.next = now() + Math.min(60000, 1000 * 2 ** Math.min(retry.count, 6));
      retries.set(key, retry);
      for (const peer of peers) errors.set(peer.spec.name, redact(peer, error.message));
    }
  };
  for (const handle of Object.values(instances)) {
    const name = handle.spec.name;
    if (instances[name] !== handle) continue;
    const cloud = handle.spec.cloud;
    if (cloud?.expiresAt && Date.parse(cloud.expiresAt) <= started) {
      await attemptLifecycle(`expiry:${cloud.recordId}`, cloudPeers(handle, instances), () => action({ type: 'expire', name }));
      continue;
    }
    if (!handle.running) continue;
    const lastActivity = Math.max(handle.lastActivity ?? started, ...cloudPeers(handle, instances).map(peer => peer.lastActivity ?? started));
    if (cloud?.idleTimeoutMs && started - lastActivity >= cloud.idleTimeoutMs) {
      const peers = cloudPeers(handle, instances);
      await attemptLifecycle(`idle:${cloud.recordId}`, peers, async () => {
        for (const peer of peers) if (peer.running) await action({ type: 'down', name: peer.spec.name });
      });
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
