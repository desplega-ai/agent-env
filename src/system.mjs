import { spawn } from 'node:child_process';
import net from 'node:net';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

export { delay };
export const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '', stderr = '';
    child.stdout?.on('data', data => { stdout += data; });
    child.stderr?.on('data', data => { stderr += data; if (options.combined) stdout += data; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) return resolve(stdout.trimEnd());
      const output = options.combined ? stdout.trimEnd() : [stdout.trimEnd(), stderr.trimEnd()].filter(Boolean).join('\n');
      reject(Object.assign(new Error(`${command} failed (${code}): ${output}`), { exitCode: code ?? 1 }));
    });
  });
}
export async function freePort() {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
export async function reachable(port) {
  return new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1');
    const finish = value => { socket.destroy(); resolve(value); };
    socket.setTimeout(500, () => finish(false));
    socket.on('connect', () => finish(true));
    socket.on('error', () => finish(false));
  });
}
