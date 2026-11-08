import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

const sourceCli = resolve(import.meta.dirname, '../bin/agent-env.mjs');
export const delay = milliseconds => new Promise(resolveResult => setTimeout(resolveResult, milliseconds));
const ports = new Set();
export async function freePort() {
  for (;;) {
    const server = net.createServer();
    await new Promise((resolveResult, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolveResult);
    });
    const port = server.address().port;
    await new Promise(resolveResult => server.close(resolveResult));
    if (!ports.has(port)) { ports.add(port); return port; }
  }
}

export function subprocess(binary, args, { cwd, env = process.env, input, timeout = 600000 } = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(binary, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); }, timeout);
    const killTimer = setTimeout(() => child.kill('SIGKILL'), timeout + 5000);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.once('error', error => { clearTimeout(timer); clearTimeout(killTimer); reject(error); });
    child.once('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(killTimer);
      resolveResult({ code, signal, stdout, stderr, timedOut });
    });
    child.stdin.end(input);
  });
}
export async function run(binary, args, options = {}) {
  const result = await subprocess(binary, args, options);
  if (result.code !== 0) throw Object.assign(new Error(`${binary} ${args.join(' ')}: ${result.stderr || result.stdout}`), { ...result, exitCode: result.code });
  return (options.combined ? result.stdout + result.stderr : result.stdout).trimEnd();
}

export function createCli(cwd, home, overrides = {}) {
  const invoke = async (args, ok = true, options = {}) => {
    const cli = process.env.AGENT_ENV_CLI;
    if (cli && !isAbsolute(cli)) throw new Error('AGENT_ENV_CLI must contain an absolute installed executable path.');
    const result = await subprocess(cli || process.execPath, cli ? args : [sourceCli, ...args], {
      cwd: options.cwd ?? cwd,
      env: { ...process.env, ...overrides, AGENT_ENV_HOME: home, ...options.env },
      input: options.input,
      timeout: options.timeout,
    });
    if (ok && result.code !== 0) throw Object.assign(new Error(`agent-env ${args.join(' ')}: ${result.stderr || result.stdout}`), { ...result, exitCode: result.code });
    return result;
  };
  const cli = async (args, options = {}) => JSON.parse((await invoke(['--json', ...args], true, options)).stdout);
  return { cli, invoke };
}

export function sshOptions() {
  const host = process.env.AGENT_ENV_TEST_SSH;
  return host ? ['--ssh', host, ...(process.env.AGENT_ENV_TEST_SSH_CONFIG ? ['--ssh-config', process.env.AGENT_ENV_TEST_SSH_CONFIG] : [])] : [];
}
export function targetOptions() {
  return [...sshOptions(), ...(process.env.AGENT_ENV_TEST_SANDBOX ? ['--provider', 'sandbox', '--adapter', 'docker'] : [])];
}
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export function docker(args, options = {}) {
  const host = process.env.AGENT_ENV_TEST_SSH;
  if (!host) return run('docker', args, options);
  return run('ssh', [...(process.env.AGENT_ENV_TEST_SSH_CONFIG ? ['-F', process.env.AGENT_ENV_TEST_SSH_CONFIG] : []), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '--', host, ['docker', ...args].map(quote).join(' ')], options);
}
export async function until(check, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let lastError;
  do {
    try { if (await check()) return; } catch (error) { lastError = error; }
    await delay(250);
  } while (Date.now() < deadline);
  throw new Error('The E2E condition did not complete before its deadline.', { cause: lastError });
}

export async function fixture(suite, env = {}) {
  const directory = await mkdtemp(join(tmpdir(), `agent-env-test-${suite}-`));
  const cwd = join(directory, 'checkout with spaces'), home = join(directory, 'state');
  await mkdir(cwd);
  const { cli, invoke } = createCli(cwd, home, env);
  return {
    directory, cwd, home, cli, invoke,
    async cleanup() {
      const removed = await invoke(['rm', '--all', '--purge', '--remove-worktree', '--discard-worktree'], false);
      const stopped = await invoke(['daemon', 'stop'], false);
      assert.equal(removed.code, 0, `Cleanup failed. Recovery directory: ${directory}\n${removed.stderr}`);
      assert.ok(stopped.code === 0 || /ENOENT|ECONNREFUSED/.test(stopped.stderr), `Daemon cleanup failed: ${stopped.stderr}`);
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export function requestHttp(url, { headers, method = 'GET', body } = {}) {
  return new Promise((resolveResult, reject) => {
    const req = http.request(url, { headers, method }, async response => {
      try {
        let text = '';
        for await (const chunk of response) text += chunk;
        resolveResult({ status: response.statusCode, body: text, headers: response.headers });
      } catch (error) { reject(error); }
    });
    req.setTimeout(5000, () => req.destroy(new Error('The HTTP request timed out.')));
    req.once('error', reject);
    req.end(body);
  });
}
