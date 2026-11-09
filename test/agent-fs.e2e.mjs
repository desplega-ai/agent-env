import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

if (process.env.AGENT_ENV_TEST_AGENT_FS !== '1') {
  console.log('SKIP: Set AGENT_ENV_TEST_AGENT_FS=1 and AGENT_ENV_AGENT_FS_SOURCE to run real agent-fs acceptance.');
  process.exit(0);
}
assert.ok(process.env.AGENT_ENV_AGENT_FS_SOURCE, 'Set AGENT_ENV_AGENT_FS_SOURCE to the agent-fs source checkout.');
assert.ok(!process.env.AGENT_ENV_CLI || process.env.AGENT_ENV_SDK_TARBALL, 'Supply AGENT_ENV_SDK_TARBALL when selecting an installed CLI.');
const root = resolve(import.meta.dirname, '..');
const directory = await mkdtemp(join(tmpdir(), 'agent-env-agent-fs-package-'));
const prefix = join(directory, 'install');
const execute = promisify(execFile);
try {
  await mkdir(prefix);
  let tarball = process.env.AGENT_ENV_SDK_TARBALL && resolve(process.env.AGENT_ENV_SDK_TARBALL);
  if (!tarball) {
    await execute(process.execPath, ['scripts/pack.mjs', directory], { cwd: root, maxBuffer: 16 * 1024 * 1024 });
    const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    tarball = join(directory, `desplega.ai-agent-env-${version}.tgz`);
  }
  await execute('npm', ['install', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', tarball], {
    timeout: 120000, maxBuffer: 16 * 1024 * 1024,
  });
  const installed = join(prefix, 'node_modules/@desplega.ai/agent-env');
  const { version } = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  console.log(`Installed @desplega.ai/agent-env@${version} from ${process.env.AGENT_ENV_SDK_TARBALL ? 'the selected archive' : 'the audited checkout archive'}.`);
  const status = await new Promise((resolveResult, reject) => {
    const child = spawn(process.execPath, [join(installed, 'examples/agent-fs/acceptance.mjs'), resolve(process.env.AGENT_ENV_AGENT_FS_SOURCE)], {
      cwd: prefix, stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('close', code => resolveResult(code));
  });
  assert.equal(status, 0, 'The installed agent-fs acceptance workflow failed.');
} finally {
  await rm(directory, { recursive: true, force: true });
}
