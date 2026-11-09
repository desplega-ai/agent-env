import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { freePort, requestHttp, run, subprocess, until } from './helpers.mjs';

const executable = process.env.AGENT_ENV_CLI;
assert.ok(executable && isAbsolute(executable), 'AGENT_ENV_CLI must name an absolute installed executable.');
export { freePort, requestHttp, until };
export const docker = args => run('docker', args);

// Only this read-only request bypasses the CLI. It identifies the socket owner.
function ping(socketPath) {
  return new Promise((resolveResult, reject) => {
    const request = http.request({ socketPath, method: 'POST', path: '/', agent: false }, async response => {
      try {
        let body = '';
        for await (const chunk of response) body += chunk;
        assert.equal(response.statusCode, 200);
        // Close this client socket before checking the daemon's socket ownership.
        await socketClosed;
        resolveResult(JSON.parse(body).pid);
      } catch (error) { reject(error); }
    });
    const socketClosed = new Promise(resolveClosed => request.once('socket', socket => socket.once('close', resolveClosed)));
    request.setTimeout(2000, () => request.destroy(new Error('The socket ping timed out.')));
    request.on('error', reject);
    request.end(JSON.stringify({ type: 'ping' }));
  });
}

export async function fixture(suite) {
  // Keep the Unix socket path below the macOS limit.
  const directory = await mkdtemp(join(tmpdir(), 'agent-env-recovery-'));
  const cwd = join(directory, 'project'), home = join(directory, 'home');
  await mkdir(cwd);
  const socketPath = join(home, 'control.sock');
  const env = { ...process.env, AGENT_ENV_HOME: home };
  const daemonPath = resolve(dirname(await realpath(executable)), '../src/daemon.mjs');
  const children = new Set(), names = new Set(), resources = new Map();
  const anonymous = new Map();
  let owner;
  const invoke = async (args, ok = true, options = {}) => {
    const result = await subprocess(executable, args, { cwd, env, timeout: 90000, ...options });
    if (ok) assert.equal(result.code, 0, `agent-env ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
    return result;
  };
  const cli = async args => JSON.parse((await invoke(['--json', ...args])).stdout);
  async function daemonPid() {
    const pid = await ping(socketPath);
    assert.ok(Number.isInteger(pid) && pid > 1 && pid !== process.pid);
    const owners = await run('lsof', ['-nP', '-a', '-U', '-FpcfintT', '-Ts', '--', socketPath]);
    const pids = [...new Set(owners.split('\n').filter(line => /^p\d+$/.test(line)).map(line => Number(line.slice(1))))];
    let diagnostics = '';
    if (pids.length !== 1 || pids[0] !== pid) {
      diagnostics = (await subprocess('ps', ['-p', pids.join(','), '-o', 'pid=,ppid=,stat=,comm='])).stdout;
    }
    assert.deepEqual(pids, [pid], `Exactly one daemon must own the private socket. Test PID: ${process.pid}.\n${owners}\n${diagnostics}`);
    assert.ok((await run('ps', ['-p', String(pid), '-o', 'command='])).includes(daemonPath), 'The socket owner must run the installed daemon.');
    return pid;
  }
  async function killDaemon() {
    const pid = await daemonPid();
    process.kill(pid, 'SIGKILL');
    await until(() => ping(socketPath).then(() => false, error => {
      if (!['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(error.code)) throw error;
      return true;
    }));
    return pid;
  }
  function start(args) {
    const child = spawn(executable, ['--json', ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    let stdout = '', stderr = '';
    const done = new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        children.delete(child);
        resolveResult({ code, signal, stdout, stderr });
      });
    });
    return { child, done };
  }
  const prefix = name => `agent-env-${owner}-${name}`;
  const expectedName = value => [...names].some(name => value === prefix(name) || value.startsWith(`${prefix(name)}-`));
  async function inventory() {
    assert.ok(owner, 'Initialize the private owner before inspecting Docker resources.');
    const found = [];
    for (const kind of ['container', 'network', 'volume', 'image']) {
      const ids = new Set();
      const filters = [`agent-env.owner=${owner}`, ...(kind === 'image' ? [] : [...names].map(name => `com.docker.compose.project=${prefix(name)}`))];
      for (const label of filters) {
        const output = await docker([kind, 'ls', ...(kind === 'container' ? ['-a'] : []), '-q', '--no-trunc', '--filter', `label=${label}`].filter(value => kind !== 'volume' || value !== '--no-trunc'));
        for (const id of output.split(/\s+/).filter(Boolean)) ids.add(id);
      }
      for (const id of ids) {
        if (kind === 'volume' && anonymous.has(id)) continue;
        const [info] = JSON.parse(await docker([kind, 'inspect', id]));
        // Older engines retain untagged build results. Purge removes owned tags,
        // while Docker build caches remain outside the runtime cleanup contract.
        if (kind === 'image' && !info.RepoTags?.length) continue;
        const labels = (kind === 'container' || kind === 'image' ? info.Config?.Labels : info.Labels) ?? {};
        const resourceNames = kind === 'image' ? (info.RepoTags ?? []).filter(expectedName)
          : [kind === 'container' ? info.Name.replace(/^\//, '') : info.Name];
        const name = resourceNames[0];
        const project = labels['com.docker.compose.project'];
        assert.ok(name && expectedName(name), `Refuse an unexpected ${kind} name: ${name}`);
        assert.ok(labels['agent-env.owner'] === owner || [...names].some(item => project === prefix(item)), `Refuse an unowned ${kind}: ${name}`);
        if (kind === 'container') {
          for (const mount of info.Mounts ?? []) {
            if (mount.Type !== 'volume' || !/^[a-f0-9]{64}$/.test(mount.Name)) continue;
            const [volume] = JSON.parse(await docker(['volume', 'inspect', mount.Name]));
            anonymous.set(mount.Name, volume.CreatedAt);
          }
        }
        for (const resourceName of resourceNames) {
          const record = { kind, id: info.Id ?? info.Name, name: resourceName, labels };
          found.push(record);
          resources.set(`${kind}:${kind === 'image' ? resourceName : record.id}`, record);
        }
      }
    }
    // Mount identities detect anonymous volumes even after their containers disappear.
    // Docker labels alone cannot discover image-declared anonymous volumes.
    const volumes = new Set((await docker(['volume', 'ls', '-q'])).split('\n'));
    for (const [id, createdAt] of anonymous) {
      if (!volumes.has(id)) continue;
      const [info] = JSON.parse(await docker(['volume', 'inspect', id]));
      assert.equal(info.CreatedAt, createdAt, 'Refuse a replaced anonymous volume.');
      const record = { kind: 'volume', id, name: id, labels: info.Labels ?? {} };
      found.push(record);
      resources.set(`volume:${id}`, record);
    }
    await writeFile(join(directory, 'resources.json'), JSON.stringify([...resources.values()], null, 2), { mode: 0o600 });
    return found;
  }
  async function assertEmpty() {
    assert.deepEqual(await inventory(), [], 'Public purge must remove every test resource, including resources absent from state.json.');
  }
  return {
    directory, cwd, home, cli, invoke, start, daemonPid, killDaemon, prefix, inventory, assertEmpty,
    async settleAllocation() {
      await until(async () => {
        const directories = (await readdir(home)).filter(name => name.startsWith('allocation-'));
        for (const directory of directories) {
          for (const entry of await readdir(join(home, directory))) {
            const result = await readFile(join(home, directory, entry, 'result.json'), 'utf8').then(JSON.parse, error => {
              if (error.code === 'ENOENT') return null;
              throw error;
            });
            if (!result?.settled) return false;
          }
        }
        return true;
      }, 90000);
    },
    addName(name) { names.add(name); },
    async initializeDocker() {
      assert.deepEqual(await cli(['list']), []);
      owner = JSON.parse(await readFile(join(home, 'state.json'), 'utf8')).owner;
      assert.match(owner, /^[a-z0-9-]+$/);
      await assertEmpty();
    },
    async cleanup() {
      try {
        // Release every fixture gate before stopping the daemon or removing resources.
        await writeFile(join(cwd, 'release'), 'release');
        for (const child of children) child.kill('SIGTERM');
        await until(() => children.size === 0);
        await this.settleAllocation();
        if (owner) await inventory();
        const pid = await ping(socketPath).catch(error => {
          if (['ENOENT', 'ECONNREFUSED', 'ECONNRESET', 'EPIPE'].includes(error.code)) return null;
          throw error;
        });
        if (pid) {
          await daemonPid();
          if (owner) await invoke(['rm', '--all', '--purge'], false);
          await invoke(['daemon', 'stop']);
        }
        // The journal permits cleanup even if the daemon never saved a handle.
        if (owner) {
          for (const kind of ['container', 'network', 'volume', 'image']) {
            for (const record of (await inventory()).filter(item => item.kind === kind)) {
              await docker([kind, 'rm', ...(kind === 'container' ? ['-fv'] : []), kind === 'image' ? record.name : record.id]);
            }
          }
          await assertEmpty();
          console.log(`CLEAN: ${suite}: zero containers, networks, volumes, and generated images.`);
        }
        await rm(directory, { recursive: true, force: true });
      } catch (error) {
        console.error(`Cleanup failed. Recovery files remain at ${directory}`);
        throw error;
      }
    },
  };
}
