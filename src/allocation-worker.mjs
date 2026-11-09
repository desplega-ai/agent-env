import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';
import { durableJson } from './allocation-command.mjs';

const [directory, token] = process.argv.slice(2);
let started = false;
async function finish(result) {
  const receipt = { token, ...result };
  await durableJson(join(directory, 'result.json'), receipt);
  if (process.connected) {
    process.send(receipt, () => { if (process.connected) process.disconnect(); });
  }
}
process.on('disconnect', () => {
  if (!started) {
    started = true;
    finish({ settled: true, code: 1, stdout: '', stderr: 'Allocation canceled before permission.' });
  }
});
process.once('message', ({ command, args, remote }) => {
  started = true;
  const log = createWriteStream(join(directory, 'output.log'), { flags: 'wx', mode: 0o600 });
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', spawnError;
  child.stdout.on('data', data => { stdout += data; log.write(data); });
  child.stderr.on('data', data => { stderr += data; log.write(data); });
  child.once('error', error => { spawnError = error.message; });
  child.once('close', async (code, signal) => {
    log.end();
    await once(log, 'finish');
    // SSH transport failures and signals cannot prove remote command completion.
    const settled = !!spawnError || signal === null && code !== null && (!remote || code < 128);
    finish({ settled, code: code ?? 1, stdout, stderr: spawnError ?? stderr });
  });
});
process.send('ready');
