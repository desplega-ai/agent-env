import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { home } from './paths.mjs';
import { run } from './system.mjs';

export async function durableJson(path, value) {
  await writeFile(`${path}.tmp`, JSON.stringify(value), { mode: 0o600, flush: true });
  await rename(`${path}.tmp`, path);
  const directory = await open(join(path, '..'), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

function journal(handle) {
  if (!/^[a-f0-9-]{36}$/.test(handle.allocation.record)) throw new Error('Invalid allocation record.');
  return join(home, `allocation-${handle.allocation.record}`);
}

export async function processIdentity(pid) {
  return (await run('/bin/ps', ['-p', String(pid), '-o', 'lstart=', '-o', 'args='])).trim();
}

// Only a worker receipt proves completion. A missing or reused PID proves nothing
// about a subprocess, a remote command, or a Docker request that can still finish.
export async function settledAllocation(handle, { allowUncertain = false } = {}) {
  const directory = journal(handle);
  const uncertain = [];
  const entries = await readdir(directory).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    const path = join(directory, entry);
    const identity = JSON.parse(await readFile(join(path, 'identity.json'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return 'null';
      throw error;
    }));
    const result = JSON.parse(await readFile(join(path, 'result.json'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return 'null';
      throw error;
    }));
    // Permission requires a durable PID. Without it, this command never ran.
    if (!identity?.pid || result?.token === identity.token && result.settled === true) {
      await rm(path, { recursive: true, force: true });
      continue;
    }
    const alive = await processIdentity(identity.pid).then(value => value === identity.process, () => false);
    // The detached worker is its process-group leader. Its child can outlive it.
    const groupAlive = (await run('/bin/ps', ['-axo', 'pgid='])).split(/\s+/).includes(String(identity.pid));
    if (alive || groupAlive) throw Object.assign(new Error(`Allocation command is still running. Retry after it completes. Recovery record: ${path}`), { code: 'ALLOCATION_RUNNING' });
    if (allowUncertain) { uncertain.push({ path, token: identity.token }); continue; }
    throw Object.assign(new Error(`Allocation command completion is uncertain. Recovery record: ${path}. Verify that no local or remote command can still allocate resources, then run agent-env rm ${handle.spec.name} --accept-uncertain. Add --purge only to delete retained data.`), { code: 'ALLOCATION_UNCERTAIN' });
  }
  await rmdir(directory).catch(error => { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; });
  return uncertain;
}

// Call only after an explicit operator acknowledgement and ownership verification.
export async function acknowledgeAllocation(handle) {
  for (const { path, token } of await settledAllocation(handle, { allowUncertain: true })) {
    await durableJson(join(path, 'result.json'), { token, settled: true, acknowledged: true });
  }
  await settledAllocation(handle);
}

export async function allocationCommand(handle, command, args, options = {}) {
  await settledAllocation(handle);
  const directory = journal(handle);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = await mkdtemp(join(directory, 'command-'));
  const token = randomUUID();
  const intent = { token, record: handle.allocation.record, name: handle.spec.name, owner: handle.spec.owner,
    host: handle.spec.host ?? null, resources: handle.allocation.resources };
  // This intent also preserves the resource plan when a caller has no daemon checkpoint.
  await durableJson(join(path, 'identity.json'), intent);
  // Persist both directory entries before the worker can receive permission.
  for (const parent of [directory, home]) {
    const file = await open(parent, 'r');
    try { await file.sync(); } finally { await file.close(); }
  }
  const child = spawn(process.execPath, [join(import.meta.dirname, 'allocation-worker.mjs'), path, token], {
    detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: options.env ?? process.env,
  });
  return new Promise((resolve, reject) => {
    let result;
    child.on('error', reject);
    child.on('message', async message => {
      if (message === 'ready') {
        try {
          const identity = { ...intent, pid: child.pid, process: await processIdentity(child.pid) };
          await durableJson(join(path, 'identity.json'), identity);
          // The worker cannot allocate before the durable checkpoint above.
          child.send({ command, args, remote: options.remote === true });
        } catch (error) { if (child.connected) child.disconnect(); reject(error); }
      } else result = message;
    });
    child.on('close', () => {
      if (!result || result.token !== token || !result.settled) {
        reject(Object.assign(new Error(`Allocation command completion is uncertain. Recovery record: ${path}. Inspect the instance with agent-env list.`), { code: 'ALLOCATION_UNCERTAIN' }));
      } else if (result.code === 0) resolve(result.stdout.trimEnd());
      else reject(Object.assign(new Error(`${command} failed (${result.code}): ${[result.stdout, result.stderr].filter(Boolean).join('\n').trimEnd()}`), { exitCode: result.code ?? 1 }));
    });
  });
}
