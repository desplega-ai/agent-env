import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, freePort, targetOptions } from './helpers.mjs';

const test = await fixture('dotenv', { AGENT_ENV_E2E_STORE_INPUT: 'dotenv-store-private-$-literal' });
const { cwd, directory, cli, invoke } = test;
const port = await freePort();
const literal = '$(touch parser-executed) `touch parser-executed-backtick` $NO_EXPANSION';
const credentials = { ENCRYPTION_KEY: 'encryption-fixture', SIGNING_KEY: 'signing-fixture', LICENSE_KEY: 'license-fixture', SESSION_SALT: 'salt-fixture', OPAQUE_STRIPE: 'sk_live_fixture', OPAQUE_SLACK: 'xoxb-fixture', OPAQUE_GITLAB: 'glpat-fixture', OPAQUE_AWS: 'AKIAABCDEFGHIJKLMNOP' };
const credentialFile = Object.entries(credentials).map(([key, value]) => `${key}=${value}\n`).join('');
const digest = value => createHash('sha256').update(value).digest('hex');
const config = {
  env: { TOP: 'top-config', SERVICE: 'top-config', TOP_REF: { env: 'AGENT_ENV_E2E_STORE_INPUT' } },
  services: { web: {
    image: 'busybox:1.37', port, containerPort: 3000,
    command: 'echo "started 1 worker in development mode, build 2021"; exec httpd -f -p 3000 -h /workspace',
    volumes: { data: '/data' },
    env: { SERVICE: 'service-config' },
  } },
};
async function hash(name, key) {
  const result = await cli(['exec', name, '--service', 'web', '--', 'sh', '-c', 'printf "%s" "$(printenv "$1")" | sha256sum', 'sh', key]);
  return result.output.split(/\s+/)[0];
}
async function expected(name, values) {
  for (const [key, value] of Object.entries(values)) assert.equal(await hash(name, key), digest(value), `${name}: ${key} precedence differs.`);
}
async function start(name, args = [], options = {}) {
  await cli(['up', '--name', name, '--no-watch', ...targetOptions(), ...args], options);
}
try {
  await writeFile(join(cwd, 'agent-env.json'), JSON.stringify(config));
  await writeFile(join(cwd, 'index.html'), 'dotenv');
  await writeFile(join(cwd, '.env'), `BASE=base-only\nLOCAL=base\nNAMED=base\nFINAL=base\nSTORE=file\nMULTI='first\nsecond'\nQUOTED="quoted value" # comment\nEMPTY=\nTOP=file\nSERVICE=file\nLITERAL='${literal}'\n`);
  await writeFile(join(cwd, '.env.local'), 'LOCAL=local-only\nNAMED=local\nFINAL=local\n');
  await writeFile(join(cwd, '.env.review'), 'NAMED=named-only\nFINAL=named\n');
  await writeFile(join(cwd, '.env.review.local'), 'FINAL=named-local-only\nDEBUG=1\nAPP_MODE=development\nDB_PASSWORD=short-secret\n' + credentialFile);
  await cli(['env', 'set', 'STORE', '--env', 'review', '--from-env', 'AGENT_ENV_E2E_STORE_INPUT']);
  await cli(['env', 'set', 'TOP', '--env', 'review'], { input: 'private-top-store\n' });
  await cli(['env', 'set', 'SERVICE', '--env', 'review'], { input: 'private-service-store\n' });
  // The named dotenv file enables review without a named entry in agent-env.json.
  const before = await readFile(join(cwd, 'agent-env.json'), 'utf8');
  await start('auto', ['--env', 'review']);
  await expected('auto', { BASE: 'base-only', LOCAL: 'local-only', NAMED: 'named-only', FINAL: 'named-local-only', STORE: 'dotenv-store-private-$-literal', TOP: 'top-config', SERVICE: 'service-config', LITERAL: literal, MULTI: 'first\nsecond', QUOTED: 'quoted value', EMPTY: '', TOP_REF: 'dotenv-store-private-$-literal' });
  const listed = await cli(['list']);
  assert.equal(listed.find(item => item.name === 'auto').environment, 'review');
  const redacted = (await cli(['exec', 'auto', '--', 'printenv', 'STORE'])).output;
  assert.equal(redacted, '[redacted]');
  assert.match((await cli(['logs', 'auto'])).output, /started 1 worker in development mode, build 2021/);
  assert.equal((await cli(['exec', 'auto', '--', 'echo', '1 + 1 = 2'])).output, '1 + 1 = 2');
  assert.equal((await cli(['exec', 'auto', '--', 'printenv', 'DB_PASSWORD'])).output, '[redacted]');
  for (const key of Object.keys(credentials)) assert.equal((await cli(['exec', 'auto', '--', 'printenv', key])).output, '[redacted]', `Redact ${key}.`);
  const failed = await invoke(['exec', 'auto', '--', 'sh', '-c', 'printf "port 5173: %s" "$STORE"; printf " stderr: %s" "$TOP_REF" >&2; exit 7'], false);
  assert.equal(await readFile(join(cwd, 'agent-env.json'), 'utf8'), before);

  await cli(['exec', 'auto', '--', 'sh', '-c', 'echo durable > /data/value']);
  await writeFile(join(cwd, '.env.review.local'), 'FINAL=named-local-only\nDEBUG=0\nAPP_MODE=development\nDB_PASSWORD=short-secret\n');
  await start('auto', ['--env', 'review', '--timeout', '120']);
  await expected('auto', { DEBUG: '0' });
  assert.equal((await cli(['exec', 'auto', '--', 'cat', '/data/value'])).output, 'durable');
  await cli(['down', 'auto']);
  await cli(['up', 'auto', '--timeout', '121']);
  assert.equal(JSON.parse(await readFile(join(test.home, 'state.json'), 'utf8')).instances.auto.spec.startupTimeoutSeconds, 121);
  await expected('auto', { DEBUG: '0' });
  assert.equal((await cli(['exec', 'auto', '--', 'cat', '/data/value'])).output, 'durable');

  const ignoredName = await invoke(['up', '--name', 'ignored', '--env', 'review', '--no-env-file'], false);
  assert.notEqual(ignoredName.code, 0);
  assert.match(ignoredName.stderr, /Environment review is not defined/);
  config.environments = { review: {} };
  await writeFile(join(cwd, 'agent-env.json'), JSON.stringify(config));

  await writeFile(join(cwd, 'explicit.env'), 'EXPLICIT=first\nFINAL=explicit-first\n');
  await writeFile(join(cwd, 'second.env'), 'FINAL=explicit-second\n');
  await start('explicit', ['--env', 'review', '--env-file', 'explicit.env', '--env-file', 'second.env']);
  await expected('explicit', { BASE: '', LOCAL: '', NAMED: '', LITERAL: '', EXPLICIT: 'first', FINAL: 'explicit-second', STORE: 'dotenv-store-private-$-literal', TOP: 'top-config', SERVICE: 'service-config' });
  await start('disabled', ['--env', 'review', '--no-env-file']);
  await expected('disabled', { BASE: '', LOCAL: '', NAMED: '', FINAL: '', STORE: 'dotenv-store-private-$-literal', TOP: 'top-config', SERVICE: 'service-config' });
  const conflict = await invoke(['up', '--name', 'conflict', '--env-file', 'explicit.env', '--no-env-file'], false);
  assert.notEqual(conflict.code, 0);
  assert.match(conflict.stderr, /--env-file.*--no-env-file|--no-env-file.*--env-file/);
  await writeFile(join(cwd, 'disabled.json'), JSON.stringify({ ...config, envFiles: [] }));
  await start('config-disabled', ['--config', 'disabled.json']);
  await expected('config-disabled', { BASE: '', LOCAL: '', TOP: 'top-config', SERVICE: 'service-config' });
  await writeFile(join(cwd, 'configured.json'), JSON.stringify({ ...config, envFiles: ['explicit.env'] }));
  await start('config-file', ['--config', 'configured.json']);
  await expected('config-file', { BASE: '', EXPLICIT: 'first', FINAL: 'explicit-first' });
  await writeFile(join(cwd, 'overlay-file.json'), JSON.stringify({ ...config, envFiles: ['explicit.env'], environments: { review: { envFile: 'second.env' } } }));
  await start('overlay-file', ['--config', 'overlay-file.json', '--env', 'review']);
  await expected('overlay-file', { EXPLICIT: '', FINAL: 'explicit-second' });
  const missing = await invoke(['up', '--name', 'missing', '--env-file', 'absent.env'], false);
  assert.notEqual(missing.code, 0);
  assert.match(missing.stderr, /ENOENT|absent.env/);
  const undefinedName = await invoke(['up', '--name', 'undefined', '--env', 'not-defined'], false);
  assert.notEqual(undefinedName.code, 0);
  assert.match(undefinedName.stderr, /not defined/);
  for (const marker of ['parser-executed', 'parser-executed-backtick']) await assert.rejects(stat(join(cwd, marker)), { code: 'ENOENT' });

  // A project with no dotenv files still starts with a named overlay.
  const empty = join(directory, 'empty');
  await mkdir(empty);
  await writeFile(join(empty, 'agent-env.json'), JSON.stringify({ ...config, environments: { blank: {} } }));
  await start('empty', ['--env', 'blank'], { cwd: empty });
  await expected('empty', { BASE: '', TOP: 'top-config', SERVICE: 'service-config' });
  const bare = join(directory, 'bare');
  await mkdir(bare);
  await writeFile(join(bare, '.env.preview.local'), 'LOCAL_ONLY=named-file-only\n');
  const barePort = await freePort();
  await cli(['up', '--name', 'file-only', '--env', 'preview', '--port', String(barePort), '--image', 'busybox:1.37', '--no-watch', ...targetOptions(), '--', 'httpd', '-f', '-p', String(barePort), '-h', '/workspace'], { cwd: bare });
  await expected('file-only', { LOCAL_ONLY: 'named-file-only', BASE: '' });
  const defaultName = await cli(['up', '--no-watch', ...targetOptions()]);
  const reviewName = await cli(['up', '--env', 'review', '--no-watch', ...targetOptions()]);
  assert.notEqual(defaultName.name, reviewName.name);
  assert.equal(defaultName.environment, 'default');
  assert.equal(reviewName.environment, 'review');
  assert.equal(failed.code, 7);
  assert.match(failed.stderr + failed.stdout, /port 5173: \[redacted\]/);
  assert.ok(!(failed.stderr + failed.stdout).includes('dotenv-store-private-$-literal'), 'Failed exec disclosed a private value.');
  console.log('PASS: native dotenv discovery, order, named files, private/config overrides, explicit files, disabled discovery, missing files, literal parsing, and safe errors.');
} finally {
  await test.cleanup();
}
