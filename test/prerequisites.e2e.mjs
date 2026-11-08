import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCli } from './helpers.mjs';

const directory = await mkdtemp(join(tmpdir(), 'agent-env-test-prereq-'));
const binaries = join(directory, 'bin');
await mkdir(binaries);
await symlink(process.execPath, join(binaries, 'node'));
try {
  await writeFile(join(directory, 'compose.yaml'), 'services:\n  web:\n    image: busybox:1.37\n    ports: ["8123:3000"]\n');
  for (const [name, args] of [
    ['native', ['--image', 'busybox:1.37', '--port', '8123', '--', 'sleep', '60']],
    ['compose', ['--compose-file', 'compose.yaml']],
  ]) {
    const state = join(directory, name);
    const { invoke } = createCli(directory, state, { PATH: binaries });
    const result = await invoke(['up', '--name', name, '--local', '--no-env-file', ...args], false);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /Docker was not found/);
    assert.doesNotMatch(result.stderr, /spawn docker|Cannot normalize Compose/);
    await assert.rejects(stat(state), { code: 'ENOENT' });
  }
  console.log('PASS: missing Docker produces an actionable error without daemon state for native and Compose startup.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
