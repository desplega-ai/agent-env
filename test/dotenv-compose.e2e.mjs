import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, freePort, sshOptions } from './helpers.mjs';

const secret = 'compose-dotenv-private-$-literal';
const test = await fixture('dotenv-compose', {
  AGENT_ENV_E2E_INPUT: secret,
  AE_SHELL: 'shell-precedence', AE_STORE: 'shell-store', AE_TOP: 'shell-config', OTHER: 'inherited-readable',
});
const { cwd, cli, invoke } = test;
const port = await freePort();
const literal = '$(touch parser-executed) `touch parser-executed-backtick` $AE_NO_EXPANSION';
const serviceLiteral = '$(touch service-env-executed)';
const credentials = { ENCRYPTION_KEY: 'encryption-fixture', SIGNING_KEY: 'signing-fixture', LICENSE_KEY: 'license-fixture', SESSION_SALT: 'salt-fixture', OPAQUE_STRIPE: 'sk_live_fixture', OPAQUE_SLACK: 'xoxb-fixture', OPAQUE_GITLAB: 'glpat-fixture', OPAQUE_AWS: 'AKIAABCDEFGHIJKLMNOP' };
const credentialFile = Object.entries(credentials).map(([key, value]) => `${key}=${value}\n`).join('');
const digest = value => createHash('sha256').update(value).digest('hex');
const config = { provider: 'compose', env: { AE_TOP: 'top-config', AE_UNDECLARED: 'config-undeclared' } };
async function expected(name, values) {
  for (const [key, value] of Object.entries(values)) {
    const result = await cli(['exec', name, '--service', 'web', '--', 'sh', '-c', 'printf "%s" "$(printenv "$1")" | sha256sum', 'sh', key]);
    assert.equal(result.output.split(/\s+/)[0], digest(value), `${name}: ${key} precedence differs.`);
  }
}
async function start(name, args = []) {
  return cli(['up', '--name', name, '--no-watch', ...sshOptions(), ...args]);
}
try {
  await writeFile(join(cwd, 'agent-env.json'), JSON.stringify(config));
  await writeFile(join(cwd, 'index.html'), 'Compose dotenv');
  const keys = ['AE_BASE', 'AE_LOCAL', 'AE_NAMED', 'AE_FINAL', 'AE_STORE', 'AE_TOP', 'AE_SHELL', 'AE_LITERAL', 'AE_EXPLICIT', 'DEBUG', 'APP_MODE', 'GREETING', 'OTHER', 'DB_PASSWORD'];
  const declarations = [...keys, ...Object.keys(credentials)].map(key => `      ${key}: \${${key}-}`).join('\n');
  const compose = `services:
  web:
    image: busybox:1.37
    command: [sh, -c, "echo 'started 1 worker in development mode, build 2021'; exec httpd -f -p 3000 -h /workspace"]
    ports: ["${port}:3000"]
    volumes: [".:/workspace", "data:/data"]
    env_file: [service.env]
    environment:
${declarations}
      AE_SERVICE: service-inline
      AE_NATIVE: \${AE_BASE:-fallback}-suffix
volumes:
  data: {}
`;
  await writeFile(join(cwd, 'compose.yaml'), compose);
  await writeFile(join(cwd, 'service.env'), `AE_DECLARED=service-file\nAE_SERVICE=service-file\nAE_SERVICE_LITERAL='${serviceLiteral}'\n`);
  await writeFile(join(cwd, '.env'), `AE_BASE=base-only\nAE_LOCAL=base\nAE_NAMED=base\nAE_FINAL=base\nAE_STORE=file-store\nAE_TOP=file-config\nAE_SHELL=file-shell\nAE_UNDECLARED=file-undeclared\nAE_LITERAL='${literal}'\n`);
  await writeFile(join(cwd, '.env.local'), 'AE_LOCAL=local-only\nAE_NAMED=local\nAE_FINAL=local\n');
  await writeFile(join(cwd, '.env.review'), 'AE_NAMED=named-only\nAE_FINAL=named\n');
  await writeFile(join(cwd, '.env.review.local'), 'AE_FINAL=named-local-only\nDEBUG=1\nAPP_MODE=development\nGREETING: hello\nOTHER\nDB_PASSWORD=short-secret\n' + credentialFile);
  await cli(['env', 'set', 'AE_STORE', '--env', 'review', '--from-env', 'AGENT_ENV_E2E_INPUT']);
  await cli(['env', 'set', 'AE_TOP', '--env', 'review'], { input: 'private-config-overridden\n' });
  await start('auto', ['--env', 'review']);
  await expected('auto', {
    AE_BASE: 'base-only', AE_LOCAL: 'local-only', AE_NAMED: 'named-only', AE_FINAL: 'named-local-only',
    AE_STORE: secret, AE_TOP: 'top-config', AE_SHELL: 'shell-precedence', AE_LITERAL: literal,
    AE_UNDECLARED: '', AE_DECLARED: 'service-file', AE_SERVICE: 'service-inline', AE_SERVICE_LITERAL: serviceLiteral,
    AE_NATIVE: 'base-only-suffix',
    DEBUG: '1', APP_MODE: 'development', GREETING: 'hello', OTHER: 'inherited-readable',
  });
  assert.equal((await cli(['exec', 'auto', '--service', 'web', '--', 'printenv', 'AE_STORE'])).output, '[redacted]');
  assert.match((await cli(['logs', 'auto'])).output, /started 1 worker in development mode, build 2021/);
  assert.equal((await cli(['exec', 'auto', '--', 'echo', '1 + 1 = 2'])).output, '1 + 1 = 2');
  assert.equal((await cli(['exec', 'auto', '--', 'printenv', 'DB_PASSWORD'])).output, '[redacted]');
  for (const key of Object.keys(credentials)) assert.equal((await cli(['exec', 'auto', '--', 'printenv', key])).output, '[redacted]', `Redact ${key}.`);
  const failed = await invoke(['exec', 'auto', '--', 'sh', '-c', 'printf "application port 5173: %s" "$AE_STORE"; exit 7'], false);
  assert.equal(failed.code, 7);
  assert.match(failed.stderr + failed.stdout, /application port 5173: \[redacted\]/);
  assert.ok(!(failed.stderr + failed.stdout).includes(secret), 'Failed exec disclosed a private value.');
  await cli(['exec', 'auto', '--', 'sh', '-c', 'echo durable > /data/value']);
  await writeFile(join(cwd, '.env.review.local'), 'AE_FINAL=named-local-only\nDEBUG=0\nAPP_MODE=development\nGREETING: hello\nOTHER\nDB_PASSWORD=short-secret\n');
  await start('auto', ['--env', 'review', '--timeout', '120']);
  await expected('auto', { DEBUG: '0' });
  assert.equal((await cli(['exec', 'auto', '--', 'cat', '/data/value'])).output, 'durable');
  await cli(['down', 'auto']);
  await cli(['up', 'auto', '--timeout', '121']);
  assert.equal(JSON.parse(await readFile(join(test.home, 'state.json'), 'utf8')).instances.auto.spec.startupTimeoutSeconds, 121);
  assert.equal((await cli(['exec', 'auto', '--', 'cat', '/data/value'])).output, 'durable');
  const ignoredName = await invoke(['up', '--name', 'ignored', '--env', 'review', '--no-env-file'], false);
  assert.notEqual(ignoredName.code, 0);
  assert.match(ignoredName.stderr, /Environment review is not defined/);
  config.environments = { review: {} };
  await writeFile(join(cwd, 'agent-env.json'), JSON.stringify(config));
  await writeFile(join(cwd, 'explicit.env'), 'AE_EXPLICIT=explicit-first\nAE_FINAL=explicit-first\n');
  await writeFile(join(cwd, 'second.env'), 'AE_FINAL=explicit-second\n');
  await start('explicit', ['--env', 'review', '--env-file', 'explicit.env', '--env-file', 'second.env']);
  await expected('explicit', { AE_BASE: '', AE_LOCAL: '', AE_NAMED: '', AE_LITERAL: '', AE_EXPLICIT: 'explicit-first', AE_FINAL: 'explicit-second', AE_STORE: secret, AE_SHELL: 'shell-precedence', AE_TOP: 'top-config', AE_DECLARED: 'service-file', AE_NATIVE: 'fallback-suffix' });
  await start('disabled', ['--env', 'review', '--no-env-file']);
  await expected('disabled', { AE_BASE: '', AE_LOCAL: '', AE_NAMED: '', AE_FINAL: '', AE_STORE: secret, AE_SHELL: 'shell-precedence', AE_TOP: 'top-config', AE_DECLARED: 'service-file', AE_SERVICE_LITERAL: serviceLiteral });
  await writeFile(join(cwd, 'disabled.json'), JSON.stringify({ ...config, envFiles: [] }));
  await start('config-disabled', ['--config', 'disabled.json']);
  await expected('config-disabled', { AE_BASE: '', AE_FINAL: '', AE_DECLARED: 'service-file', AE_SERVICE: 'service-inline', AE_SHELL: 'shell-precedence', AE_TOP: 'top-config' });
  for (const marker of ['parser-executed', 'parser-executed-backtick', 'service-env-executed']) await assert.rejects(stat(join(cwd, marker)), { code: 'ENOENT' });
  assert.equal(await readFile(join(cwd, 'compose.yaml'), 'utf8'), compose);
  console.log('PASS: Compose native dotenv interpolation, named order, shell precedence, private/config overrides, declarations, explicit files, disabled discovery, and literal parsing.');
} finally {
  await test.cleanup();
}
