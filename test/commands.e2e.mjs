import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, freePort, docker, until } from './helpers.mjs';

const test = await fixture('commands');
const { cwd, cli, invoke } = test;
const port = await freePort();
const secret = 'dummy-command-secret-24681357';
const commands = {
  install: ['sh', '-c', 'printf installed > /data/install'],
  migrate: { service: 'web', command: 'printf migrated > /data/migration' },
  seed: 'printf "%s" "$1" > /data/seed',
  test: ['sh', '-c', 'test -f /data/install && test -f /data/migration && cat /data/seed'],
  reset: 'rm -f /data/install /data/migration /data/seed',
  args: ['printf', '%s'],
  fail: 'printf stdout-proof; printf stderr-proof >&2; printf "$TOKEN"; exit 23',
  gated: ['sh', '-c', 'touch /data/active; while [ ! -f /data/release ]; do sleep 0.1; done; printf complete'],
};
try {
  await writeFile(join(cwd, 'agent-env.json'), JSON.stringify({ services: { web: { image: 'busybox:1.37', port, containerPort: 8080, command: 'httpd -f -p 8080', volumes: { data: '/data' } } }, commands }));
  await invoke(['env', 'set', 'TOKEN'], true, { input: secret });
  await cli(['up', '--name', 'project-commands']);
  const owner = JSON.parse(await readFile(join(test.home, 'state.json'), 'utf8')).owner;
  const containerQuery = ['ps', '-aq', '--filter', `name=^/agent-env-${owner}-project-commands-web$`, '--filter', `label=agent-env.owner=${owner}`];
  const before = await docker(containerQuery);
  assert.match(before, /^[a-f0-9]{12,64}$/, 'The test must identify exactly one owned container.');
  assert.deepEqual((await cli(['list']))[0].commands, Object.keys(commands));
  for (const operation of ['run', 'exec']) {
    await docker(['exec', before, 'rm', '-f', '/data/active', '/data/release']);
    const args = operation === 'run' ? ['run', 'project-commands', 'gated'] : ['exec', 'project-commands', '--', ...commands.gated];
    const pending = invoke(args, false);
    try {
      await until(() => docker(['exec', before, 'test', '-f', '/data/active']).then(() => true, () => false));
      for (const args of [['list'], ['logs', 'project-commands'], ['run', 'project-commands', 'args', '--', 'parallel']]) {
        const responsive = await invoke(args, false, { timeout: 5000 });
        assert.equal(responsive.code, 0, `${operation} blocked ${args[0]}.`);
      }
      await cli(['up', '--name', 'parallel-instance']);
      await cli(['rm', 'parallel-instance', '--purge']);
    } finally {
      await docker(['exec', before, 'touch', '/data/release']);
      const completed = await pending;
      assert.equal(completed.code, 0);
      assert.match(completed.stdout, /complete/);
    }
  }
  for (const command of ['install', 'migrate']) await cli(['run', 'project-commands', command]);
  await cli(['run', 'project-commands', 'seed', '--', 'literal $HOME; $(id)']);
  assert.equal((await cli(['run', 'project-commands', 'test'])).output, 'literal $HOME; $(id)');
  assert.equal((await cli(['run', 'project-commands', 'args', '--', 'literal $(id)'])).output, 'literal $(id)');
  const failure = await invoke(['run', 'project-commands', 'fail'], false);
  assert.equal(failure.code, 23);
  assert.match(failure.stderr, /stdout-proof/);
  assert.match(failure.stderr, /stderr-proof/);
  assert.ok(!failure.stderr.includes(secret));
  assert.match(failure.stderr, /\[redacted\]/);
  for (const args of [['run', 'project-commands'], ['run', 'project-commands', 'missing'], ['run', 'project-commands', 'test', '--service', 'missing']]) {
    assert.notEqual((await invoke(args, false)).code, 0);
  }
  const config = JSON.parse(await readFile(join(cwd, 'agent-env.json'), 'utf8'));
  config.commands.args = ['printf', 'changed'];
  await writeFile(join(cwd, 'agent-env.json'), JSON.stringify(config));
  await cli(['up', '--name', 'project-commands']);
  assert.equal(await docker(containerQuery), before);
  assert.equal((await cli(['run', 'project-commands', 'args'])).output, 'changed');
  await cli(['daemon', 'stop']);
  assert.equal((await cli(['run', 'project-commands', 'test'])).output, 'literal $HOME; $(id)');
  await cli(['run', 'project-commands', 'reset']);
  assert.notEqual((await invoke(['run', 'project-commands', 'test'], false)).code, 0);
  await cli(['down', 'project-commands']);
  assert.match((await invoke(['run', 'project-commands', 'install'], false)).stderr, /Start the instance/);
  await cli(['rm', 'project-commands', '--purge']);

  await writeFile(join(cwd, 'compose.yaml'), JSON.stringify({ services: { web: { image: 'busybox:1.37', command: ['httpd', '-f', '-p', '8080'], ports: [`${port}:8080`], volumes: ['data:/data'] } }, volumes: { data: {} } }));
  await writeFile(join(cwd, 'agent-env.json'), JSON.stringify({ provider: 'compose', commands, environments: { review: { commands: { args: ['printf', 'review-command'] } } } }));
  await cli(['up', '--name', 'compose-commands', '--env', 'review']);
  for (const command of ['install', 'migrate']) await cli(['run', 'compose-commands', command]);
  await cli(['run', 'compose-commands', 'seed', '--', 'compose-seed']);
  assert.equal((await cli(['run', 'compose-commands', 'test'])).output, 'compose-seed');
  assert.equal((await cli(['run', 'compose-commands', 'args'])).output, 'review-command');
  await cli(['rm', 'compose-commands', '--purge']);
  console.log('Project commands E2E passed: Docker, Compose, argument safety, secrets, failures, restart, and command reload.');
} finally { await test.cleanup(); }
