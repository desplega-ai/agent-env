import assert from 'node:assert/strict';
import { chmod, lstat, mkdir, readFile, rename, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture } from './helpers.mjs';

assert.ok(process.env.AGENT_ENV_CLI, 'Storage tests require an installed CLI.');
const test = await fixture('storage');
const { cli, invoke, cwd, home, directory } = test;
const configFile = join(cwd, 'agent-env.json');
const original = { name: 'preserved', env: { KEEP: 'literal' }, commands: { test: 'echo test' }, custom: { nested: [1, 2] } };
async function fails(args, pattern, options) {
  const result = await invoke(args, false, options);
  assert.notEqual(result.code, 0, result.stdout);
  assert.match(result.stderr, pattern);
  return result;
}
try {
  await fails(['storage', 'add', 'archive', '--project', '--provider', 'local', '--root', directory], /Run agent-env init/);
  await assert.rejects(lstat(configFile), { code: 'ENOENT' });
  await cli(['init', '--', 'node', 'server.js']);
  await writeFile(configFile, JSON.stringify(original));
  await chmod(configFile, 0o660);
  const linkedConfig = join(cwd, 'actual-config.json');
  await rename(configFile, linkedConfig);
  await symlink('actual-config.json', configFile);
  assert.deepEqual(await cli(['storage', 'list']), []);
  assert.match((await invoke(['storage', 'list'])).stdout, /No storage profiles/);
  await cli(['storage', 'add', 'archive', '--provider', 's3', '--bucket', 'user-bucket', '--endpoint', 'https://s3.example.test', '--access-key-env', 'TEST_STORAGE_ACCESS', '--secret-key-env', 'TEST_STORAGE_SECRET', '--session-token-env', 'TEST_STORAGE_TOKEN']);
  const saved = JSON.parse(await readFile(join(home, 'storage.json')));
  assert.equal(saved.archive.accessKeyEnv, 'TEST_STORAGE_ACCESS');
  assert.equal(saved.archive.sessionTokenEnv, 'TEST_STORAGE_TOKEN');
  assert.equal((await stat(home)).mode & 0o777, 0o700);
  assert.equal((await stat(join(home, 'storage.json'))).mode & 0o777, 0o600);
  const listed = await cli(['storage', 'list']);
  assert.equal(listed[0].source, 'user');
  assert.equal(listed[0].bucket, 'user-bucket');
  assert.deepEqual(await cli(['storage', 'list', '--project']), []);
  await fails(['storage', 'check', 'archive', '--project'], /does not exist/);
  assert.ok(!JSON.stringify(listed).includes('TEST_STORAGE_'));
  const plain = await invoke(['storage', 'list']);
  assert.match(plain.stdout, /archive \(user, s3\): s3:\/\/user-bucket\//);
  assert.ok(!plain.stdout.includes('TEST_STORAGE_'));
  await fails(['storage', 'add', 'archive', '--provider', 's3', '--bucket', 'new-bucket'], /already exists/);
  await cli(['storage', 'add', 'archive', '--project', '--provider', 'local', '--root', join(directory, 'local')]);
  assert.deepEqual((await cli(['storage', 'list']))[0], { name: 'archive', source: 'project', provider: 'local', root: join(directory, 'local') });
  assert.equal((await cli(['storage', 'list', '--project']))[0].source, 'project');
  await fails(['storage', 'check', 'archive', '--project'], /S3 profile/);
  assert.match((await invoke(['storage', 'list'])).stdout, /archive \(project, local\)/);
  const project = JSON.parse(await readFile(configFile));
  const { storage, ...unrelated } = project;
  assert.deepEqual(unrelated, original);
  await fails(['snapshot', 'missing', 'storage://archive/one', '--endpoint', 'https://s3.example.test'], /conflicts/);
  await cli(['storage', 'remove', 'archive', '--project']);
  assert.equal((await lstat(configFile)).isSymbolicLink(), true);
  assert.equal((await stat(configFile)).mode & 0o777, 0o660);
  assert.equal((await cli(['storage', 'list']))[0].source, 'user');
  await fails(['storage', 'check', 'archive'], /TEST_STORAGE_ACCESS.*not defined/);
  await fails(['snapshot', 'missing', 'storage://archive/test'], /TEST_STORAGE_ACCESS.*not defined/);
  await cli(['storage', 'remove', 'archive']);
  assert.deepEqual(await cli(['storage', 'list']), []);
  await fails(['storage', 'remove', 'archive'], /does not exist/);
  await fails(['storage', 'check', 'constructor'], /does not exist/);
  for (const name of ['../escape', 'Upper', 'a/b', 'a@b', '']) await fails(['storage', 'add', name, '--provider', 'local', '--root', directory], /storage name/);
  for (const args of [
    ['--provider', 'files', '--bucket', 'test'],
    ['--provider', 'local', '--root', 'relative'],
    ['--provider', 'local', '--root', `${directory}/../escape`],
    ['--provider', 'local', '--root', directory, '--bucket', 'test'],
    ['--provider', 's3'],
    ['--provider', 's3', '--bucket', 'a@b'],
    ['--provider', 's3', '--bucket', 'test', '--access-key-env', 'ONLY_ACCESS'],
    ['--provider', 's3', '--bucket', 'test', '--session-token-env', 'ONLY_TOKEN'],
    ['--provider', 's3', '--bucket', 'test', '--access-key-env', 'not-a-variable', '--secret-key-env', 'SECRET'],
    ['--provider', 's3', '--bucket', 'test', '--addressing-style', 'invalid'],
    ['--provider', 's3', '--bucket', 'test', '--ca-bundle', 'relative.pem'],
    ['--provider', 's3', '--bucket', 'test', '--prefix', 'a/../b'],
    ['--provider', 's3', '--bucket', 'test', '--endpoint', 'http://user:private-value@localhost'],
    ['--provider', 's3', '--bucket', 'test', '--endpoint', 'http://localhost?token=private-value'],
  ]) {
    const result = await invoke(['storage', 'add', 'invalid', ...args], false);
    assert.notEqual(result.code, 0);
    assert.ok(!result.stderr.includes('private-value'));
  }
  await fails(['storage', 'add', 'invalid', '--provider', 's3', '--bucket', 'test', '--access-key', 'private-value'], /Unknown option/);
  for (const location of ['storage://missing', 'storage://missing/', 'storage://Upper/test', 'storage://missing/../test', 'storage://missing/a/%2e%2e/b', 'storage://missing/a//b', 'storage://user:private-value@host/test', 's3://user:private-value@host/test', 'https://user:private-value@host/test']) {
    const result = await invoke(['snapshot', 'missing', location], false);
    assert.notEqual(result.code, 0);
    assert.ok(!result.stderr.includes('private-value'));
  }
  for (const storage of [{ invalid: { provider: 's3', bucket: 'test', secretKey: 'private-value' } }, { invalid: { provider: 's3', bucket: 'test', unknown: 'private-value' } }, null, []]) {
    await writeFile(configFile, JSON.stringify({ ...original, storage }));
    const result = await fails(['storage', 'list'], /unknown field|map/);
    assert.ok(!result.stderr.includes('private-value'));
  }
  await writeFile(configFile, '{"storage":');
  await fails(['storage', 'list'], /JSON structure/);
  await writeFile(configFile, JSON.stringify(original));
  await writeFile(join(home, 'storage.json'), '{"secret":"private-value"');
  const malformed = await fails(['storage', 'list'], /JSON structure/);
  assert.ok(!malformed.stderr.includes('private-value'));
  await writeFile(join(home, 'storage.json'), '{}');
  await mkdir(join(directory, 'root'));
  await cli(['storage', 'add', 'disk', '--provider', 'local', '--root', join(directory, 'root')]);
  await fails(['storage', 'check', 'disk'], /S3 profile/);
  console.log('PASS: installed CLI storage CRUD, source precedence, private permissions, configuration validation, and missing references.');
} finally { await test.cleanup(); }
