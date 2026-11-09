#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const groups = {
  core: ['core.e2e.mjs', 'daemon.e2e.mjs', 'storage.e2e.mjs', 'skill.e2e.mjs', 'prerequisites.e2e.mjs'],
  docker: ['e2e.mjs', 'lifecycle.e2e.mjs', 'recovery.e2e.mjs', 'runtime-e2e.mjs', 'proxy.e2e.mjs', 'dotenv.e2e.mjs', 'commands.e2e.mjs', 'sdk.e2e.mjs'],
  devcontainer: ['devcontainer.e2e.mjs'],
  e2b: ['e2b.e2e.mjs'],
  'agent-fs': ['agent-fs.e2e.mjs'],
  compose: ['compose.e2e.mjs', 'features-e2e.mjs', 'goodies-e2e.mjs', 'dotenv-compose.e2e.mjs'],
  features: ['features-e2e.mjs'],
  goodies: ['goodies-e2e.mjs'],
  ssh: ['e2e.mjs', 'runtime-e2e.mjs', 'features-e2e.mjs', 'compose.e2e.mjs'],
  s3: ['storage.e2e.mjs', 'storage-s3.e2e.mjs', 'features-e2e.mjs'],
  'cloud-preflight': ['cloud-preflight.e2e.mjs'],
  cloud: ['cloud-preflight.e2e.mjs', 'cloud.e2e.mjs'],
};
const requested = process.argv.slice(2);
if (requested.includes('--help')) {
  console.log(`Run public CLI E2E tests:
  node test/run.mjs core                  No Docker required
  node test/run.mjs docker                Real Docker, HTTP, TCP, TLS, dotenv, SDK
  node test/run.mjs compose               Compose, features, goodies, dotenv
  node test/run.mjs devcontainer          Real Dev Containers CLI and Docker
  AGENT_ENV_TEST_E2B=1 node test/run.mjs e2b
  AGENT_ENV_TEST_AGENT_FS=1 AGENT_ENV_AGENT_FS_SOURCE=/path/to/agent-fs node test/run.mjs agent-fs
  node test/run.mjs features goodies      Snapshots, worktrees, service templates
  AGENT_ENV_TEST_SSH=alias node test/run.mjs ssh
  AGENT_ENV_TEST_S3=s3://bucket/prefix node test/run.mjs s3
  node test/run.mjs cloud-preflight       Invalid credentials only. Live selection tests require AGENT_ENV_TEST_CLOUD=1
  AGENT_ENV_TEST_CLOUD=1 node test/run.mjs cloud

Set AGENT_ENV_CLI to an absolute installed executable path.
Without AGENT_ENV_CLI, the runner audits and installs this checkout in a temporary prefix.
AGENT_ENV_TEST_SSH_CONFIG selects an SSH configuration file.
AGENT_ENV_TEST_RECOVERY_SSH and AGENT_ENV_TEST_RECOVERY_SSH_CONFIG enable loopback SSH recovery cases on the same Docker engine.
AGENT_ENV_TEST_S3_ENDPOINT selects an S3 endpoint.
AGENT_ENV_TEST_SANDBOX=1 enables the real Docker sandbox bridge in Docker tests.
Cloud tests can create billed Hetzner resources only with explicit authorization.
Without arguments, the runner executes core, docker, compose, and devcontainer.
Each S3 test uses a new child prefix and removes only that prefix.`);
  process.exit(0);
}
const selected = requested.length ? requested : ['core', 'docker', 'compose', 'devcontainer'];
for (const group of selected) {
  if (!groups[group]) throw new Error(`Unknown E2E group: ${group}. Use --help.`);
  if (group === 'ssh' && !process.env.AGENT_ENV_TEST_SSH) throw new Error('The SSH suite requires AGENT_ENV_TEST_SSH.');
  if (group === 's3' && !process.env.AGENT_ENV_TEST_S3?.startsWith('s3://')) throw new Error('The S3 suite requires AGENT_ENV_TEST_S3=s3://bucket/prefix.');
  if (group === 'cloud' && process.env.AGENT_ENV_TEST_CLOUD !== '1') throw new Error('The cloud suite requires AGENT_ENV_TEST_CLOUD=1 to authorize billing.');
  if (group === 'e2b' && process.env.AGENT_ENV_TEST_E2B !== '1') throw new Error('The E2B suite requires AGENT_ENV_TEST_E2B=1 to authorize billing.');
  if (group === 'agent-fs' && (process.env.AGENT_ENV_TEST_AGENT_FS !== '1' || !process.env.AGENT_ENV_AGENT_FS_SOURCE)) throw new Error('The agent-fs suite requires AGENT_ENV_TEST_AGENT_FS=1 and AGENT_ENV_AGENT_FS_SOURCE.');
}
if (!process.env.AGENT_ENV_CLI) {
  const root = resolve(import.meta.dirname, '..');
  const directory = await mkdtemp(join(tmpdir(), 'agent-env-install-'));
  const execute = (binary, args, env = process.env) => new Promise((resolveResult, reject) => {
    const child = spawn(binary, args, { cwd: root, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', status => resolveResult(status ?? 1));
  });
  let status = 1;
  try {
    const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    const artifact = join(directory, `desplega.ai-agent-env-${version}.tgz`);
    if (await execute(process.execPath, ['scripts/pack.mjs', directory]) !== 0) throw new Error('Package verification failed.');
    if (await execute('npm', ['install', '--prefix', directory, '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock', artifact]) !== 0) throw new Error('Test package installation failed.');
    status = await execute(process.execPath, [resolve(import.meta.dirname, 'run.mjs'), ...requested], {
      ...process.env, AGENT_ENV_CLI: join(directory, 'node_modules/.bin/agent-env'), AGENT_ENV_SDK_TARBALL: artifact,
    });
  } finally {
    if (status === 0) await rm(directory, { recursive: true, force: true });
    else console.error(`Tests failed. The installed CLI remains available for recovery at ${directory}.`);
  }
  process.exit(status);
}
for (const group of selected) {
  // Local groups remain local even when remote switches exist in the shell.
  const env = { ...process.env };
  if (group !== 'ssh') { delete env.AGENT_ENV_TEST_RECOVERY_SSH; delete env.AGENT_ENV_TEST_RECOVERY_SSH_CONFIG; }
  if (!['ssh', 's3'].includes(group)) { delete env.AGENT_ENV_TEST_SSH; delete env.AGENT_ENV_TEST_SSH_CONFIG; }
  if (group !== 's3') { delete env.AGENT_ENV_TEST_S3; delete env.AGENT_ENV_TEST_S3_ENDPOINT; }
  delete env.AGENT_ENV_TEST_SANDBOX;
  const suites = groups[group].map(file => ({ file, env }));
  if (group === 'ssh' && env.AGENT_ENV_TEST_RECOVERY_SSH) suites.push({ file: 'recovery.e2e.mjs', env });
  if (group === 'docker' && process.env.AGENT_ENV_TEST_SANDBOX) {
    for (const file of ['e2e.mjs', 'dotenv.e2e.mjs']) suites.push({ file, env: { ...env, AGENT_ENV_TEST_SANDBOX: '1' } });
  }
  for (const suite of suites) {
    const { file } = suite;
    console.log(`E2E ${group}${suite.env.AGENT_ENV_TEST_SANDBOX ? ' sandbox bridge' : ''}: ${file}`);
    const code = await new Promise((resolveResult, reject) => {
      const child = spawn(process.execPath, [resolve(import.meta.dirname, file)], { env: suite.env, stdio: 'inherit' });
      child.once('error', reject);
      child.once('close', (status, signal) => resolveResult(status ?? (signal ? 1 : 0)));
    });
    if (code !== 0) process.exit(code);
  }
  if (group === 'compose') {
    console.log('E2E compose: goodies-e2e.mjs with Compose service templates');
    const code = await new Promise((resolveResult, reject) => {
      const child = spawn(process.execPath, [resolve(import.meta.dirname, 'goodies-e2e.mjs')], { env: { ...env, AGENT_ENV_TEST_COMPOSE_GOODIES: '1' }, stdio: 'inherit' });
      child.once('error', reject);
      child.once('close', status => resolveResult(status ?? 1));
    });
    if (code !== 0) process.exit(code);
  }
}
