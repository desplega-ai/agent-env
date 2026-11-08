import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { listEnvironmentSecrets, loadEnvironment, parseEnvFile, readEnvironmentSecrets, redactEnvironment, resolveEnvironment, setEnvironmentSecret, unsetEnvironmentSecret } from '../src/environments.mjs';

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), 'dev-now-env-test-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, home: join(cwd, 'private'), environment: 'review' };
}
test('env parser treats shell syntax literally and supports quotes, comments, and multiline values', () => {
  const values = parseEnvFile(`export SIMPLE = plain # comment\nHASH=value#literal\nSINGLE='$(touch /tmp/never-execute)'\nDOUBLE="line\\nnext"\nMULTI='one\ntwo'\nEMPTY=\nSIMPLE=last\n`);
  assert.equal(values.SIMPLE, 'last');
  assert.equal(values.HASH, 'value#literal');
  assert.equal(values.SINGLE, '$(touch /tmp/never-execute)');
  assert.equal(values.DOUBLE, 'line\nnext');
  assert.equal(values.MULTI, 'one\ntwo');
  assert.equal(values.EMPTY, '');
  assert.throws(() => parseEnvFile('bad-key=value'), /line 1/);
  assert.throws(() => parseEnvFile('KEY="never closes'), /closing quote/);
  assert.throws(() => parseEnvFile('KEY="value" trailing'), /Invalid text/);
});
test('named environments merge services and references without mutating base configuration', () => {
  const base = { env: { BASE: 'base' }, services: { web: { image: 'node:22', port: 3000, env: { ONE: 'one' } } }, environments: { review: { env: { TWO: 'two' }, services: { web: { port: 4000, env: { THREE: 'three' } } } } } };
  const result = resolveEnvironment(base, 'review');
  assert.equal(result.services.web.image, 'node:22');
  assert.equal(result.services.web.port, 4000);
  assert.equal(result.services.web.env.ONE, 'one');
  assert.equal(base.services.web.port, 3000);
  assert.equal(result.environments, undefined);
  assert.throws(() => resolveEnvironment(base, 'missing'), /not defined/);
});
test('private store separates projects and environments, exposes names only, and uses mode 0600', async t => {
  const options = await fixture(t);
  await setEnvironmentSecret({ ...options, key: 'TOKEN', stdin: Readable.from(['sensitive-test-value\n']) });
  assert.deepEqual(await listEnvironmentSecrets(options), ['TOKEN']);
  assert.ok((await readEnvironmentSecrets(options)).TOKEN === 'sensitive-test-value');
  assert.deepEqual(await listEnvironmentSecrets({ ...options, environment: 'default' }), []);
  const second = await fixture(t);
  assert.deepEqual(await listEnvironmentSecrets({ ...second, home: options.home }), []);
  const project = (await readdir(join(options.home, 'secrets')))[0];
  assert.equal((await stat(join(options.home, 'secrets', project, 'review.json'))).mode & 0o777, 0o600);
  await setEnvironmentSecret({ ...options, key: 'OTHER', fromEnv: 'SOURCE', env: { SOURCE: 'another-test-value' } });
  assert.deepEqual(await listEnvironmentSecrets(options), ['OTHER', 'TOKEN']);
  assert.equal(await unsetEnvironmentSecret({ ...options, key: 'TOKEN' }), true);
  assert.equal(await unsetEnvironmentSecret({ ...options, key: 'TOKEN' }), false);
  await assert.rejects(setEnvironmentSecret({ ...options, key: 'TOKEN', value: 'literal' }), /stdin/);
  await assert.rejects(setEnvironmentSecret({ ...options, key: 'TOKEN', fromEnv: 'MISSING', env: {} }), /not defined/);
});
test('environment files, private variables, and explicit references have deterministic precedence', async t => {
  const options = await fixture(t);
  await writeFile(join(options.cwd, '.env.first'), 'VALUE=first\nOTHER=original\n');
  await writeFile(join(options.cwd, '.env.second'), 'VALUE=second\n');
  await setEnvironmentSecret({ ...options, key: 'TOKEN', fromEnv: 'SOURCE', env: { SOURCE: 'private-test-value' } });
  const values = await loadEnvironment({ ...options, files: ['.env.first', '.env.second'], values: { ALIAS: { secret: 'TOKEN' }, PROCESS: { env: 'SOURCE' } }, env: { SOURCE: 'process-test-value' } });
  assert.equal(values.VALUE, 'second');
  assert.equal(values.OTHER, 'original');
  assert.ok(values.ALIAS === values.TOKEN);
  assert.ok(values.PROCESS === 'process-test-value');
  await assert.rejects(loadEnvironment({ ...options, values: { TOKEN: { secret: 'MISSING' } } }), /not set/);
});
test('redaction protects literal values and keeps its replacement text intact', () => {
  assert.equal(redactEnvironment('abc a red $(command)', ['abc', 'red', 'a', '$(command)']), '[redacted] [redacted] [redacted] [redacted]');
  assert.equal(redactEnvironment('ordinary text', {}), 'ordinary text');
});
