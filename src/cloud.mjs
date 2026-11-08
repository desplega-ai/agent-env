import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { isIP } from 'node:net';
import { run as systemRun, delay as systemDelay } from './system.mjs';
import { withFileLock } from './locks.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const methods = ['server', 'primary-ip', 'ssh-key'];
const fields = { server: 'serverId', 'primary-ip': 'primaryIpId', 'ssh-key': 'keyId' };
const safeName = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,62}$/.test(value);
const sshQuote = value => `"${String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

export function cloudOptions(value) {
  const options = typeof value === 'string' ? { provider: value } : value;
  if (!options || options.provider !== 'hetzner') throw new Error('Select the cloud provider explicitly: hetzner.');
  const result = { type: 'cx23', location: 'fsn1', image: 'ubuntu-24.04', idleTimeoutMs: 30 * 60 * 1000, ...options, provider: 'hetzner' };
  for (const field of ['type', 'location', 'image']) {
    if (typeof result[field] !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(result[field])) throw new Error(`Cloud ${field} must be a resource name or numeric ID.`);
  }
  if (!Number.isSafeInteger(result.idleTimeoutMs) || result.idleTimeoutMs < 0) throw new Error('Cloud idleTimeoutMs must be a nonnegative integer.');
  if (result.expiresAt != null) {
    if (typeof result.expiresAt !== 'string' || !Number.isFinite(Date.parse(result.expiresAt))) throw new Error('Cloud expiresAt must be an ISO date string.');
    result.expiresAt = new Date(result.expiresAt).toISOString();
  } else result.expiresAt = null;
  return Object.fromEntries(['provider', 'type', 'location', 'image', 'idleTimeoutMs', 'expiresAt'].map(key => [key, result[key]]));
}

// Pin the host key before the first connection. Never accept an unauthenticated scan.
export function cloudInit(hostPrivateKey, hostPublicKey) {
  const script = `set -eu
. /etc/os-release
case "$ID" in ubuntu|debian) ;; *) exit 1 ;; esac
apt-get update
apt-get install -y ca-certificates curl rsync
install -m 0755 -d /etc/apt/keyrings
curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
printf 'Types: deb\\nURIs: https://download.docker.com/linux/%s\\nSuites: %s\\nComponents: stable\\nArchitectures: %s\\nSigned-By: /etc/apt/keyrings/docker.asc\\n' "$ID" "\${UBUNTU_CODENAME:-$VERSION_CODENAME}" "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/docker.sources
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker
`;
  // JSON values are valid YAML values and retain all newlines in the private key.
  return `#cloud-config\nssh_deletekeys: true\nssh_keys:\n  ed25519_private: ${JSON.stringify(hostPrivateKey)}\n  ed25519_public: ${JSON.stringify(hostPublicKey.trim())}\nssh_pwauth: false\ndisable_root: false\nwrite_files:\n  - path: /root/dev-now-bootstrap.sh\n    permissions: '0700'\n    content: ${JSON.stringify(script)}\nruncmd:\n  - [sh, /root/dev-now-bootstrap.sh]\n`;
}

export function createCloudManager({
  home = resolve(process.env.DEV_NOW_HOME ?? join(homedir(), '.local/state/dev-now')),
  run = systemRun, delay = systemDelay, now = Date.now, readinessTimeoutMs = 300000,
} = {}) {
  const root = join(resolve(home), 'cloud');
  if (/[\r\n\0%]/.test(root)) throw new Error('Cloud home cannot contain newlines, null bytes, or SSH percent tokens.');
  const recordKey = identity => {
    if (!safeName(identity?.owner) || !safeName(identity?.name)) throw new Error('Cloud owner and name must be safe resource names.');
    return digest(`${identity.owner}\0${identity.name}`);
  };
  const directory = identity => join(root, recordKey(identity));
  const recordPath = identity => join(directory(identity), 'record.json');
  const labels = record => ({ 'dev-now.owner': record.owner, 'dev-now.instance': record.name, 'dev-now.record': record.recordId });
  const labelArgs = record => Object.entries(labels(record)).flatMap(([key, value]) => ['--label', `${key}=${value}`]);
  const metadata = record => ({
    ...record.options, owner: record.owner, name: record.name, recordId: record.recordId,
    serverId: record.serverId ?? null, keyId: record.keyId ?? null,
    primaryIpIds: record.primaryIpId ? [record.primaryIpId] : [],
    createdAt: record.createdAt, createdForStart: !record.committed,
  });
  const extract = handle => handle?.spec?.cloud ?? handle?.cloud ?? handle;
  async function privateWrite(path, contents) {
    const temporary = `${path}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(contents); await file.sync(); } finally { await file.close(); }
    try { await rename(temporary, path); } finally { await rm(temporary, { force: true }); }
  }
  const save = record => privateWrite(recordPath(record), `${JSON.stringify(record, null, 2)}\n`);
  async function read(identity) {
    try {
      const record = JSON.parse(await readFile(recordPath(identity), 'utf8'));
      if (record.owner !== identity.owner || record.name !== identity.name || record.version !== 1 || !/^[a-f0-9]{32}$/.test(record.recordId)) {
        throw new Error('Cloud ownership record is invalid.');
      }
      return record;
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  async function locked(identity, action) {
    recordKey(identity);
    await mkdir(root, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    const path = join(root, `${recordKey(identity)}.lock`);
    return withFileLock(path, action);
  }

  async function command(binary, args, env) {
    try { return await run(binary, args, { timeout: 120000, killSignal: 'SIGKILL', ...(env ? { env } : {}) }); }
    catch { throw new Error(`${binary} ${binary === 'hcloud' ? args.slice(0, 2).join(' ') : 'command'} failed. Check authentication, connectivity, and resource availability.`); }
  }
  async function authentication(record) {
    if (record && !record.authentication?.fingerprint) throw new Error('This older cloud record has no credential binding. Preserve its local keys and recover its resources in Hetzner.');
    const quiet = { ...process.env, HCLOUD_DEBUG: 'false', HCLOUD_DEBUG_FILE: '' };
    const get = field => command('hcloud', ['config', 'get', field, '--allow-sensitive'], quiet);
    const context = (await get('context')).trim();
    const fixed = { ...quiet, HCLOUD_CONTEXT: context };
    const endpoint = (await command('hcloud', ['config', 'get', 'endpoint'], fixed)).trim();
    const token = (await command('hcloud', ['config', 'get', 'token', '--allow-sensitive'], fixed)).trim();
    if (!token || !endpoint) throw new Error('Configure an authenticated hcloud context before using cloud instances.');
    const binding = { context, endpoint, fingerprint: digest(JSON.stringify([context, endpoint, token])) };
    if (record && record.authentication?.fingerprint !== binding.fingerprint) throw new Error('The hcloud context, endpoint, or credential differs from this cloud record. Restore the original settings. Local keys remain intact.');
    return { binding, env: { ...fixed, HCLOUD_ENDPOINT: endpoint, HCLOUD_TOKEN: token } };
  }
  async function hcloud(record, kind, action, args = [], json = false) {
    const { env } = await authentication(record);
    const output = await command('hcloud', [kind, action, ...args, ...(json ? ['--output', 'json'] : [])], env);
    if (!json) return output;
    try { return JSON.parse(output); } catch { throw new Error(`hcloud ${kind} ${action} returned invalid JSON.`); }
  }
  function verify(record, kind, resource) {
    if (!Number.isSafeInteger(resource.id) || resource.id <= 0 || resource.name !== `${record.resourceName}-${kind}` ||
      Object.entries(labels(record)).some(([key, value]) => resource.labels?.[key] !== value)) {
      throw new Error(`Cloud ownership check failed for ${kind}. No resource was changed.`);
    }
  }
  async function reconcile(record, kind) {
    // Listing also distinguishes absence from API errors and changed ownership labels.
    const resources = await hcloud(record, kind, 'list', [], true);
    if (!Array.isArray(resources)) throw new Error(`hcloud ${kind} list returned invalid resources.`);
    const field = fields[kind];
    const owned = resources.filter(resource => resource.labels?.['dev-now.record'] === record.recordId);
    if (owned.length > 1) throw new Error(`Cloud has multiple ${kind} resources for this record. Refuse automatic changes.`);
    const resource = record[field] ? resources.find(item => item.id === record[field]) : owned[0];
    if (record[field] && owned.some(item => item.id !== record[field])) throw new Error(`Cloud ${kind} ID conflicts with its ownership record.`);
    if (resource) {
      verify(record, kind, resource);
      if (record[field] && record[field] !== resource.id) throw new Error(`Cloud ${kind} ID does not match its ownership record.`);
      if (!record[field]) { record[field] = resource.id; await save(record); }
    }
    return resource ?? null;
  }
  async function loadHandle(handle) {
    const identity = extract(handle);
    const record = await read(identity);
    if (!record || identity.recordId !== record.recordId) throw new Error('No matching cloud ownership record exists.');
    for (const field of ['serverId', 'keyId']) {
      if (identity[field] != null && record[field] != null && identity[field] !== record[field]) throw new Error(`Cloud handle ${field} does not match its ownership record.`);
    }
    if (identity.primaryIpIds?.length && record.primaryIpId && !identity.primaryIpIds.includes(record.primaryIpId)) throw new Error('Cloud handle IP does not match its ownership record.');
    await authentication(record);
    return record;
  }
  async function createResource(record, kind, args) {
    const existing = await reconcile(record, kind);
    if (existing) return existing;
    if (record.attempted[kind]) throw new Error(`Cloud ${kind} creation has an uncertain result or a missing resource. Run dev-now rm ${record.name} --purge before replacement.`);
    // Store intent before the external side effect, including requests with lost responses.
    record.attempted[kind] = true;
    await save(record);
    const result = await hcloud(record, kind, 'create', ['--name', `${record.resourceName}-${kind}`, ...labelArgs(record), ...args], true);
    const resource = result[kind.replaceAll('-', '_')] ?? result;
    verify(record, kind, resource);
    record[fields[kind]] = resource.id;
    await save(record);
    return resource;
  }
  async function keyPair(path) {
    const exists = async name => readFile(name).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    const privateExists = await exists(path);
    const publicExists = await exists(`${path}.pub`);
    if (privateExists !== publicExists) throw new Error('Cloud key pair is incomplete. Dispose the failed start before retry.');
    if (!privateExists) {
      await command('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'dev-now', '-f', path]);
    }
    await chmod(path, 0o600);
    return { privateKey: await readFile(path, 'utf8'), publicKey: await readFile(`${path}.pub`, 'utf8') };
  }
  async function connection(record, server) {
    const address = server.public_net?.ipv4?.ip;
    if (isIP(address ?? '') !== 4) throw new Error('Cloud server has no public IPv4 address.');
    const dir = directory(record);
    const alias = `dev-now-${record.recordId}`;
    const publicKey = (await readFile(join(dir, 'host-key.pub'), 'utf8')).trim().split(/\s+/).slice(0, 2).join(' ');
    await privateWrite(join(dir, 'known_hosts'), `${alias} ${publicKey}\n`);
    const config = join(dir, 'ssh_config');
    await privateWrite(config, `Host ${alias}\n  HostName ${address}\n  User root\n  Port 22\n  IdentityFile ${sshQuote(join(dir, 'identity'))}\n  IdentitiesOnly yes\n  IdentityAgent none\n  PasswordAuthentication no\n  KbdInteractiveAuthentication no\n  BatchMode yes\n  ConnectTimeout 10\n  StrictHostKeyChecking yes\n  HostKeyAlias ${alias}\n  HostKeyAlgorithms ssh-ed25519\n  UserKnownHostsFile ${sshQuote(join(dir, 'known_hosts'))}\n  GlobalKnownHostsFile /dev/null\n  UpdateHostKeys no\n`);
    const deadline = now() + readinessTimeoutMs;
    do {
      try {
        await command('ssh', ['-F', config, '-o', 'ControlMaster=no', '-S', 'none', '--', alias,
          'cloud-init status --wait >/dev/null 2>&1 && docker info >/dev/null 2>&1 && docker compose version >/dev/null 2>&1 && command -v rsync >/dev/null']);
        return { host: alias, sshConfig: config };
      } catch {
        if (now() >= deadline) throw new Error('Cloud SSH readiness failed. Check the pinned host identity and cloud-init installation.');
        await delay(1000);
      }
    } while (true);
  }
  async function prepareCloud(spec, existingHandle) {
    recordKey(spec);
    const supplied = extract(existingHandle ?? (spec.cloud?.recordId ? spec : null));
    return locked(spec, async () => {
      let record = await read(spec);
      if (supplied) {
        const matched = await loadHandle(supplied);
        if (matched.owner !== spec.owner || matched.name !== spec.name) throw new Error('Cloud handle belongs to a different instance.');
        record = matched;
      }
      try {
        const explicit = typeof spec.cloud === 'object' ? spec.cloud : {};
        const options = cloudOptions({ ...record?.options, ...(typeof spec.cloud === 'string' ? { provider: spec.cloud } : explicit) });
        if (record && ['type', 'image', 'location'].some(key => options[key] !== record.options[key])) throw new Error('Cloud machine options differ from the ownership record. Purge before replacement.');
        if (options.expiresAt && Date.parse(options.expiresAt) <= now()) throw new Error('Cloud expiry has elapsed. Destroy or extend this instance before start.');
        const { binding } = await authentication(record);
        if (!record) {
          const recordId = randomUUID().replaceAll('-', '');
          record = { version: 1, owner: spec.owner, name: spec.name, recordId, resourceName: `dn-${recordId}`, createdAt: new Date(now()).toISOString(), options, authentication: binding, attempted: {}, committed: false };
          await mkdir(directory(record), { recursive: true, mode: 0o700 });
          await chmod(directory(record), 0o700);
          await save(record);
        }
        if (record.destroying) throw new Error('Cloud cleanup is incomplete. Retry destroyCloud before start.');
        record.options = options;
        await save(record);
        const dir = directory(record);
        const identity = await keyPair(join(dir, 'identity'));
        const host = await keyPair(join(dir, 'host-key'));
        await privateWrite(join(dir, 'cloud-init.yaml'), cloudInit(host.privateKey, host.publicKey));
        const key = await createResource(record, 'ssh-key', ['--public-key-from-file', join(dir, 'identity.pub')]);
        if (key.public_key?.trim() !== identity.publicKey.trim()) throw new Error('Cloud SSH key does not match the dedicated local key.');
        const ip = await createResource(record, 'primary-ip', ['--type', 'ipv4', '--location', options.location, '--auto-delete=false']);
        let server = await createResource(record, 'server', ['--type', options.type, '--location', options.location, '--image', options.image,
          '--ssh-key', String(key.id), '--primary-ipv4', String(ip.id), '--without-ipv6', '--user-data-from-file', join(dir, 'cloud-init.yaml')]);
        if (server.public_net?.ipv4?.id !== ip.id) throw new Error('Cloud server IP does not match the ownership record.');
        for (let attempt = 0; server?.status === 'off' && attempt < 3; attempt++) {
          try { await hcloud(record, 'server', 'poweron', [String(server.id)]); }
          catch (error) {
            server = await reconcile(record, 'server');
            if (!server || !['off', 'running', 'starting'].includes(server.status) || (server.status === 'off' && attempt === 2)) throw error;
            if (server.status === 'off') await delay(1000 * (attempt + 1));
          }
          server = await reconcile(record, 'server');
        }
        if (!server || !['running', 'starting'].includes(server.status)) throw new Error('Cloud server cannot start from its current state.');
        const ssh = await connection(record, server);
        // Remove the cloud-init copy that contains the private host key after readiness.
        await rm(join(dir, 'cloud-init.yaml'), { force: true });
        return { ...spec, ...ssh, cloud: metadata(record) };
      } catch (error) {
        if (record) error.cloud = metadata(record);
        throw error;
      }
    });
  }
  async function cloudStatus(handle) {
    return locked(extract(handle), async () => {
      const record = await loadHandle(handle);
      const server = await reconcile(record, 'server');
      return { ...metadata(record), status: server?.status ?? 'missing', committed: record.committed, destroying: !!record.destroying };
    });
  }
  async function sleepCloud(handle) {
    return locked(extract(handle), async () => {
      const record = await loadHandle(handle);
      const server = await reconcile(record, 'server');
      if (!server) throw new Error('Cloud server is missing. No resource was changed.');
      if (server.status !== 'off') await hcloud(record, 'server', 'shutdown', ['--wait', '--wait-timeout', '120s', String(server.id)]);
      return { ...metadata(record), status: 'off' };
    });
  }
  async function destroyLocked(record) {
    // Check every stored resource before the first destructive operation.
    const resources = {};
    for (const kind of methods) resources[kind] = await reconcile(record, kind);
    const server = resources.server;
    const ip = resources['primary-ip'];
    if (server && server.public_net?.ipv4?.id !== record.primaryIpId) throw new Error('Cloud server IP differs from the ownership record. Refuse deletion.');
    if (server?.public_net?.ipv6?.id) throw new Error('Cloud server has an untracked IPv6 address. Refuse deletion.');
    if (ip?.assignee_id && ip.assignee_id !== record.serverId) throw new Error('Cloud IP belongs to a different server. Refuse deletion.');
    record.destroying = true;
    await save(record);
    for (const kind of methods) {
      if (resources[kind]) {
        // Recheck ownership immediately before each destructive operation.
        const resource = await reconcile(record, kind);
        if (resource) await hcloud(record, kind, 'delete', [String(resource.id)]);
      }
      delete record[fields[kind]];
      await save(record);
    }
    await rm(directory(record), { recursive: true, force: true });
    return { destroyed: true };
  }
  async function destroyCloud(handle) {
    return locked(extract(handle), async () => destroyLocked(await loadHandle(handle)));
  }
  async function commitCloud(handle) {
    return locked(extract(handle), async () => {
      const record = await loadHandle(handle);
      if (record.destroying || !await reconcile(record, 'server')) throw new Error('Cannot commit missing cloud infrastructure.');
      record.committed = true;
      await save(record);
      return metadata(record);
    });
  }
  async function disposeFailedCloud(handle) {
    return locked(extract(handle), async () => {
      const record = await loadHandle(handle);
      if (record.committed) return { destroyed: false, reason: 'committed' };
      return destroyLocked(record);
    });
  }
  return { prepareCloud, sleepCloud, destroyCloud, cloudStatus, commitCloud, disposeFailedCloud };
}

const manager = createCloudManager();
export const { prepareCloud, sleepCloud, destroyCloud, cloudStatus, commitCloud, disposeFailedCloud } = manager;
