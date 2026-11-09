import http from 'node:http';
import https from 'node:https';
import { constants } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, lstat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { home } from '../paths.mjs';
import { shouldSync } from '../source-paths.mjs';
import { quote } from '../system.mjs';
import { redactEnvironment, sensitiveValuesForSpec } from '../environments.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const validName = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(value);
const trafficHeader = 'e2b-traffic-access-token';
const reservedPorts = new Set([49983, 49999, 50005]);
const credentialPath = path => path.split('/').some(part =>
  /^(?:\.ssh|\.aws|\.gnupg|\.kube|\.docker|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.envrc|(?:application_default_)?credentials(?:\.json)?|service[-_]account(?:[-_].*)?\.json|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?)$/i.test(part)
  || /\.(?:pem|key|p12|pfx|keystore)$/i.test(part));

// Call this in the CLI process after environment resolution, before daemon IPC.
export function resolveE2BSpec(spec) {
  if (spec.provider !== 'e2b') throw new Error('The E2B resolver requires provider e2b.');
  for (const key of ['host', 'cloud', 'sshConfig', 'compose', 'sandbox', 'image', 'volumes', 'storage']) {
    if (spec[key] !== undefined) throw new Error(`E2B does not support ${key}.`);
  }
  if (!isAbsolute(spec.cwd ?? '') || !validName(spec.name)) throw new Error('E2B requires an absolute checkout path and a valid instance name.');
  if (!object(spec.e2b ?? {})) throw new Error('Set e2b to an object.');
  for (const key of Object.keys(spec.e2b ?? {})) {
    if (!['template', 'timeoutSeconds', 'credentials'].includes(key)) throw new Error('E2B supports template and timeoutSeconds options only.');
  }
  const template = spec.e2b?.template ?? 'base';
  const timeoutSeconds = spec.e2b?.timeoutSeconds ?? 300;
  if (typeof template !== 'string' || !template.trim() || /[\s\0]/.test(template)) throw new Error('Set a valid E2B template name or ID.');
  if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 86400) throw new Error('Set the E2B timeout to 1 through 86400 seconds.');
  const apiKey = spec.env?.E2B_API_KEY ?? spec.e2b?.credentials?.apiKey ?? process.env.E2B_API_KEY;
  if (typeof apiKey !== 'string' || !apiKey || /[\s\0]/.test(apiKey)) throw new Error('Set E2B_API_KEY in the calling CLI environment or resolved environment.');
  const cleanEnv = values => {
    if (!object(values ?? {})) throw new Error('Set environment variables to an object.');
    const result = {};
    for (const [key, value] of Object.entries(values ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0')) throw new Error('Environment variables require valid names and string values.');
      if (key === 'E2B_API_KEY') continue;
      if (/^E2B_/i.test(key)) throw new Error('E2B_ environment names are reserved. Use another name for application variables.');
      if (value.includes(apiKey)) throw new Error('Do not use the E2B credential as a service environment value.');
      result[key] = value;
    }
    return result;
  };
  const env = cleanEnv(spec.env);
  if (!object(spec.services) || !Object.keys(spec.services).length) throw new Error('Define at least one E2B service.');
  const ports = new Set(), internalPorts = new Set();
  const services = Object.fromEntries(Object.entries(spec.services).map(([name, service]) => {
    if (!validName(name) || !object(service)) throw new Error('E2B services require valid names and objects.');
    for (const key of Object.keys(service)) {
      if (!['command', 'port', 'containerPort', 'protocol', 'env'].includes(key)) throw new Error('E2B services support command, port, containerPort, protocol, and env only.');
    }
    if (typeof service.command !== 'string' || !service.command.trim() || service.command.includes('\0')) throw new Error('Each E2B service requires a command.');
    if (service.command.includes(apiKey)) throw new Error('Do not include E2B credentials in service commands.');
    const containerPort = service.containerPort ?? service.port, protocol = service.protocol ?? 'http';
    if (protocol !== 'http') throw new Error('E2B supports HTTP and WebSockets. Raw TCP is not supported.');
    if (!Number.isInteger(service.port) || service.port < 1024 || service.port > 65535) throw new Error('E2B public ports must be 1024 through 65535.');
    if (!Number.isInteger(containerPort) || containerPort < 1 || containerPort > 65535 || reservedPorts.has(containerPort)) throw new Error('Use an unreserved E2B service port from 1 through 65535.');
    if (ports.has(service.port) || internalPorts.has(containerPort)) throw new Error('E2B services must use distinct public ports and sandbox ports.');
    ports.add(service.port); internalPorts.add(containerPort);
    return [name, { ...service, containerPort, protocol, env: { ...env, ...cleanEnv(service.env) } }];
  }));
  return { ...spec, env, services, e2b: { template, timeoutSeconds, credentials: { apiKey } },
    sensitiveValues: [...new Set([...sensitiveValuesForSpec(spec), apiKey])] };
}

const metadataFor = handle => ({ 'agent-env.provider': 'e2b', 'agent-env.owner': handle.e2b.owner,
  'agent-env.name': handle.e2b.name, 'agent-env.record': handle.e2b.recordId });
const configHash = spec => digest(JSON.stringify({ cwd: spec.cwd, template: spec.e2b.template }));
const runtimePath = handle => `${handle.workspace.slice(0, -'/workspace'.length)}/runtime`;

// Files and process state live outside the synchronized checkout.
const manager = String.raw`import base64, fcntl, hashlib, json, os, pathlib, signal, subprocess, sys, time
root = pathlib.Path(__file__).parent
workspace = root.parent / 'workspace'
config = json.loads((root / 'services.json').read_text())
def save(path, value):
    temporary = path.with_name(path.name + '.' + str(os.getpid()) + '.tmp')
    temporary.write_text(json.dumps(value))
    os.replace(temporary, path)
def stamp(pid):
    try:
        return pathlib.Path('/proc/' + str(pid) + '/stat').read_text().rsplit(')', 1)[1].split()[19]
    except (FileNotFoundError, ProcessLookupError):
        return None
def state(name):
    path = root / name / 'state.json'
    saved = json.loads(path.read_text()) if path.exists() else {'status': 'created'}
    if saved['status'] == 'running' and (not saved.get('stamp') or stamp(saved.get('supervisor')) != saved['stamp']):
        return {'status': 'exited', 'exitCode': 1}
    return saved
def target(path):
    parts = pathlib.PurePosixPath(path).parts
    if not parts or any(part in ('.', '..') for part in parts) or path.startswith('/'):
        raise ValueError('Invalid source path')
    result = workspace
    for part in parts:
        result = result / part
        if result.is_symlink():
            raise ValueError('Source destination contains a symbolic link')
    return result
operation = sys.argv[1]
if operation == 'launch':
    name = sys.argv[2]
    directory = root / name
    with (directory / 'lock').open('a') as lock:
        deadline = time.monotonic() + 1
        while True:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if state(name)['status'] == 'running':
                    sys.exit(0)
                if time.monotonic() >= deadline:
                    raise RuntimeError('The service launch lock is busy')
                time.sleep(0.02)
        environment = {key: value for key, value in os.environ.items() if not key.upper().startswith('E2B_')}
        with (directory / 'stdout').open('ab', buffering=0) as out, (directory / 'stderr').open('ab', buffering=0) as err:
            code = 1
            try:
                child = subprocess.Popen(['/bin/bash', '-c', config[name]['command']], cwd=workspace, env=environment, stdout=out, stderr=err, start_new_session=True)
                save(directory / 'state.json', {'status': 'running', 'pid': child.pid, 'supervisor': os.getpid(), 'stamp': stamp(os.getpid())})
                code = child.wait()
                if code < 0:
                    code = 128 - code
            except Exception:
                err.write(b'Service execution failed.\n')
            save(directory / 'state.json', {'status': 'exited', 'exitCode': code})
    sys.exit(code)
elif operation == 'states':
    print(json.dumps({name: state(name) for name in config}))
elif operation == 'prepare':
    name = sys.argv[2]
    if state(name)['status'] != 'running':
        save(root / name / 'state.json', {'status': 'created'})
elif operation == 'stop':
    name = sys.argv[2]
    saved = state(name)
    if saved['status'] == 'running':
        for sig, duration in ((signal.SIGTERM, 5), (signal.SIGKILL, 2)):
            if state(name)['status'] != 'running':
                break
            try:
                os.killpg(saved['pid'], sig)
            except ProcessLookupError:
                pass
            deadline = time.monotonic() + duration
            while state(name)['status'] == 'running' and time.monotonic() < deadline:
                time.sleep(0.02)
        if state(name)['status'] == 'running':
            raise RuntimeError('The service did not stop')
elif operation == 'logs':
    directory = root / sys.argv[2]
    for stream in ('stdout', 'stderr'):
        path = directory / stream
        if path.exists():
            with path.open('rb') as file:
                file.seek(max(0, path.stat().st_size - 65536))
                print(file.read().decode('utf-8', errors='replace'), end='')
elif operation == 'sync':
    payload_path = root / sys.argv[2]
    payload = json.loads(payload_path.read_text())
    manifest_path = root / 'source.json'
    previous = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
    manifest = {}
    for entry in payload:
        path = target(entry['path'])
        path.parent.mkdir(parents=True, exist_ok=True)
        data = base64.b64decode(entry['data'])
        checksum = hashlib.sha256(data).hexdigest()
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != checksum:
            with path.open('wb') as file:
                file.write(data)
        path.chmod(entry['mode'])
        manifest[entry['path']] = checksum
    for path in previous:
        if path not in manifest:
            destination = target(path)
            if destination.is_file():
                destination.unlink()
    save(manifest_path, manifest)
`;

async function sdk() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 22 || major === 22 && minor < 19) throw new Error('E2B requires Node 22.19.0 or later.');
  try { return await import('e2b'); }
  catch { throw new Error('Install the official e2b SDK version 2.63.0 to use this provider.'); }
}
// Control-plane errors omit SDK text because it can contain private headers.
async function request(operation, work) {
  try { return await work(); }
  catch (error) {
    const kind = ['AuthenticationError', 'SandboxNotFoundError', 'ServiceBusyError', 'RateLimitError', 'TimeoutError'].includes(error.name) ? error.name : 'request error';
    throw Object.assign(new Error(`E2B ${operation} failed (${kind}).`), { e2bKind: error.name });
  }
}

function bridge(host, token, port) {
  const sockets = new Set(), pending = new Set();
  const server = http.createServer();
  const headersFor = incoming => {
    const headers = { ...incoming.headers, host, [trafficHeader]: token };
    delete headers['proxy-authorization'];
    if (headers.origin) {
      try {
        const origin = new URL(headers.origin);
        if (origin.hostname === 'localhost') { origin.port = String(port); headers.origin = origin.origin; }
      } catch { /* Preserve an origin that is not a URL. */ }
    }
    return headers;
  };
  const safeHeaders = headers => Object.fromEntries(Object.entries(headers)
    .filter(([key]) => key.toLowerCase() !== trafficHeader)
    .map(([key, value]) => [key, Array.isArray(value) ? value.map(item => item.replaceAll(token, '[redacted]')) : String(value).replaceAll(token, '[redacted]')]));
  const upstreamFor = incoming => {
    const upstream = https.request({ hostname: host, port: 443, method: incoming.method, path: incoming.url, headers: headersFor(incoming), agent: false });
    pending.add(upstream);
    upstream.once('close', () => pending.delete(upstream));
    upstream.setTimeout(30000, () => upstream.destroy());
    return upstream;
  };
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('clientError', (_error, socket) => socket.destroy());
  server.on('request', (incoming, outgoing) => {
    const upstream = upstreamFor(incoming);
    upstream.on('response', response => {
      upstream.setTimeout(0);
      outgoing.writeHead(response.statusCode, safeHeaders(response.headers));
      response.on('error', () => outgoing.destroy());
      response.pipe(outgoing);
    });
    upstream.on('error', () => {
      if (!outgoing.headersSent) outgoing.writeHead(502, { 'content-type': 'text/plain' });
      outgoing.end('The E2B service did not answer.\n');
    });
    incoming.on('aborted', () => upstream.destroy());
    outgoing.on('close', () => upstream.destroy());
    incoming.pipe(upstream);
  });
  server.on('upgrade', (incoming, socket, head) => {
    const upstream = upstreamFor(incoming);
    socket.on('error', () => upstream.destroy());
    socket.on('close', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
    upstream.on('response', response => { response.resume(); socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); });
    upstream.on('upgrade', (response, remote, remoteHead) => {
      sockets.add(remote);
      remote.on('close', () => { sockets.delete(remote); socket.destroy(); });
      remote.on('error', () => socket.destroy());
      socket.on('close', () => remote.destroy());
      socket.write(`HTTP/1.1 ${response.statusCode} Switching Protocols\r\n`);
      for (const [key, value] of Object.entries(safeHeaders(response.headers))) {
        for (const item of Array.isArray(value) ? value : [value]) socket.write(`${key}: ${item}\r\n`);
      }
      socket.write('\r\n');
      if (remoteHead.length) socket.write(remoteHead);
      if (head.length) remote.write(head);
      remote.setTimeout(0);
      socket.pipe(remote).pipe(socket);
    });
    upstream.end();
  });
  let closing;
  return {
    server,
    close() {
      if (closing) return closing;
      for (const upstream of pending) upstream.destroy();
      for (const socket of sockets) socket.destroy();
      closing = new Promise(resolveClosed => server.close(resolveClosed));
      return closing;
    },
  };
}

export class E2BProvider {
  sessions = new Map();
  connections = new Set();
  recordPath(spec) { return join(home, 'e2b', `${digest(`${spec.owner}:${spec.name}`)}.json`); }
  options(spec) {
    const apiKey = spec.e2b?.credentials?.apiKey;
    if (typeof apiKey !== 'string' || !apiKey) throw new Error('Resolve the E2B credential in the calling CLI before daemon IPC.');
    return { apiKey, debug: false, domain: 'e2b.app', apiUrl: 'https://api.e2b.app', requestTimeoutMs: 60000 };
  }
  safeText(handle, value) {
    const session = this.sessions.get(handle.e2b.sandboxId);
    return redactEnvironment(value, [...sensitiveValuesForSpec(handle.spec), handle.spec.e2b.credentials.apiKey, session?.trafficAccessToken, session?.envdAccessToken]);
  }
  async save(handle, exclusive = false) {
    const filename = this.recordPath(handle.spec);
    const record = JSON.stringify({ e2b: handle.e2b, workspace: handle.workspace });
    await mkdir(join(home, 'e2b'), { recursive: true, mode: 0o700 });
    if (exclusive) {
      await writePrivate(filename, record);
    } else {
      const temporary = `${filename}.${randomUUID()}.tmp`;
      try { await writePrivate(temporary, record); await rename(temporary, filename); }
      finally { await rm(temporary, { force: true }); }
    }
  }
  async local(handle) {
    const identity = handle.e2b;
    if (!identity || identity.owner !== handle.spec.owner || identity.name !== handle.spec.name || !/^[a-f0-9-]{36}$/.test(identity.recordId ?? '')) {
      throw new Error('The E2B handle does not match its instance ownership.');
    }
    const record = await this.readRecord(handle.spec);
    if (!record?.e2b) throw new Error('The private E2B ownership record is missing or invalid. Refusing the operation.');
    for (const field of ['owner', 'name', 'recordId', 'sandboxId', 'keyHash', 'configHash']) {
      if (record.e2b[field] !== identity[field]) throw new Error('The E2B handle does not match its private ownership record.');
    }
    if (identity.keyHash !== digest(this.options(handle.spec).apiKey)) throw new Error('The E2B credential differs from its ownership record.');
    if (identity.configHash !== configHash(handle.spec)) throw new Error('The retained E2B workspace or template differs. Use a new instance name, or purge the old sandbox if its data is no longer needed.');
    if (handle.workspace !== `/home/user/.agent-env/${identity.recordId}/workspace`) throw new Error('The E2B workspace does not match its ownership record.');
    handle.services = structuredClone(handle.spec.services);
    return record;
  }
  async info(handle, missing = false) {
    await this.local(handle);
    const { Sandbox } = await sdk();
    let info;
    try { info = await request('ownership check', () => Sandbox.getInfo(handle.e2b.sandboxId, this.options(handle.spec))); }
    catch (error) { if (missing && error.e2bKind === 'SandboxNotFoundError') return null; throw error; }
    if (info.sandboxId !== handle.e2b.sandboxId || Object.entries(metadataFor(handle)).some(([key, value]) => info.metadata?.[key] !== value)) {
      throw new Error('E2B sandbox metadata does not match its ownership record.');
    }
    return info;
  }
  async session(handle, resume = false) {
    const info = await this.info(handle);
    if (info.network?.allowPublicTraffic !== false) throw new Error('E2B private ingress is not enabled. Refusing the connection.');
    if (info.state !== 'running' && !resume) throw new Error('The E2B sandbox is paused. Run agent-env up first.');
    let session = this.sessions.get(handle.e2b.sandboxId);
    if (!session || info.state !== 'running' || resume) {
      const { Sandbox } = await sdk();
      session = await request('connection', () => Sandbox.connect(handle.e2b.sandboxId, { ...this.options(handle.spec), timeoutMs: handle.spec.e2b.timeoutSeconds * 1000, onResume: 'restore' }));
      this.sessions.set(handle.e2b.sandboxId, session);
    }
    if (!session.trafficAccessToken) throw new Error('E2B did not provide a private traffic token. Refusing the connection.');
    return session;
  }
  async command(handle, session, command, options = {}) {
    try { return await session.commands.run(command, { timeoutMs: 60000, ...options }); }
    catch (error) {
      if (Number.isInteger(error.exitCode)) {
        throw Object.assign(new Error(this.safeText(handle, `${error.stdout ?? ''}${error.stderr ?? ''}`) || 'The E2B command failed.'), { exitCode: error.exitCode });
      }
      throw new Error(error.name === 'TimeoutError' ? 'The E2B command timed out. Check the sandbox lease and instance status.' : 'The E2B command request failed.');
    }
  }
  async manage(handle, session, operation, ...args) {
    return this.command(handle, session, ['python3', `${runtimePath(handle)}/manager.py`, operation, ...args].map(quote).join(' '));
  }
  async recover(handle, retryCreation = false) {
    if (handle.e2b.sandboxId) return handle;
    const { Sandbox } = await sdk();
    const paginator = Sandbox.list({ ...this.options(handle.spec), query: { metadata: metadataFor(handle), state: ['running', 'paused'] } });
    const matches = [];
    while (paginator.hasNext) matches.push(...await request('allocation recovery', () => paginator.nextItems()));
    if (!matches.length && retryCreation) { await this.allocate(handle); return handle; }
    if (matches.length !== 1) throw new Error('E2B allocation has an unknown outcome. Keep its private record for recovery.');
    const found = matches[0];
    if (Object.entries(metadataFor(handle)).some(([key, value]) => found.metadata?.[key] !== value)) throw new Error('E2B recovery metadata does not match its ownership record.');
    handle.e2b.sandboxId = found.sandboxId;
    await this.save(handle);
    return handle;
  }
  async allocate(handle) {
    const { Sandbox } = await sdk(), { spec } = handle;
    const session = await request('creation', () => Sandbox.create(spec.e2b.template, { ...this.options(spec), timeoutMs: spec.e2b.timeoutSeconds * 1000,
      metadata: metadataFor(handle), idempotencyKey: handle.e2b.recordId, network: { allowPublicTraffic: false, maskRequestHost: 'localhost:${PORT}' },
      lifecycle: { onTimeout: 'pause', autoResume: false } }));
    handle.e2b.sandboxId = session.sandboxId;
    this.sessions.set(session.sandboxId, session);
    await this.save(handle);
  }
  async readRecord(spec) {
    try { return JSON.parse(await readFile(this.recordPath(spec), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error('The private E2B ownership record could not be read.');
    }
  }
  async create(input) {
    const spec = resolveE2BSpec(input);
    if (typeof spec.owner !== 'string' || !spec.owner) throw new Error('The daemon must assign an E2B instance owner.');
    await sdk();
    const retained = await this.readRecord(spec);
    if (retained) {
      retained.spec = spec;
      retained.services = structuredClone(spec.services);
      await this.local(retained);
      await this.recover(retained, true);
      await this.start(retained);
      return retained;
    }
    const recordId = randomUUID();
    const handle = { spec, services: structuredClone(spec.services), workspace: `/home/user/.agent-env/${recordId}/workspace`,
      e2b: { owner: spec.owner, name: spec.name, recordId, sandboxId: null, keyHash: digest(spec.e2b.credentials.apiKey), configHash: configHash(spec) } };
    await this.save(handle, true);
    try {
      await this.allocate(handle);
      await this.start(handle);
      return handle;
    } catch (error) {
      try { await this.recover(handle); await this.remove(handle, true); }
      catch { error.message += ' Cleanup is incomplete. Keep the private E2B ownership record and retry with the same instance name.'; }
      throw error;
    }
  }
  async start(handle) {
    try {
      const session = await this.session(handle, true);
      const runtime = runtimePath(handle);
      await this.command(handle, session, `mkdir -p ${[handle.workspace, runtime, ...Object.keys(handle.services).map(name => `${runtime}/${name}`)].map(quote).join(' ')}`);
      const configuration = Object.fromEntries(Object.entries(handle.spec.services).map(([name, service]) => [name, { command: service.command, fingerprint: digest(JSON.stringify(service)) }]));
      await request('runtime upload', () => session.files.write(`${runtime}/manager.py`, manager));
      const previous = await request('runtime configuration', async () => await session.files.exists(`${runtime}/services.json`) ? JSON.parse(await session.files.read(`${runtime}/services.json`)) : {});
      for (const name of Object.keys(previous)) {
        if (previous[name].fingerprint !== configuration[name]?.fingerprint) await this.manage(handle, session, 'stop', name);
      }
      for (const name of Object.keys(configuration)) {
        if (previous[name]?.fingerprint !== configuration[name].fingerprint) {
          // A new environment cannot redact credentials from an older service configuration.
          await request('log reset', () => session.files.write(['stdout', 'stderr'].map(stream => ({ path: `${runtime}/${name}/${stream}`, data: '' }))));
        }
      }
      await request('runtime configuration', () => session.files.write(`${runtime}/services.json`, JSON.stringify(configuration)));
      await this.sync(handle);
      for (const [name, service] of Object.entries(handle.services)) {
        await this.manage(handle, session, 'prepare', name);
        const command = await this.manageBackground(handle, session, name, service);
        await command.disconnect();
      }
      await this.wait(handle);
      await this.save(handle);
    } catch (error) {
      try { await this.stop(handle); }
      catch { error.message += ' E2B pause failed. Keep the ownership record for cleanup.'; }
      throw error;
    }
  }
  manageBackground(handle, session, name, service) {
    return this.command(handle, session, ['python3', `${runtimePath(handle)}/manager.py`, 'launch', name].map(quote).join(' '),
      { background: true, retainOutput: false, timeoutMs: 0, envs: { HOST: '0.0.0.0', PORT: String(service.containerPort), ...service.env } });
  }
  async wait(handle, deadline = Date.now() + (handle.spec.startupTimeoutSeconds ?? 60) * 1000) {
    const session = await this.session(handle);
    for (;;) {
      const states = JSON.parse((await this.manage(handle, session, 'states')).stdout);
      let ready = true;
      for (const [name, service] of Object.entries(handle.services)) {
        if (states[name]?.status === 'exited') throw Object.assign(new Error(`${name} exited. ${await this.logs(handle, name)}`), { exitCode: states[name].exitCode || 1 });
        if (states[name]?.status !== 'running' || !await this.probe(session, service.containerPort)) ready = false;
      }
      if (ready) return;
      if (Date.now() >= deadline) throw new Error('E2B services did not become ready. Bind each service to 0.0.0.0 and its configured port.');
      await new Promise(resolveDelay => setTimeout(resolveDelay, 300));
    }
  }
  probe(session, port) {
    return new Promise(resolveReady => {
      const request = https.get({ hostname: session.getHost(port), path: '/', headers: { [trafficHeader]: session.trafficAccessToken }, agent: false }, response => {
        response.resume(); resolveReady(response.statusCode !== 502 && response.statusCode !== 503);
      });
      request.setTimeout(1500, () => request.destroy());
      request.on('error', () => resolveReady(false));
    });
  }
  async connect(handle) {
    const session = await this.session(handle), opened = [];
    try {
      for (const [name, service] of Object.entries(handle.services)) {
        const connection = bridge(session.getHost(service.containerPort), session.trafficAccessToken, service.containerPort);
        opened.push(connection);
        await new Promise((resolveListening, reject) => {
          connection.server.once('error', reject);
          connection.server.listen(0, '127.0.0.1', resolveListening);
        });
        connection.name = name;
        connection.sandboxId = handle.e2b.sandboxId;
        connection.backendPort = connection.server.address().port;
        const close = connection.close;
        connection.close = () => { this.connections.delete(connection); return close(); };
        this.connections.add(connection);
      }
      return opened;
    } catch {
      await Promise.all(opened.map(connection => connection.close()));
      throw new Error('The E2B loopback connection could not start.');
    }
  }
  async stop(handle) {
    const info = await this.info(handle, true);
    if (!info) throw new Error('The owned E2B sandbox is missing. Use rm --purge to remove its local record.');
    if (info.state !== 'paused') {
      const { Sandbox } = await sdk();
      await request('pause', () => Sandbox.pause(handle.e2b.sandboxId, { ...this.options(handle.spec), mode: 'full', strict: true }));
    }
    this.sessions.delete(handle.e2b.sandboxId);
    await this.closeConnections(handle);
    await this.save(handle);
  }
  async remove(handle, purge = false) {
    if (!purge) { await this.stop(handle); return; }
    const info = await this.info(handle, true);
    if (info) {
      const { Sandbox } = await sdk();
      await request('purge', () => Sandbox.kill(handle.e2b.sandboxId, this.options(handle.spec)));
      if (await this.info(handle, true)) throw new Error('E2B still reports the sandbox after purge. Keep its ownership record.');
    }
    this.sessions.delete(handle.e2b.sandboxId);
    await this.closeConnections(handle);
    await rm(this.recordPath(handle.spec));
  }
  async closeConnections(handle) {
    await Promise.all([...this.connections].filter(connection => connection.sandboxId === handle.e2b.sandboxId).map(connection => connection.close()));
  }
  async status(handle) {
    const info = await this.info(handle, true);
    const state = !info ? 'missing' : info.state === 'paused' ? 'paused' : null;
    if (state) return Object.fromEntries(Object.keys(handle.services).map(name => [name, state]));
    const states = JSON.parse((await this.manage(handle, await this.session(handle), 'states')).stdout);
    return Object.fromEntries(Object.keys(handle.services).map(name => [name, states[name]?.status ?? 'created']));
  }
  async sync(handle) {
    const session = await this.session(handle), files = [];
    const excludedFiles = new Set((handle.spec.envFiles ?? []).map(path => relative(handle.spec.cwd, resolve(handle.spec.cwd, path)).replaceAll('\\', '/')));
    const secrets = sensitiveValuesForSpec(handle.spec).map(value => Buffer.from(value));
    const visit = async (directory, prefix = '') => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (!shouldSync(path) || credentialPath(path) || excludedFiles.has(path)) continue;
        const filename = join(directory, entry.name);
        if (entry.isDirectory()) { await visit(filename, path); continue; }
        if (!entry.isFile()) continue;
        const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = await file.stat();
          if (!info.isFile()) continue;
          const data = await file.readFile();
          if (secrets.some(secret => data.includes(secret))) continue;
          files.push({ path, mode: info.mode & 0o777, data: data.toString('base64') });
        } finally { await file.close(); }
      }
    };
    if ((await lstat(handle.spec.cwd)).isSymbolicLink()) throw new Error('The E2B checkout must not be a symbolic link.');
    await visit(handle.spec.cwd);
    const runtime = runtimePath(handle), payload = `sync-${randomUUID()}.json`;
    try {
      await request('source upload', () => session.files.write(`${runtime}/${payload}`, JSON.stringify(files)));
      await this.manage(handle, session, 'sync', payload);
    } finally {
      await request('source upload cleanup', async () => {
        if (await session.files.exists(`${runtime}/${payload}`)) await session.files.remove(`${runtime}/${payload}`);
      });
    }
  }
  async logs(handle, name) {
    if (!Object.hasOwn(handle.services, name)) throw new Error('The E2B service does not exist.');
    return this.safeText(handle, (await this.manage(handle, await this.session(handle), 'logs', name)).stdout);
  }
  async exec(handle, name, argv) {
    if (!Object.hasOwn(handle.services, name)) throw new Error('The E2B service does not exist.');
    if (!Array.isArray(argv) || !argv.length || argv.some(value => typeof value !== 'string' || value.includes('\0'))) throw new Error('Provide command arguments as strings.');
    const service = handle.services[name];
    const result = await this.command(handle, await this.session(handle), argv.map(quote).join(' '),
      { cwd: handle.workspace, timeoutMs: 0, envs: { HOST: '0.0.0.0', PORT: String(service.containerPort), ...service.env } });
    return this.safeText(handle, `${result.stdout}${result.stderr}`);
  }
  async dispose() {
    await Promise.all([...this.connections].map(connection => connection.close()));
    this.sessions.clear();
  }
}

async function writePrivate(path, content) {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(content); } finally { await file.close(); }
}
