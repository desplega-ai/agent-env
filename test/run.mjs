#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const groups = {
  core: ['core.e2e.mjs', 'skill.e2e.mjs', 'prerequisites.e2e.mjs'],
  docker: ['e2e.mjs', 'runtime-e2e.mjs', 'proxy.e2e.mjs', 'dotenv.e2e.mjs'],
  compose: ['compose.e2e.mjs', 'features-e2e.mjs', 'goodies-e2e.mjs', 'dotenv-compose.e2e.mjs'],
  features: ['features-e2e.mjs'],
  goodies: ['goodies-e2e.mjs'],
  ssh: ['e2e.mjs', 'runtime-e2e.mjs', 'features-e2e.mjs', 'compose.e2e.mjs'],
  s3: ['features-e2e.mjs'],
  cloud: ['cloud.e2e.mjs'],
};
const requested = process.argv.slice(2);
if (requested.includes('--help')) {
  console.log(`Run public CLI E2E tests:
  node test/run.mjs core                  No Docker required
  node test/run.mjs docker                Real Docker, HTTP, TCP, TLS, dotenv
  node test/run.mjs compose               Compose, features, goodies, dotenv
  node test/run.mjs features goodies      Snapshots, worktrees, service templates
  AGENT_ENV_TEST_SSH=alias node test/run.mjs ssh
  AGENT_ENV_TEST_S3=s3://bucket/prefix node test/run.mjs s3
  AGENT_ENV_TEST_CLOUD=1 node test/run.mjs cloud

Set AGENT_ENV_CLI to an absolute installed executable path.
The default executable is bin/agent-env.mjs from this checkout.
AGENT_ENV_TEST_SSH_CONFIG selects an SSH configuration file.
AGENT_ENV_TEST_S3_ENDPOINT selects an S3 endpoint.
AGENT_ENV_TEST_SANDBOX=1 enables the real Docker sandbox bridge in Docker tests.
Cloud tests create one billed Hetzner machine only with explicit authorization.
Without arguments, the runner executes core, docker, and compose.
Each S3 test uses a new child prefix and removes only that prefix.`);
  process.exit(0);
}
const selected = requested.length ? requested : ['core', 'docker', 'compose'];
for (const group of selected) {
  if (!groups[group]) throw new Error(`Unknown E2E group: ${group}. Use --help.`);
  if (group === 'ssh' && !process.env.AGENT_ENV_TEST_SSH) throw new Error('The SSH suite requires AGENT_ENV_TEST_SSH.');
  if (group === 's3' && !process.env.AGENT_ENV_TEST_S3?.startsWith('s3://')) throw new Error('The S3 suite requires AGENT_ENV_TEST_S3=s3://bucket/prefix.');
  if (group === 'cloud' && process.env.AGENT_ENV_TEST_CLOUD !== '1') throw new Error('The cloud suite requires AGENT_ENV_TEST_CLOUD=1 to authorize billing.');
}
for (const group of selected) {
  // Local groups remain local even when remote switches exist in the shell.
  const env = { ...process.env };
  if (!['ssh', 's3'].includes(group)) { delete env.AGENT_ENV_TEST_SSH; delete env.AGENT_ENV_TEST_SSH_CONFIG; }
  if (group !== 's3') { delete env.AGENT_ENV_TEST_S3; delete env.AGENT_ENV_TEST_S3_ENDPOINT; }
  delete env.AGENT_ENV_TEST_SANDBOX;
  const suites = groups[group].map(file => ({ file, env }));
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
